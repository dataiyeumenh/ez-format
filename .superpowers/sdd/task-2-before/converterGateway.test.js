const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const test = require("node:test");

const User = require("../models/User");

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function routeByPath(router, path, method) {
  return router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

test("unauthenticated analyze returns 401", async () => {
  const { router } = require("../routes/converterGateway");
  const layer = routeByPath(router, "/uploads/analyze", "post");
  assert.ok(layer);
  const protect = layer.route.stack.find((item) => item.handle.name === "protect");
  assert.ok(protect);

  const response = responseRecorder();
  await protect.handle({ headers: {} }, response, () => {
    throw new Error("unauthenticated request reached controller");
  });
  assert.equal(response.statusCode, 401);
});

test("inactive user returns 403", async () => {
  const { router } = require("../routes/converterGateway");
  const layer = routeByPath(router, "/uploads/analyze", "post");
  const protect = layer.route.stack.find((item) => item.handle.name === "protect");
  const previousSecret = process.env.JWT_SECRET;
  const previousFindById = User.findById;
  process.env.JWT_SECRET = "gateway-auth-test-secret";
  User.findById = () => ({
    populate: async () => ({ isActive: false }),
  });

  try {
    const response = responseRecorder();
    const token = jwt.sign({ id: "user-inactive" }, process.env.JWT_SECRET);
    await protect.handle(
      { headers: { authorization: `Bearer ${token}` } },
      response,
      () => {
        throw new Error("inactive user reached controller");
      },
    );
    assert.equal(response.statusCode, 403);
  } finally {
    User.findById = previousFindById;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test("gateway forwards service token and request id", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((req, res) => {
    assert.equal(req.headers["x-converter-service-token"], "service-secret");
    assert.equal(req.headers["x-request-id"], "request-123");
    assert.equal(req.headers["x-conversion-context"], "context-token");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/preview",
      method: "POST",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-123",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter 422 is returned without losing readiness payload", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ summary: { blocker: 1 }, issues: [{ code: "required" }] }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/readiness",
      method: "POST",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-422",
    });
    assert.equal(result.status, 422);
    assert.deepEqual(result.data, {
      summary: { blocker: 1 },
      issues: [{ code: "required" }],
    });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter 4xx JSON strips internal fields before forwarding", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      summary: { blocker: 1 },
      issues: [{
        code: "required",
        expected: "1111",
        actual: "1121",
        source_url: "https://example.test/rules/1111",
        detail:
          "internal token=do-not-leak secret=secret-value password=pw authorization=Bearer bearer-value api-key=api-value",
        input: { password: "do-not-leak" },
        authorization: "Bearer header-value",
        api_key: "api-key-value",
        "X-Conversion-Context": "conversion-context-value",
        "X-Student-Context": "student-context-value",
        "X-Reconstruction-Context": "reconstruction-context-value",
        "X-Converter-Service-Token": "converter-service-value",
        AUTHORIZATION: "Bearer uppercase-value",
      }],
      secret: "internal-secret",
      traceback: "internal stack",
    }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/readiness",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-sanitized-422",
    });
    assert.equal(result.status, 422);
    assert.deepEqual(result.data, {
      summary: { blocker: 1 },
      issues: [{
        code: "required",
        expected: "1111",
        actual: "1121",
        source_url: "https://example.test/rules/1111",
        detail:
          "internal token=[REDACTED] secret=[REDACTED] password=[REDACTED] authorization=[REDACTED] api-key=[REDACTED]",
        input: "[REDACTED]",
        authorization: "[REDACTED]",
        api_key: "[REDACTED]",
        "X-Conversion-Context": "[REDACTED]",
        "X-Student-Context": "[REDACTED]",
        "X-Reconstruction-Context": "[REDACTED]",
        "X-Converter-Service-Token": "[REDACTED]",
        AUTHORIZATION: "[REDACTED]",
      }],
      secret: "[REDACTED]",
      traceback: "[REDACTED]",
    });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter 5xx preserves status and safe Retry-After while sanitizing body", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Retry-After", "17");
    res.setHeader("X-Internal-Secret", "do-not-forward");
    res.end(JSON.stringify({
      detail: "database password=secret",
      expected: "available",
      actual: "unavailable",
      stack: "internal stack",
      "X-Conversion-Context": "conversion-context-value",
      "X-Student-Context": "student-context-value",
      "X-Reconstruction-Context": "reconstruction-context-value",
      "X-Converter-Service-Token": "converter-service-value",
      AUTHORIZATION: "Bearer uppercase-value",
    }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/preview",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-503",
    });
    assert.equal(result.status, 503);
    assert.equal(result.headers["retry-after"], "17");
    assert.equal(result.headers["x-internal-secret"], undefined);
    assert.deepEqual(result.data, {
      detail: "database password=[REDACTED]",
      expected: "available",
      actual: "unavailable",
      stack: "[REDACTED]",
      "X-Conversion-Context": "[REDACTED]",
      "X-Student-Context": "[REDACTED]",
      "X-Reconstruction-Context": "[REDACTED]",
      "X-Converter-Service-Token": "[REDACTED]",
      AUTHORIZATION: "[REDACTED]",
    });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter non-JSON error preserves status without exposing body", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    res.end("internal token=do-not-leak");
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/preview",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-non-json",
    });
    assert.equal(result.status, 400);
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(JSON.stringify(result.data).includes("do-not-leak"), false);
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter timeout covers response body consumption", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousTimeout = process.env.CONVERTER_TIMEOUT_MS;
  const received = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"partial":');
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERTER_TIMEOUT_MS = "50";

  try {
    await assert.rejects(
      forwardJson({
        path: "/api/v1/mappings/preview",
        body: { upload_id: "upload-1" },
        contextToken: "context-token",
        requestId: "request-body-timeout",
      }),
      (error) => error.statusCode === 504,
    );
  } finally {
    received.server.closeAllConnections?.();
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
    if (previousTimeout === undefined) delete process.env.CONVERTER_TIMEOUT_MS;
    else process.env.CONVERTER_TIMEOUT_MS = previousTimeout;
  }
});

