const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSessionProxyHandler,
  mergeGatewayCapabilities,
  resolveSessionProxyRoute,
} = require("../routes/converterGateway");
const { internalHeaders } = require("../services/converterGatewayService");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
    send(body) {
      this.body = body;
      return body;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

test("session gateway composes sync and recovery onto canonical FastAPI paths", () => {
  assert.deepEqual(
    resolveSessionProxyRoute({ method: "POST", suffix: "" }),
    {
      method: "POST",
      path: "/api/v1/mappings/session",
      requiresIdempotencyKey: false,
    },
  );
  assert.deepEqual(
    resolveSessionProxyRoute({ method: "GET", sessionId: "session-1", suffix: "" }),
    {
      method: "GET",
      path: "/api/v1/sessions/session-1/revisions",
      requiresIdempotencyKey: false,
    },
  );
});

test("session proxy forwards Idempotency-Key only for mutation routes that require it", async () => {
  const calls = [];
  let contextCalls = 0;
  const handler = createSessionProxyHandler({
    forward: async (input) => {
      calls.push(input);
      return { status: 200, data: { ok: true } };
    },
    contextForRequest: () => {
      contextCalls += 1;
      return "signed-context";
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      params: { id: "session-1", 0: "corrections/apply" },
      headers: { "idempotency-key": "idem-1" },
      body: { revision: 1 },
      query: {},
      requestId: "request-1",
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(contextCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/v1/sessions/session-1/corrections/apply");
  assert.deepEqual(calls[0].extraHeaders, { "idempotency-key": "idem-1" });
});

test("session proxy rejects missing idempotency before context creation or forwarding", async () => {
  let contextCalls = 0;
  let forwardCalls = 0;
  const handler = createSessionProxyHandler({
    forward: async () => {
      forwardCalls += 1;
    },
    contextForRequest: () => {
      contextCalls += 1;
      return "signed-context";
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      params: { id: "session-1", 0: "corrections/undo" },
      headers: {},
      body: {},
      query: {},
      requestId: "request-1",
    },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /Idempotency-Key/);
  assert.equal(contextCalls, 0);
  assert.equal(forwardCalls, 0);
});

test("session proxy rejects path traversal and namespace escape before trusted context injection", async () => {
  for (const suffix of [
    "../templates",
    "%2e%2e/templates",
    "%252e%252e%252ftemplates",
    "corrections\\apply",
    "corrections//apply",
    "/api/v1/templates",
  ]) {
    let contextCalls = 0;
    let forwardCalls = 0;
    const handler = createSessionProxyHandler({
      forward: async () => {
        forwardCalls += 1;
      },
      contextForRequest: () => {
        contextCalls += 1;
        return "signed-context";
      },
    });
    const response = responseRecorder();

    await handler(
      {
        method: "GET",
        params: { id: "session-1", 0: suffix },
        headers: {},
        body: {},
        query: {},
        requestId: "request-1",
      },
      response,
    );

    assert.equal(response.statusCode, 404, suffix);
    assert.equal(contextCalls, 0, suffix);
    assert.equal(forwardCalls, 0, suffix);
  }
});

test("internal gateway headers use an explicit trusted forwarding allowlist", () => {
  const previous = process.env.CONVERTER_SERVICE_TOKEN;
  process.env.CONVERTER_SERVICE_TOKEN = "s".repeat(32);
  try {
    const headers = internalHeaders({
      contextToken: "signed-context",
      requestId: "request-1",
      extraHeaders: {
        "Idempotency-Key": "idem-1",
        "X-Student-Context": "student-context",
        "X-Reconstruction-Context": "reconstruction-context",
        "X-Untrusted-Context": "must-not-pass",
      },
    });
    assert.equal(headers["idempotency-key"], "idem-1");
    assert.equal(headers["x-student-context"], "student-context");
    assert.equal(headers["x-reconstruction-context"], "reconstruction-context");
    assert.equal(headers["x-untrusted-context"], undefined);
  } finally {
    if (previous === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previous;
  }
});

test("disabled gateway capabilities advertise no service or feature availability", () => {
  const payload = mergeGatewayCapabilities(
    { status: "OK", capabilities: { anomaly_detection: true } },
    { MISA_IMPORT_REPAIR_ENABLED: "true", STUDENT_ASSISTANT_ENABLED: "true" },
    { mapping_profile_v2: true, anomaly_detection: true },
    { gatewayAvailable: false },
  );

  assert.equal(payload.status, "unavailable");
  assert.equal(payload.available, false);
  assert.equal(payload.gateway, false);
  assert.equal(payload.misa_import_repair.enabled, false);
  assert.equal(payload.capabilities.mapping_profile_v2, false);
  assert.equal(payload.capabilities.anomaly_detection, false);
  assert.equal(payload.capabilities.studentAssistant, false);
});