test("upstream JSON sanitizer caps reflected depth and payload size", () => {
  const { sanitizeUpstreamJson } = require("../services/converterGatewayService");
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 30; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const sanitized = sanitizeUpstreamJson({
    deep,
    items: Array.from({ length: 500 }, () => "x".repeat(5000)),
  });
  const serialized = JSON.stringify(sanitized);
  assert.ok(sanitized.items.length <= 100);
  assert.ok(serialized.length <= 70000);
  assert.match(serialized, /\[TRUNCATED\]/);
});

test("oversized upstream error JSON keeps status but uses a bounded generic payload", async () => {
  const { forwardJson } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ detail: "x".repeat(200000) }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardJson({
      path: "/api/v1/mappings/readiness",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-oversized-error",
    });
    assert.equal(result.status, 422);
    assert.deepEqual(result.data, {
      success: false,
      message: "Converter trả về phản hồi quá lớn",
    });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("converter binary export preserves Content-Disposition", async () => {
  const { forwardBinary } = require("../services/converterGatewayService");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const received = await listen((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", 'attachment; filename="Import MISA.xls"');
    res.end(Buffer.from("xls-output"));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const result = await forwardBinary({
      path: "/api/v1/conversions/export",
      body: { upload_id: "upload-1" },
      contextToken: "context-token",
      requestId: "request-export",
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-disposition"], 'attachment; filename="Import MISA.xls"');
    assert.equal(result.data.toString(), "xls-output");
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("client cannot supply arbitrary user id or owner scope", () => {
  const { sanitizeGatewayBody } = require("../controllers/converterGatewayController");
  const sanitized = sanitizeGatewayBody(
    {
      upload_id: "upload-1",
      userId: "attacker",
      user_id: "attacker",
      ownerScope: "workspace:attacker",
      owner_scope: "workspace:attacker",
      workspaceId: "attacker-workspace",
      plan: "monthly",
    },
    { userId: "user-1", ownerScope: "user:user-1", workspaceId: null },
  );
  assert.equal(sanitized.userId, undefined);
  assert.equal(sanitized.user_id, undefined);
  assert.equal(sanitized.ownerScope, undefined);
  assert.equal(sanitized.owner_scope, undefined);
  assert.equal(sanitized.workspaceId, undefined);
  assert.equal(sanitized.plan, undefined);
});

test("export controller never forwards client rows", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const userId = "export-rows-user";
  const received = await listen(async (req, res) => {
    const body = JSON.parse(await new Promise((resolve, reject) => {
      let value = "";
      req.on("data", (chunk) => { value += chunk; });
      req.on("end", () => resolve(value));
      req.on("error", reject);
    }));
    assert.equal(body.profile_id, "profile-1");
    assert.equal(body.rows, undefined);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "export-rows-context-secret";

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId: null,
      snapshotSetHash: null,
      snapshotIds: [],
    });
    const response = responseRecorder();
    await exportConversion(
      {
        requestId: "export-rows-request",
        user: { _id: userId },
        headers: { "x-conversion-context": contextToken },
        body: {
          profile_id: "profile-1",
          rows: [{ account: "1111" }],
        },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true });
  } finally {
    received.server.close();
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("gateway context binds authenticated ownership and conversion identifiers", () => {
  const { signGatewayContext } = require("../controllers/converterGatewayController");
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERSION_CONTEXT_SECRET = "gateway-context-secret";
  try {
    const token = signGatewayContext(
      {
        claims: { snapshot_set_hash: null, snapshot_ids: [] },
        userId: "user-1",
        ownerScope: "user:user-1",
        workspaceId: null,
      },
      {
        targetTemplateId: "bsn_sales",
        uploadId: "upload-1",
        conversionRunId: "run-1",
        operationSessionId: "session-1",
        scopes: ["export"],
      },
    );
    const claims = jwt.verify(token, process.env.CONVERSION_CONTEXT_SECRET);
    assert.equal(claims.user_id, "user-1");
    assert.equal(claims.owner_scope, "user:user-1");
    assert.equal(claims.workspace_id, null);
    assert.equal(claims.target_template_id, "bsn_sales");
    assert.equal(claims.upload_id, "upload-1");
    assert.equal(claims.conversion_run_id, "run-1");
    assert.equal(claims.operation_session_id, "session-1");
    assert.deepEqual(claims.scopes, ["export"]);
    assert.equal(claims.plan, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("conversion run lookup is bound to the trusted workspace scope", async () => {
  const {
    createConversionContextToken,
  } = require("../services/conversionContextService");
  const AccountingWorkspace = require("../models/AccountingWorkspace");
  const ConversionRun = require("../models/ConversionRun");
  const { readinessMapping } = require("../controllers/converterGatewayController");
  const previousWorkspaceFindOne = AccountingWorkspace.findOne;
  const previousRunFindOne = ConversionRun.findOne;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const otherWorkspaceId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  let runFilter;
  const received = await listen((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
  });
  process.env.CONVERSION_CONTEXT_SECRET = "gateway-workspace-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  AccountingWorkspace.findOne = async () => ({
    _id: workspaceId,
    owner: userId,
    members: [],
    isActive: true,
  });
  ConversionRun.findOne = async (filter) => {
    runFilter = filter;
    if (Object.hasOwn(filter, "workspace")) return null;
    return {
      _id: runId,
      user: userId,
      workspace: otherWorkspaceId,
      converterUploadId: "upload-other-workspace",
      targetTemplateId: "bsn_sales",
    };
  };

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId,
      snapshotSetHash: null,
    });
    const response = responseRecorder();
    await readinessMapping(
      {
        body: { conversion_run_id: String(runId), rows: [{ account: "1111" }] },
        headers: { "x-conversion-context": contextToken },
        requestId: "workspace-bound-run",
        user: { _id: userId },
      },
      response,
    );
    assert.equal(response.statusCode, 404);
    assert.equal(String(runFilter.workspace), String(workspaceId));
  } finally {
    received.server.close();
    AccountingWorkspace.findOne = previousWorkspaceFindOne;
    ConversionRun.findOne = previousRunFindOne;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

for (const missing of ["service token", "conversion context", "request id"]) {
  test(`converter client fails closed without ${missing}`, async () => {
    const { parseMasterDataFile } = require("../services/converterClient");
    const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
    const previousFetch = global.fetch;
    let fetchCalls = 0;
    process.env.CONVERTER_SERVICE_TOKEN =
      missing === "service token" ? "" : "service-secret";
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    };

    try {
      await assert.rejects(
        parseMasterDataFile({
          file: {
            buffer: Buffer.from("xlsx"),
            mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            originalname: "catalog.xlsx",
          },
          catalogType: "supplier",
          contextToken: missing === "conversion context" ? "" : "signed-context",
          requestId: missing === "request id" ? "" : "request-master-data",
        }),
        new RegExp(missing, "i"),
      );
      assert.equal(fetchCalls, 0);
    } finally {
      global.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
      else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
    }
  });
}

test("master-data import signs trusted workspace context and passes request id", async () => {
  const AccountingWorkspace = require("../models/AccountingWorkspace");
  const MasterDataEntry = require("../models/MasterDataEntry");
  const MasterDataSnapshot = require("../models/MasterDataSnapshot");
  const converterClient = require("../services/converterClient");
  const {
    verifyConversionContextToken,
  } = require("../services/conversionContextService");
  const controllerPath = require.resolve("../controllers/accountingWorkspaceController");
  const previousWorkspaceFindOne = AccountingWorkspace.findOne;
  const previousSnapshotFindOne = MasterDataSnapshot.findOne;
  const previousSnapshotFind = MasterDataSnapshot.find;
  const previousSnapshotCreate = MasterDataSnapshot.create;
  const previousDeleteMany = MasterDataEntry.deleteMany;
  const previousParse = converterClient.parseMasterDataFile;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const snapshotId = new mongoose.Types.ObjectId();
  const workspace = {
    _id: workspaceId,
    owner: userId,
    members: [],
    isActive: true,
    activeSnapshots: [],
    masterDataRevision: 7,
  };
  const snapshot = {
    _id: snapshotId,
    status: "processing",
    errorMessage: "",
    save: async () => snapshot,
  };
  let converterRequest;
  process.env.CONVERSION_CONTEXT_SECRET = "master-data-context-secret";
  AccountingWorkspace.findOne = async () => workspace;
  MasterDataSnapshot.findOne = async () => null;
  MasterDataSnapshot.find = async () => [];
  MasterDataSnapshot.create = async () => snapshot;
  MasterDataEntry.deleteMany = async () => ({ deletedCount: 0 });
  converterClient.parseMasterDataFile = async (request) => {
    converterRequest = request;
    throw new Error("stop after request capture");
  };
  delete require.cache[controllerPath];

  try {
    const { importMasterData } = require(controllerPath);
    const response = responseRecorder();
    await importMasterData(
      {
        body: {
          type: "supplier",
          contextToken: "browser-controlled-context",
        },
        file: {
          buffer: Buffer.from("xlsx"),
          mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          originalname: "suppliers.xlsx",
          size: 4,
        },
        headers: { "x-conversion-context": "browser-header-context" },
        params: { id: String(workspaceId) },
        requestId: "request-master-data-import",
        user: { _id: userId },
      },
      response,
    );

    assert.equal(converterRequest.requestId, "request-master-data-import");
    assert.notEqual(converterRequest.contextToken, "browser-controlled-context");
    assert.notEqual(converterRequest.contextToken, "browser-header-context");
    const claims = verifyConversionContextToken(converterRequest.contextToken);
    assert.equal(claims.user_id, String(userId));
    assert.equal(claims.workspace_id, String(workspaceId));
    assert.equal(claims.owner_scope, `workspace:${workspaceId}`);
  } finally {
    AccountingWorkspace.findOne = previousWorkspaceFindOne;
    MasterDataSnapshot.findOne = previousSnapshotFindOne;
    MasterDataSnapshot.find = previousSnapshotFind;
    MasterDataSnapshot.create = previousSnapshotCreate;
    MasterDataEntry.deleteMany = previousDeleteMany;
    converterClient.parseMasterDataFile = previousParse;
    delete require.cache[controllerPath];
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("student operation verifies context and forwards server-signed ownership", async () => {
  const StudentFileSession = require("../models/StudentFileSession");
  const {
    createStudentContextToken,
  } = require("../services/conversionContextService");
  const {
    proxyStudentOperation,
  } = require("../controllers/converterGatewayController");
  const previousFindOne = StudentFileSession.findOne;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const ownerScope = `user:${userId}`;
  let capturedRequest;
  const received = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      capturedRequest = {
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        headers: req.headers,
        method: req.method,
        url: req.url,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true }));
    });
  });
  process.env.CONVERSION_CONTEXT_SECRET = "student-forwarding-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  const studentToken = createStudentContextToken({
    sessionId,
    userId,
    ownerScope,
    allowedScopes: ["ask"],
    retentionExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  StudentFileSession.findOne = async () => ({
    _id: sessionId,
    userId,
    ownerScope,
    workspaceId: null,
    targetTemplateId: "bsn_sales",
    converterUploadId: "upload-student",
    retentionExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    status: "analyzed",
  });

  try {
    const response = responseRecorder();
    await proxyStudentOperation(
      {
        body: {
          context_token: studentToken,
          question: "Tài khoản nào phù hợp?",
          userId: "attacker",
        },
        headers: { "x-student-context": studentToken },
        params: { 0: "questions", id: String(sessionId) },
        path: `/sessions/${sessionId}/operations/questions`,
        requestId: "student-forward-request",
        user: { _id: userId },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(capturedRequest.method, "POST");
    assert.equal(capturedRequest.url, `/api/v1/student/sessions/${sessionId}/questions`);
    assert.equal(capturedRequest.headers["x-request-id"], "student-forward-request");
    assert.equal(capturedRequest.headers["x-student-context"], studentToken);
    assert.equal(capturedRequest.body.context_token, undefined);
    assert.equal(capturedRequest.body.userId, undefined);
    assert.equal(capturedRequest.body.question, "Tài khoản nào phù hợp?");
    const claims = jwt.verify(
      capturedRequest.headers["x-conversion-context"],
      process.env.CONVERSION_CONTEXT_SECRET,
    );
    assert.equal(claims.user_id, String(userId));
    assert.equal(claims.owner_scope, ownerScope);
    assert.equal(claims.operation_session_id, String(sessionId));
  } finally {
    received.server.close();
    StudentFileSession.findOne = previousFindOne;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("reconstruction operation verifies context and forwards run workspace", async () => {
  const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
  const {
    createReconstructionContextToken,
  } = require("../services/conversionContextService");
  const {
    proxyReconstructionOperation,
  } = require("../controllers/converterGatewayController");
  const previousFindOne = VoucherReconstructionRun.findOne;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousUrl = process.env.CONVERTER_INTERNAL_URL;
  const previousToken = process.env.CONVERTER_SERVICE_TOKEN;
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  const conversionRunId = new mongoose.Types.ObjectId();
  let capturedRequest;
  const received = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      capturedRequest = {
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        headers: req.headers,
        method: req.method,
        url: req.url,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true }));
    });
  });
  process.env.CONVERSION_CONTEXT_SECRET = "reconstruction-forwarding-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  const reconstructionToken = createReconstructionContextToken({
    userId,
    runId,
    workspaceId,
    scopes: ["review"],
  });
  VoucherReconstructionRun.findOne = async () => ({
    _id: runId,
    user: userId,
    workspace: workspaceId,
    targetTemplateId: "bsn_purchase",
    conversionRun: conversionRunId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    snapshotSetHash: "snapshot-hash",
    workspaceRevision: 3,
  });

  try {
    const response = responseRecorder();
    await proxyReconstructionOperation(
      {
        body: {
          context_token: reconstructionToken,
          decision: "approved",
          ownerScope: "workspace:attacker",
        },
        headers: {
          "x-reconstruction-context": reconstructionToken,
          "idempotency-key": "reconstruction-idempotency",
        },
        params: { 0: "review", id: String(runId) },
        path: `/reconstructions/${runId}/operations/review`,
        requestId: "reconstruction-forward-request",
        user: { _id: userId },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(capturedRequest.method, "POST");
    assert.equal(capturedRequest.url, `/api/v1/reconstructions/${runId}/review`);
    assert.equal(capturedRequest.headers["x-request-id"], "reconstruction-forward-request");
    assert.equal(capturedRequest.headers["x-reconstruction-context"], reconstructionToken);
    assert.equal(capturedRequest.headers["idempotency-key"], "reconstruction-idempotency");
    assert.equal(capturedRequest.body.context_token, undefined);
    assert.equal(capturedRequest.body.ownerScope, undefined);
    assert.equal(capturedRequest.body.decision, "approved");
    const claims = jwt.verify(
      capturedRequest.headers["x-conversion-context"],
      process.env.CONVERSION_CONTEXT_SECRET,
    );
    assert.equal(claims.user_id, String(userId));
    assert.equal(claims.owner_scope, `workspace:${workspaceId}`);
    assert.equal(claims.workspace_id, String(workspaceId));
    assert.equal(claims.conversion_run_id, String(conversionRunId));
  } finally {
    received.server.close();
    VoucherReconstructionRun.findOne = previousFindOne;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousToken;
  }
});

test("oversized multipart is rejected with 413 before controller forwarding", async () => {
  const express = require("express");
  const { boundedExcelUpload } = require("../routes/converterGateway");
  const previousLimit = process.env.CONVERTER_MAX_FILE_BYTES;
  process.env.CONVERTER_MAX_FILE_BYTES = "4";
  let forwarded = false;
  const uploadApp = express();
  uploadApp.post("/upload", boundedExcelUpload, (_req, res) => {
    forwarded = true;
    res.json({ success: true });
  });
  const received = await listen(uploadApp);

  try {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("12345")]), "oversized.xlsx");
    const response = await fetch(`${received.url}/upload`, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 413);
    assert.equal(forwarded, false);
  } finally {
    received.server.close();
    if (previousLimit === undefined) delete process.env.CONVERTER_MAX_FILE_BYTES;
    else process.env.CONVERTER_MAX_FILE_BYTES = previousLimit;
  }
});

test("unsupported multipart extension is rejected before controller forwarding", async () => {
  const express = require("express");
  const { boundedExcelUpload } = require("../routes/converterGateway");
  let forwarded = false;
  const uploadApp = express();
  uploadApp.post("/upload", boundedExcelUpload, (_req, res) => {
    forwarded = true;
    res.json({ success: true });
  });
  const received = await listen(uploadApp);

  try {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("valid-size")]), "payload.csv");
    const response = await fetch(`${received.url}/upload`, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 400);
    assert.equal(forwarded, false);
  } finally {
    received.server.close();
  }
});

test("rate-limit router resolves env override after router creation", async () => {
  const routePath = require.resolve("../routes/converterGateway");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousRouteModule = require.cache[routePath];
  const previousLimit = process.env.CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES;
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  delete process.env.CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES;
  delete require.cache[routePath];
  const { router } = require(routePath);
  process.env.CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES = "1";
  ConverterRateLimitBucket.findOneAndUpdate = async () => ({ count: 2 });

  try {
    const layer = routeByPath(router, "/uploads/analyze", "post");
    const rateLimit = layer.route.stack.find(
      (item) => item.handle.name === "converterRateLimitMiddleware",
    );
    const response = responseRecorder();
    await rateLimit.handle(
      { user: { _id: "lazy-env-user" } },
      response,
      () => {
        throw new Error("configured rate limit was not applied");
      },
    );
    assert.equal(response.statusCode, 429);
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    if (previousLimit === undefined) delete process.env.CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES;
    else process.env.CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES = previousLimit;
  }
});

test("rate limiter uses one atomic upsert increment per bucket", async () => {
  const { consumeConverterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  const calls = [];
  ConverterRateLimitBucket.findOneAndUpdate = async (...args) => {
    calls.push(args);
    return { count: 2 };
  };

  try {
    const result = await consumeConverterRateLimit({
      userId: "user-1",
      operation: "analyze",
      limit: 1,
      windowMs: 600000,
      now: 600001,
    });
    assert.equal(result.allowed, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
      userId: "user-1",
      operation: "analyze",
      bucketStart: new Date(600000),
    });
    assert.deepEqual(calls[0][1], {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(1200000) },
    });
    assert.deepEqual(calls[0][2], {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("rate limiter retries an E11000 upsert race without another upsert", async () => {
  const { consumeConverterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  const calls = [];
  ConverterRateLimitBucket.findOneAndUpdate = async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(new Error("duplicate"), { code: 11000 });
    return { count: 2 };
  };

  try {
    const result = await consumeConverterRateLimit({
      userId: "user-race",
      operation: "export",
      limit: 1,
      windowMs: 600000,
      now: 1,
    });
    assert.equal(result.allowed, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][1], { $inc: { count: 1 } });
    assert.deepEqual(calls[1][2], { new: true });
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("rate limiter fails closed when an E11000 race cannot load its bucket", async () => {
  const { consumeConverterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  let calls = 0;
  ConverterRateLimitBucket.findOneAndUpdate = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("duplicate"), { code: 11000 });
    return null;
  };

  try {
    await assert.rejects(
      consumeConverterRateLimit({
        userId: "user-race",
        operation: "json",
        limit: 1,
        windowMs: 60000,
        now: 1,
      }),
      /rate limit bucket/i,
    );
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("rate limiter starts a fresh bucket exactly at the TTL boundary", async () => {
  const { consumeConverterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  const calls = [];
  ConverterRateLimitBucket.findOneAndUpdate = async (...args) => {
    calls.push(args);
    return { count: 1 };
  };

  try {
    const before = await consumeConverterRateLimit({
      userId: "user-boundary",
      operation: "json",
      limit: 1,
      windowMs: 60000,
      now: 59999,
    });
    const boundary = await consumeConverterRateLimit({
      userId: "user-boundary",
      operation: "json",
      limit: 1,
      windowMs: 60000,
      now: 60000,
    });
    assert.equal(calls[0][0].bucketStart.getTime(), 0);
    assert.equal(calls[1][0].bucketStart.getTime(), 60000);
    assert.equal(before.retryAfterSeconds, 1);
    assert.equal(boundary.retryAfterSeconds, 60);
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("rate-limit middleware returns Retry-After without entering the handler", async () => {
  const { converterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  ConverterRateLimitBucket.findOneAndUpdate = async () => ({ count: 2 });
  let nextCalls = 0;

  try {
    const response = responseRecorder();
    await converterRateLimit("analyze", { limit: 1, windowMs: 600000 })(
      { user: { _id: "user-429" } },
      response,
      () => {
        nextCalls += 1;
      },
    );
    assert.equal(response.statusCode, 429);
    assert.match(response.headers["retry-after"], /^\d+$/);
    assert.equal(response.body.retryAfter, Number(response.headers["retry-after"]));
    assert.equal(nextCalls, 0);
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("rate-limit middleware fails closed on database failure", async () => {
  const { converterRateLimit } = require("../middleware/converterRateLimit");
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const previousFindOneAndUpdate = ConverterRateLimitBucket.findOneAndUpdate;
  ConverterRateLimitBucket.findOneAndUpdate = async () => {
    throw new Error("mongodb unavailable with internal details");
  };
  let nextCalls = 0;

  try {
    const response = responseRecorder();
    await converterRateLimit("json", { limit: 1, windowMs: 60000 })(
      { requestId: "rate-limit-db-error", user: { _id: "user-db-error" } },
      response,
      () => {
        nextCalls += 1;
      },
    );
    assert.equal(response.statusCode, 503);
    assert.equal(nextCalls, 0);
    assert.equal(JSON.stringify(response.body).includes("mongodb"), false);
  } finally {
    ConverterRateLimitBucket.findOneAndUpdate = previousFindOneAndUpdate;
  }
});

test("all frontend-facing gateway routes use requireDb and protect", () => {
  const { router } = require("../routes/converterGateway");
  const expected = new Set([
    "/capabilities",
    "/templates",
    "/uploads/analyze",
    "/mappings/preview",
    "/mappings/readiness",
    "/mappings/confirm",
    "/conversions/export",
    "/sessions",
    "/sessions/:id",
  ]);
  for (const path of expected) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer, `missing route ${path}`);
    assert.deepEqual(
      layer.route.stack.slice(0, 2).map((item) => item.handle.name),
      ["requireDb", "protect"],
    );
  }
});

test("converter gateway mount requires both public proxy and usage-ready flags", () => {
  const serverPath = require.resolve("../server");
  const previousPublic = process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
  const previousUsageReady = process.env.CONVERTER_GATEWAY_USAGE_READY;
  const previousNodeEnv = process.env.NODE_ENV;

  function mountedGatewayRouters(app) {
    return app._router.stack.filter(
      (layer) =>
        layer.name === "router" &&
        layer.regexp?.toString().includes("api\\/converter"),
    ).length;
  }

  function loadApp(publicEnabled, usageReady) {
    process.env.CONVERTER_PUBLIC_PROXY_ENABLED = String(publicEnabled);
    process.env.CONVERTER_GATEWAY_USAGE_READY = String(usageReady);
    delete require.cache[serverPath];
    return require(serverPath).app;
  }

  try {
    process.env.NODE_ENV = "test";
    assert.equal(mountedGatewayRouters(loadApp(true, false)), 0);
    assert.equal(mountedGatewayRouters(loadApp(false, true)), 0);
    assert.equal(mountedGatewayRouters(loadApp(false, false)), 0);
    assert.equal(mountedGatewayRouters(loadApp(true, true)), 1);
  } finally {
    delete require.cache[serverPath];
    if (previousPublic === undefined) delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    else process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previousPublic;
    if (previousUsageReady === undefined) delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    else process.env.CONVERTER_GATEWAY_USAGE_READY = previousUsageReady;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("gate-off runtime app authenticates capabilities and omits operation routes", async () => {
  const serverPath = require.resolve("../server");
  const studentPath = require.resolve("../routes/student");
  const reconstructionPath = require.resolve("../routes/reconstructions");
  const previous = {
    publicProxy: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    usageReady: process.env.CONVERTER_GATEWAY_USAGE_READY,
    student: process.env.STUDENT_ASSISTANT_ENABLED,
    reconstruction: process.env.VOUCHER_RECONSTRUCTION_ENABLED,
    jwtSecret: process.env.JWT_SECRET,
    readyState: mongoose.connection.readyState,
  };
  const previousFindById = User.findById;
  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "false";
  process.env.STUDENT_ASSISTANT_ENABLED = "true";
  process.env.VOUCHER_RECONSTRUCTION_ENABLED = "true";
  process.env.JWT_SECRET = "gate-off-auth-secret";
  mongoose.connection.readyState = 1;
  User.findById = () => ({
    populate: async () => ({
      _id: "gate-off-user",
      isActive: true,
      plan: { code: "monthly" },
      dailyFileCreditDate: new Date().toISOString().slice(0, 10),
      isModified: () => false,
    }),
  });
  delete require.cache[serverPath];
  delete require.cache[studentPath];
  delete require.cache[reconstructionPath];
  const runtime = await listen(require(serverPath).app);

  try {
    const authorization = `Bearer ${jwt.sign(
      { id: "gate-off-user" },
      process.env.JWT_SECRET,
    )}`;
    const capabilities = await fetch(`${runtime.url}/api/converter/capabilities`);
    const student = await fetch(`${runtime.url}/api/student/sessions/session-1/analyze`, {
      method: "POST",
      headers: { authorization },
    });
    const reconstruction = await fetch(
      `${runtime.url}/api/reconstructions/run-1/operations/analyze`,
      { method: "POST", headers: { authorization } },
    );
    assert.equal(capabilities.status, 401);
    assert.equal(student.status, 404);
    assert.equal(reconstruction.status, 404);
  } finally {
    runtime.server.close();
    User.findById = previousFindById;
    mongoose.connection.readyState = previous.readyState;
    delete require.cache[serverPath];
    delete require.cache[studentPath];
    delete require.cache[reconstructionPath];
    for (const [name, value] of [
      ["CONVERTER_PUBLIC_PROXY_ENABLED", previous.publicProxy],
      ["CONVERTER_GATEWAY_USAGE_READY", previous.usageReady],
      ["STUDENT_ASSISTANT_ENABLED", previous.student],
      ["VOUCHER_RECONSTRUCTION_ENABLED", previous.reconstruction],
      ["JWT_SECRET", previous.jwtSecret],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("gate-on runtime operation routes reject anonymous requests", async () => {
  const serverPath = require.resolve("../server");
  const studentPath = require.resolve("../routes/student");
  const reconstructionPath = require.resolve("../routes/reconstructions");
  const previous = {
    publicProxy: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    usageReady: process.env.CONVERTER_GATEWAY_USAGE_READY,
    student: process.env.STUDENT_ASSISTANT_ENABLED,
    reconstruction: process.env.VOUCHER_RECONSTRUCTION_ENABLED,
    readyState: mongoose.connection.readyState,
  };
  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
  process.env.STUDENT_ASSISTANT_ENABLED = "true";
  process.env.VOUCHER_RECONSTRUCTION_ENABLED = "true";
  mongoose.connection.readyState = 1;
  delete require.cache[serverPath];
  delete require.cache[studentPath];
  delete require.cache[reconstructionPath];
  const runtime = await listen(require(serverPath).app);

  try {
    const converter = await fetch(`${runtime.url}/api/converter/capabilities`);
    const student = await fetch(`${runtime.url}/api/student/sessions/session-1/analyze`, {
      method: "POST",
    });
    const reconstruction = await fetch(
      `${runtime.url}/api/reconstructions/run-1/operations/analyze`,
      { method: "POST" },
    );
    assert.equal(converter.status, 401);
    assert.equal(student.status, 401);
    assert.equal(reconstruction.status, 401);
  } finally {
    runtime.server.close();
    mongoose.connection.readyState = previous.readyState;
    delete require.cache[serverPath];
    delete require.cache[studentPath];
    delete require.cache[reconstructionPath];
    for (const [name, value] of [
      ["CONVERTER_PUBLIC_PROXY_ENABLED", previous.publicProxy],
      ["CONVERTER_GATEWAY_USAGE_READY", previous.usageReady],
      ["STUDENT_ASSISTANT_ENABLED", previous.student],
      ["VOUCHER_RECONSTRUCTION_ENABLED", previous.reconstruction],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("student and reconstruction operations extend their existing protected routers", () => {
  const converterGateway = require("../routes/converterGateway");
  const studentPath = require.resolve("../routes/student");
  const reconstructionPath = require.resolve("../routes/reconstructions");
  const previousPublic = process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
  const previousUsageReady = process.env.CONVERTER_GATEWAY_USAGE_READY;
  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
  delete require.cache[studentPath];
  delete require.cache[reconstructionPath];

  try {
    const studentRouter = require(studentPath);
    const reconstructionRouter = require(reconstructionPath);
    assert.equal(converterGateway.studentRouter, undefined);
    assert.equal(converterGateway.reconstructionRouter, undefined);
    assert.ok(routeByPath(studentRouter, "/sessions/:id/analyze", "post"));
    assert.ok(routeByPath(studentRouter, "/sessions/:id/operations/*", "post"));
    assert.ok(routeByPath(reconstructionRouter, "/:id/operations/analyze", "post"));
    assert.ok(routeByPath(reconstructionRouter, "/:id/operations/*", "post"));

    for (const router of [studentRouter, reconstructionRouter]) {
      const authLayers = router.stack.filter((layer) =>
        ["requireDb", "protect"].includes(layer.handle?.name),
      );
      assert.deepEqual(
        authLayers.map((layer) => layer.handle.name),
        ["requireDb", "protect"],
      );
      for (const layer of router.stack.filter((item) => item.route?.path?.includes("operations"))) {
        assert.equal(
          layer.route.stack.some((item) =>
            ["requireDb", "protect"].includes(item.handle.name),
          ),
          false,
        );
      }
    }
  } finally {
    delete require.cache[studentPath];
    delete require.cache[reconstructionPath];
    if (previousPublic === undefined) delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    else process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previousPublic;
    if (previousUsageReady === undefined) delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    else process.env.CONVERTER_GATEWAY_USAGE_READY = previousUsageReady;
  }
});

test("rate-limit bucket schema has unique owner operation bucket and TTL indexes", () => {
  const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");
  const indexes = ConverterRateLimitBucket.schema.indexes();
  assert.ok(
    indexes.some(
      ([fields, options]) =>
        fields.userId === 1 &&
        fields.operation === 1 &&
        fields.bucketStart === 1 &&
        options.unique === true,
    ),
  );
  assert.ok(
    indexes.some(
      ([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0,
    ),
  );
  assert.equal(mongoose.models.ConverterRateLimitBucket, ConverterRateLimitBucket);
});
