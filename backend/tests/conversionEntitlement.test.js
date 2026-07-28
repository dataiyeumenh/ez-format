const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const mongoose = require("mongoose");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const User = require("../models/User");
const Plan = require("../models/Plan");
const ConversionRun = require("../models/ConversionRun");
const conversionSessionStates = require("../services/conversionSessionStateService");
const { vnDateString } = require("../services/subscriptionService");

process.env.NODE_ENV = "test";
process.env.CONVERTER_ALLOW_INSECURE_LOCALHOST = "true";

const mongoIntegrationUri = String(
  process.env.CONVERSION_ENTITLEMENT_TEST_MONGO_URI || "",
).trim();

function uniqueMongoDatabaseUri(uri) {
  const parsed = new URL(uri);
  parsed.pathname = `/conversion_entitlement_${process.pid}_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
  return parsed.toString();
}

function queryResult(value) {
  return {
    populate() {
      return this;
    },
    session() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

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
      return this;
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

function multipartField(payload, name) {
  const marker = `name="${name}"\r\n\r\n`;
  const start = payload.indexOf(marker);
  if (start === -1) return "";
  const valueStart = start + marker.length;
  const valueEnd = payload.indexOf("\r\n", valueStart);
  return payload.slice(valueStart, valueEnd === -1 ? undefined : valueEnd);
}

function newRun(userId, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user: userId,
    workspace: null,
    conversionContextId: "context-1",
    operationSessionId: "session-1",
    converterUploadId: "upload-1",
    targetTemplateId: "bsn_sales",
    status: "processing",
    usageState: "chargeable",
    usageIdempotencyKey: "usage-1",
    exportArtifactKey: "",
    inputSha256: "input-hash",
    outputSha256: "",
    save: async function save() {
      return this;
    },
    ...overrides,
  };
}

function artifactProof(run, outputSha256 = "a".repeat(64)) {
  return {
    artifactKey: `conversion-${run._id}-${outputSha256}.bin`,
    outputSha256,
  };
}

function patchValue(target, key, value) {
  const previous = target[key];
  target[key] = value;
  return () => {
    target[key] = previous;
  };
}

function readyMongoConnection() {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  return () => {
    mongoose.connection.readyState = previous;
  };
}

test("user with zero credits cannot create conversion run", async () => {
  const { analyzeUpload } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  let createCalls = 0;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const restoreUser = patchValue(
    User,
    "findById",
    () =>
      queryResult({
        _id: userId,
        plan: { code: "free" },
        dailyFileCredit: 0,
        fileCredits: 0,
        dailyFileCreditDate: vnDateString(),
      }),
  );
  const restoreCreate = patchValue(ConversionRun, "create", async () => {
    createCalls += 1;
    return newRun(userId);
  });
  const restoreFindOne = patchValue(ConversionRun, "findOne", () => queryResult(null));
  process.env.CONVERSION_CONTEXT_SECRET = "zero-credit-secret";

  try {
    const response = responseRecorder();
    await analyzeUpload(
      {
        user: { _id: userId, name: "Owner", email: "owner@example.com" },
        file: { originalname: "input.xlsx", buffer: Buffer.from("file"), size: 4 },
        body: { target_template_id: "bsn_sales" },
      },
      response,
    );
    assert.equal(response.statusCode, 402, JSON.stringify(response.body));
    assert.equal(createCalls, 0);
  } finally {
    restoreUser();
    restoreCreate();
    restoreFindOne();
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("auto-detected analyze retry replays the resolved persisted template without conflict", async () => {
  const { analyzeUpload } = require("../controllers/converterGatewayController");
  const conversionArtifacts = require("../services/conversionArtifactService");
  const {
    verifyConversionContextToken,
  } = require("../services/conversionContextService");
  const userId = new mongoose.Types.ObjectId();
  const file = Buffer.from("same-analyze-input");
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    objectStorageRequired: process.env.CONVERTER_OBJECT_STORAGE_REQUIRED,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
  };
  const converterPayload = {
    upload_id: "analyze-upload",
    target_template_id: "bsn_sales",
    detected: { sheet_name: "Data", headers: ["Số CT", "Tiền"] },
    mapping_suggestion: {
      mapping: { "Số CT": "Số chứng từ" },
      source: "heuristic",
    },
    issues: [{ code: "missing_account", severity: "warning" }],
    session: {
      session_id: "",
      active_revision: 1,
      state_hash: "state-hash-1",
      expires_at: "2026-07-28T01:00:00.000Z",
    },
  };
  let run = null;
  let converterCalls = 0;
  let entitlementLookups = 0;
  let initialClaims = null;
  let trustedOperationSessionId = "";
  let trustedConversionRunId = "";
  const reservations = [];
  const uploadBindings = [];
  const artifacts = new Map();
  const artifactWrites = [];
  const received = await listen(async (req, res) => {
    converterCalls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const formPayload = Buffer.concat(chunks).toString("utf8");
    initialClaims = verifyConversionContextToken(req.headers["x-conversion-context"]);
    trustedOperationSessionId = multipartField(formPayload, "operation_session_id");
    trustedConversionRunId = multipartField(formPayload, "conversion_run_id");
    assert.equal(trustedOperationSessionId, initialClaims.operation_session_id);
    assert.equal(trustedConversionRunId, initialClaims.conversion_run_id);
    assert.equal(reservations.length, 1, "session must be reserved before analyze forwarding");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ...converterPayload,
      operation_session_id: trustedOperationSessionId,
      session: {
        ...converterPayload.session,
        session_id: trustedOperationSessionId,
      },
    }));
  });
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreCreate = patchValue(ConversionRun, "create", async (payload) => {
    run = newRun(userId, payload);
    return run;
  });
  const restoreUser = patchValue(User, "findById", () => {
    entitlementLookups += 1;
    return queryResult({
      _id: userId,
      plan: { code: "free" },
      dailyFileCredit: 1,
      fileCredits: 0,
      dailyFileCreditDate: vnDateString(),
    });
  });
  const restoreReserve = patchValue(
    conversionSessionStates,
    "reserveSessionState",
    async (input) => {
      reservations.push(input);
      return { ...input, revision: 0, status: "allocated" };
    },
  );
  const restoreBindUpload = patchValue(
    conversionSessionStates,
    "bindSessionUpload",
    async (input) => {
      uploadBindings.push(input);
      return { ...input, revision: 0, status: "allocated" };
    },
  );
  const restoreArtifactPut = patchValue(conversionArtifacts, "putArtifact", async (input) => {
    const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
    const suffix = ["analysis", "state"].includes(input.kind) ? "json" : "bin";
    const storageKey =
      `sessions/${input.sessionId}/runs/${input.runId}/${input.kind}/r${input.revision}-${sha256}.${suffix}`;
    const metadata = { ...input, storageKey, sha256, sizeBytes: input.content.length };
    artifacts.set(storageKey, { metadata, content: Buffer.from(input.content) });
    artifactWrites.push(input);
    return metadata;
  });
  const restoreArtifactGet = patchValue(conversionArtifacts, "getArtifact", async (input) => {
    const found = [...artifacts.values()].find(
      ({ metadata }) =>
        metadata.sessionId === input.sessionId &&
        metadata.runId === input.runId &&
        metadata.kind === input.kind &&
        (input.revision == null || metadata.revision === input.revision),
    );
    if (!found) throw Object.assign(new Error("Artifact was not found"), { statusCode: 404 });
    return found;
  });
  process.env.CONVERSION_CONTEXT_SECRET = "analyze-retry-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERTER_OBJECT_STORAGE_REQUIRED = "false";

  function request() {
    return {
      requestId: "analyze-retry-request",
      user: { _id: userId, name: "Owner", email: "owner@example.com" },
      headers: { "idempotency-key": "analyze-retry" },
      file: {
        originalname: "input.xlsx",
        buffer: file,
        size: file.length,
      },
      body: {
        operation_session_id: "browser-session-must-not-win",
        conversion_run_id: "browser-run-must-not-win",
      },
    };
  }

  try {
    const first = responseRecorder();
    await analyzeUpload(request(), first);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(converterCalls, 1);
    assert.equal(entitlementLookups, 1);
    assert.match(run.operationSessionId, /^[0-9a-f-]{36}$/i);
    assert.equal(run.operationSessionId, trustedOperationSessionId);
    assert.equal(String(run._id), trustedConversionRunId);
    assert.equal(initialClaims.operation_session_id, run.operationSessionId);
    assert.equal(initialClaims.conversion_run_id, String(run._id));
    assert.equal(reservations[0].sessionId, run.operationSessionId);
    assert.equal(reservations[0].runId, String(run._id));
    assert.equal(initialClaims.target_template_id, "");
    assert.equal(reservations[0].targetTemplateId, "");
    assert.equal(uploadBindings[0].sessionId, run.operationSessionId);
    assert.equal(uploadBindings[0].uploadId, converterPayload.upload_id);
    assert.equal(uploadBindings[0].targetTemplateId, "bsn_sales");
    assert.ok(run.analysisArtifactKey);
    assert.match(run.analysisSha256, /^[a-f0-9]{64}$/);
    assert.equal(artifactWrites.length, 1);
    assert.equal(artifactWrites[0].kind, "analysis");
    assert.equal(artifactWrites[0].sessionId, run.operationSessionId);
    assert.equal(artifactWrites[0].runId, String(run._id));
    assert.equal(artifactWrites[0].uploadId, converterPayload.upload_id);
    assert.equal(artifactWrites[0].targetTemplateId, "bsn_sales");

    const stored = artifacts.get(run.analysisArtifactKey);
    const storedPayload = JSON.parse(stored.content.toString("utf8"));
    assert.deepEqual(storedPayload.mapping_suggestion, converterPayload.mapping_suggestion);
    assert.deepEqual(storedPayload.issues, converterPayload.issues);
    assert.equal(storedPayload.session.session_id, run.operationSessionId);
    assert.equal(storedPayload.contextToken, first.body.contextToken);

    const replay = responseRecorder();
    await analyzeUpload(request(), replay);
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.idempotent, true);
    for (const field of [
      "upload_id",
      "target_template_id",
      "detected",
      "mapping_suggestion",
      "issues",
      "session",
    ]) {
      assert.deepEqual(replay.body[field], first.body[field], field);
    }
    const replayClaims = verifyConversionContextToken(replay.body.contextToken);
    assert.equal(replayClaims.conversion_run_id, String(run._id));
    assert.equal(replayClaims.operation_session_id, run.operationSessionId);
    assert.equal(replayClaims.upload_id, converterPayload.upload_id);
    assert.equal(converterCalls, 1);
    assert.equal(entitlementLookups, 1);

    artifacts.delete(run.analysisArtifactKey);
    const missing = responseRecorder();
    await analyzeUpload(request(), missing);
    assert.equal(missing.statusCode, 410);
    assert.equal(converterCalls, 1);
    assert.equal(entitlementLookups, 1);
  } finally {
    received.server.close();
    restoreRun();
    restoreCreate();
    restoreUser();
    restoreReserve();
    restoreBindUpload();
    restoreArtifactPut();
    restoreArtifactGet();
    for (const [name, value] of Object.entries({
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_OBJECT_STORAGE_REQUIRED: previous.objectStorageRequired,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("analyze fails closed when Converter returns a different operation session", async () => {
  const { analyzeUpload } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
  };
  let run = null;
  let bindCalls = 0;
  const received = await listen(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the request before replying so fetch completes deterministically.
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      upload_id: "upload-mismatch",
      target_template_id: "bsn_sales",
      operation_session_id: "foreign-operation-session",
      session: { session_id: "foreign-operation-session" },
    }));
  });
  const restoreFindOne = patchValue(ConversionRun, "findOne", () => queryResult(null));
  const restoreCreate = patchValue(ConversionRun, "create", async (payload) => {
    run = newRun(userId, payload);
    return run;
  });
  const restoreUser = patchValue(User, "findById", () => queryResult({
    _id: userId,
    name: "Owner",
    email: "owner@example.com",
    plan: { code: "free" },
    dailyFileCredit: 1,
    fileCredits: 0,
    dailyFileCreditDate: vnDateString(),
  }));
  const restoreReserve = patchValue(
    conversionSessionStates,
    "reserveSessionState",
    async (input) => ({ ...input, revision: 0, status: "allocated" }),
  );
  const restoreBindUpload = patchValue(
    conversionSessionStates,
    "bindSessionUpload",
    async () => {
      bindCalls += 1;
    },
  );
  process.env.CONVERSION_CONTEXT_SECRET = "analyze-mismatch-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const response = responseRecorder();
    await analyzeUpload(
      {
        requestId: "analyze-mismatch-request",
        user: { _id: userId, name: "Owner", email: "owner@example.com" },
        headers: { "idempotency-key": "analyze-mismatch" },
        file: { originalname: "input.xlsx", buffer: Buffer.from("file"), size: 4 },
        body: { target_template_id: "bsn_sales" },
      },
      response,
    );
    assert.equal(response.statusCode, 502, JSON.stringify(response.body));
    assert.match(response.body.message, /operation session/i);
    assert.equal(run.status, "failed");
    assert.equal(run.usageState, "not_chargeable");
    assert.equal(bindCalls, 0);
  } finally {
    received.server.close();
    restoreFindOne();
    restoreCreate();
    restoreUser();
    restoreReserve();
    restoreBindUpload();
    for (const [name, value] of Object.entries({
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("completed export charges one credit only", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "charge-once" });
  const restoreReadyState = readyMongoConnection();
  let decrementCalls = 0;
  const user = {
    _id: userId,
    plan: { code: "perfile" },
    dailyFileCredit: 0,
    fileCredits: 2,
    dailyFileCreditDate: vnDateString(),
  };
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  const restoreRun = patchValue(ConversionRun, "findById", () => queryResult(run));
  const restoreRunUpdate = patchValue(
    ConversionRun,
    "findOneAndUpdate",
    async (_filter, update) => {
      Object.assign(run, update.$set);
      return run;
    },
  );
  const restoreUser = patchValue(User, "findById", () => queryResult(user));
  const restoreUpdate = patchValue(User, "findOneAndUpdate", async (_filter, update) => {
    decrementCalls += 1;
    user.fileCredits += Number(update.$inc.fileCredits || 0);
    return user;
  });

  try {
    const result = await chargeCompletedConversion({
      runId: run._id,
      userId,
      idempotencyKey: "charge-once",
      ...artifactProof(run),
    });
    assert.equal(result.charged, true);
    assert.equal(decrementCalls, 1);
    assert.equal(user.fileCredits, 1);
    assert.equal(run.usageState, "charged");
  } finally {
    restoreTransaction();
    restoreReadyState();
    restoreRun();
    restoreRunUpdate();
    restoreUser();
    restoreUpdate();
  }
});

test("invalid artifact proof rejects before any credit update", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "invalid-proof" });
  let updateCalls = 0;
  const restoreReadyState = readyMongoConnection();
  const restoreUpdate = patchValue(User, "findOneAndUpdate", async () => {
    updateCalls += 1;
    return run;
  });

  try {
    await assert.rejects(
      chargeCompletedConversion({
        runId: run._id,
        userId,
        idempotencyKey: run.usageIdempotencyKey,
        artifactKey: "",
        outputSha256: "",
      }),
      (error) => error?.code === "INVALID_ARTIFACT_HASH",
    );
    await assert.rejects(
      chargeCompletedConversion({
        runId: run._id,
        userId,
        idempotencyKey: run.usageIdempotencyKey,
        artifactKey: `conversion-${run._id}-${"b".repeat(64)}.bin`,
        outputSha256: "not-a-sha",
      }),
      (error) => error?.code === "INVALID_ARTIFACT_HASH",
    );
    const otherRunId = new mongoose.Types.ObjectId();
    await assert.rejects(
      chargeCompletedConversion({
        runId: run._id,
        userId,
        idempotencyKey: run.usageIdempotencyKey,
        artifactKey: `conversion-${otherRunId}-${"d".repeat(64)}.bin`,
        outputSha256: "d".repeat(64),
      }),
      (error) => error?.code === "INVALID_ARTIFACT_KEY",
    );
    assert.equal(updateCalls, 0);
  } finally {
    restoreReadyState();
    restoreUpdate();
  }
});

test("idempotency fallback rejects an artifact bound to another run", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "fallback-binding" });
  const otherRunId = new mongoose.Types.ObjectId();
  const outputSha256 = "e".repeat(64);
  let updateCalls = 0;
  const restoreReadyState = readyMongoConnection();
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  const restoreFindById = patchValue(ConversionRun, "findById", () => queryResult(null));
  const restoreFindOne = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreUpdate = patchValue(User, "findOneAndUpdate", async () => {
    updateCalls += 1;
    return run;
  });

  try {
    await assert.rejects(
      chargeCompletedConversion({
        runId: otherRunId,
        userId,
        idempotencyKey: run.usageIdempotencyKey,
        artifactKey: `conversion-${otherRunId}-${outputSha256}.bin`,
        outputSha256,
      }),
      (error) => error?.code === "ARTIFACT_RUN_MISMATCH",
    );
    assert.equal(updateCalls, 0);
  } finally {
    restoreReadyState();
    restoreTransaction();
    restoreFindById();
    restoreFindOne();
    restoreUpdate();
  }
});

test("E11000 idempotency fallback rejects a different existing run", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const requestedRun = newRun(userId, { usageIdempotencyKey: "e11000-key" });
  const existingRun = newRun(userId, {
    usageIdempotencyKey: requestedRun.usageIdempotencyKey,
    usageState: "charged",
    status: "completed",
    outputSha256: "f".repeat(64),
    exportArtifactKey: `conversion-${new mongoose.Types.ObjectId()}-${"f".repeat(64)}.bin`,
  });
  const restoreReadyState = readyMongoConnection();
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async () => {
      const error = new Error("duplicate idempotency key");
      error.code = 11000;
      throw error;
    },
  );
  const restoreFindOne = patchValue(ConversionRun, "findOne", () => queryResult(existingRun));

  try {
    await assert.rejects(
      chargeCompletedConversion({
        runId: requestedRun._id,
        userId,
        idempotencyKey: requestedRun.usageIdempotencyKey,
        ...artifactProof(requestedRun, "f".repeat(64)),
      }),
      (error) => error?.statusCode === 409 && error?.code === "CONVERSION_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    restoreReadyState();
    restoreTransaction();
    restoreFindOne();
  }
});

test("E11000 idempotency fallback rejects when no exact run can be loaded", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const requestedRun = newRun(userId, { usageIdempotencyKey: "e11000-missing-key" });
  const restoreReadyState = readyMongoConnection();
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async () => {
      const error = new Error("duplicate idempotency key");
      error.code = 11000;
      throw error;
    },
  );
  const restoreFindOne = patchValue(ConversionRun, "findOne", () => queryResult(null));

  try {
    await assert.rejects(
      chargeCompletedConversion({
        runId: requestedRun._id,
        userId,
        idempotencyKey: requestedRun.usageIdempotencyKey,
        ...artifactProof(requestedRun, "e".repeat(64)),
      }),
      (error) => error?.statusCode === 409 && error?.code === "CONVERSION_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    restoreReadyState();
    restoreTransaction();
    restoreFindOne();
  }
});

test("completed export fails closed when its persistent artifact is missing", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const conversionArtifacts = require("../services/conversionArtifactService");
  const userId = new mongoose.Types.ObjectId();
  const outputSha256 = "1".repeat(64);
  const run = newRun(userId, {
    status: "completed",
    usageState: "charged",
    outputSha256,
    exportArtifactKey: "",
  });
  run.exportArtifactKey =
    `sessions/${run.operationSessionId}/runs/${run._id}/output/r1-${outputSha256}.bin`;
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
  };
  let converterCalls = 0;
  const received = await listen((_req, res) => {
    converterCalls += 1;
    res.end(Buffer.from("must-not-regenerate"));
  });
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreArtifactGet = patchValue(conversionArtifacts, "getArtifact", async () => {
    throw Object.assign(new Error("Artifact was not found"), { statusCode: 404 });
  });
  process.env.CONVERSION_CONTEXT_SECRET = "missing-artifact-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId: null,
      conversionContextId: run.conversionContextId,
      conversionRunId: run._id,
      operationSessionId: run.operationSessionId,
      uploadId: run.converterUploadId,
      targetTemplateId: run.targetTemplateId,
      scopes: ["export"],
    });
    const response = responseRecorder();
    await exportConversion(
      {
        requestId: "missing-artifact-request",
        user: { _id: userId },
        headers: { "x-conversion-context": contextToken },
        body: {
          conversion_run_id: String(run._id),
          upload_id: run.converterUploadId,
          target_template_id: run.targetTemplateId,
        },
      },
      response,
    );
    assert.equal(response.statusCode, 410);
    assert.equal(converterCalls, 0);
  } finally {
    received.server.close();
    restoreRun();
    restoreArtifactGet();
    for (const [name, value] of Object.entries({
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("artifact publishing is atomic for concurrent writers", async () => {
  const {
    artifactDirectory,
    readConversionArtifact,
    writeConversionArtifact,
  } = require("../services/conversionCreditService");
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-race-"));
  const runId = new mongoose.Types.ObjectId();
  const bytes = Buffer.from("same-concurrent-artifact");
  const outputSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const proof = {
    runId,
    artifactKey: `conversion-${runId}-${outputSha256}.bin`,
    outputSha256,
  };
  const env = {
    ...process.env,
    CONVERTER_ARTIFACT_DIR: artifactDir,
    CONVERTER_ARTIFACT_MAX_BYTES: String(bytes.length),
    CONVERTER_ARTIFACT_MAX_FILES: "1",
  };

  try {
    const results = await Promise.all(
      Array.from({ length: 2 }, () => writeConversionArtifact({ ...proof, bytes }, env)),
    );
    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(await readConversionArtifact(proof, env), bytes);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(artifactDirectory(env))).mode & 0o777, 0o700);
      assert.equal(
        (await fs.stat(path.join(artifactDirectory(env), proof.artifactKey))).mode & 0o777,
        0o600,
      );
    }
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact persistence sweeps expired files and enforces file quota", async () => {
  const {
    artifactDirectory,
    readConversionArtifact,
    writeConversionArtifact,
  } = require("../services/conversionCreditService");
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-quota-"));
  const env = {
    ...process.env,
    CONVERTER_ARTIFACT_DIR: artifactDir,
    CONVERTER_ARTIFACT_TTL_SECONDS: "1",
    CONVERTER_ARTIFACT_MAX_FILES: "2",
    CONVERTER_ARTIFACT_SWEEP_MAX_FILES: "20",
  };
  const firstBytes = Buffer.from("expired-artifact");
  const firstRunId = new mongoose.Types.ObjectId();
  const firstSha = crypto.createHash("sha256").update(firstBytes).digest("hex");
  const firstProof = {
    runId: firstRunId,
    artifactKey: `conversion-${firstRunId}-${firstSha}.bin`,
    outputSha256: firstSha,
  };
  const secondBytes = Buffer.from("current-artifact");
  const secondRunId = new mongoose.Types.ObjectId();
  const secondSha = crypto.createHash("sha256").update(secondBytes).digest("hex");
  const secondProof = {
    runId: secondRunId,
    artifactKey: `conversion-${secondRunId}-${secondSha}.bin`,
    outputSha256: secondSha,
  };
  const thirdRunId = new mongoose.Types.ObjectId();
  const thirdBytes = Buffer.from("quota-artifact");
  const thirdSha = crypto.createHash("sha256").update(thirdBytes).digest("hex");
  const thirdProof = {
    runId: thirdRunId,
    artifactKey: `conversion-${thirdRunId}-${thirdSha}.bin`,
    outputSha256: thirdSha,
  };

  try {
    await writeConversionArtifact({ ...firstProof, bytes: firstBytes }, env);
    const expiredAt = new Date(Date.now() - 5000);
    await fs.utimes(path.join(artifactDirectory(env), firstProof.artifactKey), expiredAt, expiredAt);
    await writeConversionArtifact({ ...secondProof, bytes: secondBytes }, env);
    assert.equal(await readConversionArtifact(firstProof, env), null);
    assert.deepEqual(await readConversionArtifact(secondProof, env), secondBytes);

    const quotaEnv = { ...env, CONVERTER_ARTIFACT_TTL_SECONDS: "86400", CONVERTER_ARTIFACT_MAX_FILES: "1" };
    await assert.rejects(
      writeConversionArtifact({ ...thirdProof, bytes: thirdBytes }, quotaEnv),
      (error) => error?.code === "ARTIFACT_QUOTA_EXCEEDED",
    );

    const byteQuotaEnv = {
      ...env,
      CONVERTER_ARTIFACT_TTL_SECONDS: "86400",
      CONVERTER_ARTIFACT_MAX_FILES: "10",
      CONVERTER_ARTIFACT_MAX_BYTES: String(
        secondBytes.length + thirdBytes.length - 1,
      ),
    };
    await assert.rejects(
      writeConversionArtifact({ ...thirdProof, bytes: thirdBytes }, byteQuotaEnv),
      (error) => error?.code === "ARTIFACT_QUOTA_EXCEEDED",
    );
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact reads enforce TTL before any sweep runs", async () => {
  const {
    artifactDirectory,
    readConversionArtifact,
    writeConversionArtifact,
  } = require("../services/conversionCreditService");
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-read-ttl-"));
  const bytes = Buffer.from("read-expired-artifact");
  const runId = new mongoose.Types.ObjectId();
  const outputSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const proof = {
    runId,
    artifactKey: `conversion-${runId}-${outputSha256}.bin`,
    outputSha256,
  };
  const env = {
    ...process.env,
    CONVERTER_ARTIFACT_DIR: artifactDir,
    CONVERTER_ARTIFACT_TTL_SECONDS: "1",
  };

  try {
    await writeConversionArtifact({ ...proof, bytes }, env);
    const target = path.join(artifactDirectory(env), proof.artifactKey);
    const expiredAt = new Date(Date.now() - 5000);
    await fs.utimes(target, expiredAt, expiredAt);
    assert.equal(await readConversionArtifact(proof, env), null);
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact quota is atomic for concurrent distinct writers", async () => {
  const {
    artifactDirectory,
    writeConversionArtifact,
  } = require("../services/conversionCreditService");
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-quota-race-"));
  const env = {
    ...process.env,
    CONVERTER_ARTIFACT_DIR: artifactDir,
    CONVERTER_ARTIFACT_MAX_FILES: "1",
    CONVERTER_ARTIFACT_MAX_BYTES: "1024",
  };
  const proofs = ["writer-one", "writer-two"].map((value) => {
    const bytes = Buffer.from(value);
    const runId = new mongoose.Types.ObjectId();
    const outputSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      runId,
      artifactKey: `conversion-${runId}-${outputSha256}.bin`,
      outputSha256,
      bytes,
    };
  });

  try {
    const results = await Promise.allSettled(
      proofs.map((proof) => writeConversionArtifact(proof, env)),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "ARTIFACT_QUOTA_EXCEEDED");
    const entries = await fs.readdir(artifactDirectory(env));
    assert.equal(entries.filter((entry) => entry.startsWith("conversion-")).length, 1);
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("artifact sweeper preserves active locks and removes bounded stale locks", async () => {
  const {
    artifactDirectory,
    sweepConversionArtifacts,
  } = require("../services/conversionCreditService");
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-lock-"));
  const env = { ...process.env, CONVERTER_ARTIFACT_DIR: artifactDir };
  const lockPath = path.join(artifactDirectory(env), ".artifact-store.lock");
  const oldAt = new Date(Date.now() - 60_000);

  try {
    await fs.mkdir(artifactDirectory(env), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "active" }),
      { flag: "wx", mode: 0o600 },
    );
    await fs.utimes(lockPath, oldAt, oldAt);
    await sweepConversionArtifacts(env);
    await fs.access(lockPath);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o600);
    }

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, hostname: os.hostname(), token: "stale" }),
    );
    await fs.utimes(lockPath, oldAt, oldAt);
    await sweepConversionArtifacts(env);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

test("directory fsync propagates real I/O errors", async () => {
  const { syncDirectory } = require("../services/conversionCreditService");
  let closed = false;
  await assert.rejects(
    syncDirectory("ignored", {
      open: async () => ({
        sync: async () => {
          const error = new Error("disk I/O failure");
          error.code = "EIO";
          throw error;
        },
        close: async () => {
          closed = true;
        },
      }),
    }),
    (error) => error?.code === "EIO",
  );
  assert.equal(closed, true);
});

test("artifact adapter rejects required object storage fallback and symlinks", async (t) => {
  const {
    readConversionArtifact,
    writeConversionArtifact,
  } = require("../services/conversionCreditService");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifact-security-"));
  const realDir = path.join(root, "real");
  const linkDir = path.join(root, "link");
  await fs.mkdir(realDir);
  const bytes = Buffer.from("secure-artifact");
  const outputSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const runId = new mongoose.Types.ObjectId();
  const proof = {
    runId,
    artifactKey: `conversion-${runId}-${outputSha256}.bin`,
    outputSha256,
  };

  try {
    await assert.rejects(
      writeConversionArtifact({ ...proof, bytes }, {
        ...process.env,
        CONVERTER_ARTIFACT_DIR: realDir,
        CONVERTER_OBJECT_STORAGE_REQUIRED: "true",
      }),
      (error) => error?.code === "OBJECT_STORAGE_REQUIRED",
    );
    await assert.rejects(
      writeConversionArtifact({
        ...proof,
        artifactKey: `../${proof.artifactKey}`,
        bytes,
      }, {
        ...process.env,
        CONVERTER_ARTIFACT_DIR: realDir,
      }),
      (error) => error?.code === "INVALID_ARTIFACT_KEY",
    );

    try {
      await fs.symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeConversionArtifact({ ...proof, bytes }, {
        ...process.env,
        CONVERTER_ARTIFACT_DIR: linkDir,
      }),
      (error) => error?.code === "UNSAFE_ARTIFACT_DIRECTORY",
    );

    const target = path.join(realDir, proof.artifactKey);
    const external = path.join(root, "external.bin");
    await fs.writeFile(external, bytes);
    try {
      await fs.symlink(external, target, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      readConversionArtifact(proof, {
        ...process.env,
        CONVERTER_ARTIFACT_DIR: realDir,
      }),
      (error) => error?.code === "UNSAFE_ARTIFACT_TARGET",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retrying same idempotency key never charges twice", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "retry-once" });
  const restoreReadyState = readyMongoConnection();
  const user = {
    _id: userId,
    plan: { code: "free" },
    dailyFileCredit: 1,
    fileCredits: 0,
    dailyFileCreditDate: vnDateString(),
  };
  let decrementCalls = 0;
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  const restoreRun = patchValue(ConversionRun, "findById", () => queryResult(run));
  const restoreRunUpdate = patchValue(
    ConversionRun,
    "findOneAndUpdate",
    async (_filter, update) => {
      Object.assign(run, update.$set);
      return run;
    },
  );
  const restoreUser = patchValue(User, "findById", () => queryResult(user));
  const restoreUpdate = patchValue(User, "findOneAndUpdate", async (_filter, update) => {
    decrementCalls += 1;
    user.dailyFileCredit += Number(update.$inc.dailyFileCredit || 0);
    return user;
  });

  try {
    const first = await chargeCompletedConversion({
      runId: run._id,
      userId,
      idempotencyKey: "retry-once",
      ...artifactProof(run),
    });
    const second = await chargeCompletedConversion({
      runId: run._id,
      userId,
      idempotencyKey: "retry-once",
      ...artifactProof(run),
    });
    assert.equal(first.charged, true);
    assert.equal(second.idempotent, true);
    assert.equal(decrementCalls, 1);
    assert.equal(second.creditChargedAt, first.creditChargedAt);
  } finally {
    restoreTransaction();
    restoreReadyState();
    restoreRun();
    restoreRunUpdate();
    restoreUser();
    restoreUpdate();
  }
});

test("monthly/yearly usage records run without decrementing file credits", async () => {
  const { chargeCompletedConversion } = require("../services/conversionCreditService");
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  let currentRun = null;
  let currentUser = null;
  const restoreReadyState = readyMongoConnection();
  const restoreRun = patchValue(ConversionRun, "findById", () => queryResult(currentRun));
  const restoreRunUpdate = patchValue(
    ConversionRun,
    "findOneAndUpdate",
    async (_filter, update) => {
      Object.assign(currentRun, update.$set);
      return currentRun;
    },
  );
  const restoreUser = patchValue(User, "findById", () => queryResult(null));
  const restoreUpdate = patchValue(User, "findOneAndUpdate", async (_filter, update) => {
    assert.equal(update.$inc, undefined, "monthly/yearly must not decrement credits");
    return currentUser;
  });

  try {
    for (const planCode of ["monthly", "yearly"]) {
      const userId = new mongoose.Types.ObjectId();
      const run = newRun(userId, {
        usageIdempotencyKey: `usage-${planCode}`,
      });
      currentRun = run;
      ConversionRun.findById = () => queryResult(run);
      currentUser = {
          _id: userId,
          plan: { _id: new mongoose.Types.ObjectId(), code: planCode },
          planExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
          dailyFileCredit: 0,
          fileCredits: 5,
          dailyFileCreditDate: vnDateString(),
      };
      User.findById = () => queryResult(currentUser);
      const result = await chargeCompletedConversion({
        runId: run._id,
        userId,
        idempotencyKey: run.usageIdempotencyKey,
        ...artifactProof(run),
      });
      assert.equal(result.charged, false);
      assert.equal(run.usageState, "charged");
    }
  } finally {
    restoreTransaction();
    restoreReadyState();
    restoreRun();
    restoreRunUpdate();
    restoreUser();
    restoreUpdate();
  }
});

test("charge failure prevents binary response", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const conversionArtifacts = require("../services/conversionArtifactService");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "export-failure" });
  const restoreReadyState = readyMongoConnection();
  const previous = {
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
  };
  let storedArtifact = null;
  const received = await listen((_req, res) => {
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", 'attachment; filename="result.xls"');
    res.end(Buffer.from("must-not-reach-client"));
  });
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreRunById = patchValue(ConversionRun, "findById", () => queryResult(run));
  const restoreUser = patchValue(
    User,
    "findById",
    () =>
      queryResult({
        _id: userId,
        plan: { code: "free" },
        dailyFileCredit: 0,
        fileCredits: 0,
        dailyFileCreditDate: vnDateString(),
      }),
  );
  const restoreUserUpdate = patchValue(User, "findOneAndUpdate", async () => null);
  const restoreRunUsageUpdate = patchValue(
    ConversionRun,
    "findOneAndUpdate",
    async (_filter, update) => {
      Object.assign(run, update.$set);
      return run;
    },
  );
  const restoreUpdate = patchValue(ConversionRun, "updateOne", async () => ({ modifiedCount: 1 }));
  const restoreArtifactPut = patchValue(conversionArtifacts, "putArtifact", async (input) => {
    const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
    storedArtifact = {
      metadata: {
        ...input,
        storageKey:
          `sessions/${input.sessionId}/runs/${input.runId}/${input.kind}/r${input.revision}-${sha256}.bin`,
        sha256,
      },
      content: Buffer.from(input.content),
    };
    return storedArtifact.metadata;
  });
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "export-failure-secret";

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId: null,
      conversionContextId: run.conversionContextId,
      conversionRunId: run._id,
      operationSessionId: run.operationSessionId,
      uploadId: run.converterUploadId,
      targetTemplateId: run.targetTemplateId,
      scopes: ["export"],
    });
    const response = responseRecorder();
    await exportConversion(
      {
        requestId: "export-failure-request",
        user: { _id: userId },
        headers: {
          "x-conversion-context": contextToken,
          "idempotency-key": "export-failure",
        },
        body: {
          conversion_run_id: String(run._id),
          upload_id: run.converterUploadId,
          target_template_id: run.targetTemplateId,
        },
      },
      response,
    );
    assert.equal(response.statusCode, 402);
    assert.equal(Buffer.isBuffer(response.body), false);
    assert.deepEqual(storedArtifact.content, Buffer.from("must-not-reach-client"));
    assert.equal(storedArtifact.metadata.kind, "output");
  } finally {
    received.server.close();
    restoreTransaction();
    restoreReadyState();
    restoreRun();
    restoreRunById();
    restoreUser();
    restoreUserUpdate();
    restoreRunUsageUpdate();
    restoreUpdate();
    restoreArtifactPut();
    if (previous.internalUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previous.internalUrl;
    if (previous.serviceToken === undefined) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previous.serviceToken;
    if (previous.contextSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previous.contextSecret;
  }
});

test("run owner cannot export another user's upload", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const ownerId = new mongoose.Types.ObjectId();
  const foreignRunId = new mongoose.Types.ObjectId();
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(null));
  process.env.CONVERSION_CONTEXT_SECRET = "foreign-owner-secret";

  try {
    const contextToken = createConversionContextToken({
      userId: ownerId,
      workspaceId: null,
      conversionRunId: foreignRunId,
    });
    const response = responseRecorder();
    await exportConversion(
      {
        user: { _id: ownerId },
        headers: { "x-conversion-context": contextToken },
        body: {
          conversion_run_id: String(foreignRunId),
          upload_id: "foreign-upload",
          target_template_id: "bsn_sales",
        },
      },
      response,
    );
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.success, false);
  } finally {
    restoreRun();
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("export rejects a missing owned run before forwarding binary", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
  };
  let forwardCalls = 0;
  const received = await listen((_req, res) => {
    forwardCalls += 1;
    res.end(Buffer.from("must-not-forward"));
  });
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(null));
  process.env.CONVERSION_CONTEXT_SECRET = "missing-run-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;

  try {
    const contextToken = createConversionContextToken({ userId, workspaceId: null });
    const response = responseRecorder();
    await exportConversion(
      {
        user: { _id: userId },
        headers: { "x-conversion-context": contextToken },
        body: {},
      },
      response,
    );
    assert.equal(response.statusCode, 409);
    assert.equal(forwardCalls, 0);
  } finally {
    received.server.close();
    restoreRun();
    if (previous.contextSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previous.contextSecret;
    if (previous.internalUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previous.internalUrl;
  }
});

test("export rejects foreign persisted upload, template, and context before forwarding", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, { usageIdempotencyKey: "binding-check" });
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
  };
  let forwardCalls = 0;
  const received = await listen((_req, res) => {
    forwardCalls += 1;
    res.end(Buffer.from("must-not-forward"));
  });
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(run));
  process.env.CONVERSION_CONTEXT_SECRET = "binding-check-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;

  try {
    const cases = [
      ["upload_id", "foreign-upload"],
      ["target_template_id", "foreign-template"],
      ["conversion_context_id", "foreign-context"],
      ["session_id", "foreign-session"],
    ];
    for (const [field, value] of cases) {
      const contextToken = createConversionContextToken({
        userId,
        workspaceId: null,
        conversionContextId: run.conversionContextId,
        conversionRunId: run._id,
        operationSessionId: run.operationSessionId,
        uploadId: run.converterUploadId,
        targetTemplateId: run.targetTemplateId,
        scopes: ["export"],
      });
      const response = responseRecorder();
      await exportConversion(
        {
          user: { _id: userId },
          headers: { "x-conversion-context": contextToken },
          body: {
            conversion_run_id: String(run._id),
            upload_id: run.converterUploadId,
            target_template_id: run.targetTemplateId,
            [field]: value,
          },
        },
        response,
      );
      assert.equal(response.statusCode, 409);
    }
    assert.equal(forwardCalls, 0);
  } finally {
    received.server.close();
    restoreRun();
    if (previous.contextSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previous.contextSecret;
    if (previous.internalUrl === undefined) delete process.env.CONVERTER_INTERNAL_URL;
    else process.env.CONVERTER_INTERNAL_URL = previous.internalUrl;
  }
});

test("persisted user-scoped run cannot inherit workspace claims from its token", async () => {
  const AccountingWorkspace = require("../models/AccountingWorkspace");
  const { createConversionContextToken } = require("../services/conversionContextService");
  const { buildSnapshotSetHash } = require("../services/masterDataService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const snapshotSetHash = buildSnapshotSetHash([]);
  const run = newRun(userId, {
    usageIdempotencyKey: "workspace-claim-rejected",
    workspace: null,
    snapshotSetHash,
  });
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
  };
  let forwardCalls = 0;
  const received = await listen((_req, res) => {
    forwardCalls += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
  });
  const restoreRun = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreWorkspace = patchValue(
    AccountingWorkspace,
    "findOne",
    () => queryResult({
      _id: workspaceId,
      owner: userId,
      members: [],
      activeSnapshots: [],
      masterDataRevision: 0,
      isActive: true,
    }),
  );
  process.env.CONVERSION_CONTEXT_SECRET = "persisted-workspace-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  try {
    const contextToken = createConversionContextToken({
      userId,
      workspaceId,
      snapshotSetHash,
      snapshotIds: [],
      conversionContextId: run.conversionContextId,
      conversionRunId: run._id,
      operationSessionId: run.operationSessionId,
      uploadId: run.converterUploadId,
      targetTemplateId: run.targetTemplateId,
      scopes: ["export"],
    });
    const response = responseRecorder();
    await exportConversion(
      {
        requestId: "workspace-claim-request",
        user: { _id: userId },
        headers: { "x-conversion-context": contextToken },
        body: {
          conversion_run_id: String(run._id),
          upload_id: run.converterUploadId,
          target_template_id: run.targetTemplateId,
        },
      },
      response,
    );
    assert.equal(response.statusCode, 409);
    assert.equal(forwardCalls, 0);
  } finally {
    received.server.close();
    restoreRun();
    restoreWorkspace();
    for (const [name, value] of Object.entries({
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("export persists one artifact and replays it when Converter is unavailable", async () => {
  const { createConversionContextToken } = require("../services/conversionContextService");
  const conversionArtifacts = require("../services/conversionArtifactService");
  const { exportConversion } = require("../controllers/converterGatewayController");
  const userId = new mongoose.Types.ObjectId();
  const run = newRun(userId, {
    usageIdempotencyKey: "successful-export",
    status: "processing",
  });
  const output = Buffer.from("stable-binary-artifact");
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
    readyState: mongoose.connection.readyState,
  };
  let converterCalls = 0;
  let artifactObservedBeforeCharge = false;
  const artifacts = new Map();
  let artifactWrites = 0;
  const received = await listen((_req, res) => {
    converterCalls += 1;
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", 'attachment; filename="result.xls"');
    res.end(output);
  });
  const user = {
    _id: userId,
    plan: { _id: new mongoose.Types.ObjectId(), code: "perfile" },
    dailyFileCredit: 1,
    fileCredits: 0,
    dailyFileCreditDate: vnDateString(),
  };
  const restoreReadyState = readyMongoConnection();
  const restoreTransaction = patchValue(
    mongoose.connection,
    "transaction",
    async (callback) => callback({ transaction: true }),
  );
  const restoreRunFindOne = patchValue(ConversionRun, "findOne", () => queryResult(run));
  const restoreRunFindById = patchValue(ConversionRun, "findById", () => queryResult(run));
  const restoreUserFindById = patchValue(User, "findById", () => queryResult(user));
  const restoreUserUpdate = patchValue(User, "findOneAndUpdate", async (_filter, update) => {
    artifactObservedBeforeCharge = artifacts.size === 1;
    user.dailyFileCredit += Number(update.$inc?.dailyFileCredit || 0);
    return user;
  });
  const restoreRunUpdate = patchValue(
    ConversionRun,
    "findOneAndUpdate",
    async (_filter, update) => {
      Object.assign(run, update.$set);
      return run;
    },
  );
  const restoreArtifactPut = patchValue(conversionArtifacts, "putArtifact", async (input) => {
    artifactWrites += 1;
    const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
    const storageKey =
      `sessions/${input.sessionId}/runs/${input.runId}/${input.kind}/r${input.revision}-${sha256}.bin`;
    const metadata = { ...input, storageKey, sha256, sizeBytes: input.content.length };
    artifacts.set(storageKey, { metadata, content: Buffer.from(input.content) });
    return metadata;
  });
  const restoreArtifactGet = patchValue(conversionArtifacts, "getArtifact", async (input) => {
    const found = [...artifacts.values()].find(
      ({ metadata }) =>
        metadata.sessionId === input.sessionId &&
        metadata.runId === input.runId &&
        metadata.kind === input.kind,
    );
    if (!found) throw Object.assign(new Error("Artifact was not found"), { statusCode: 404 });
    return found;
  });
  process.env.CONVERSION_CONTEXT_SECRET = "artifact-replay-secret";
  process.env.CONVERTER_INTERNAL_URL = received.url;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  function requestContext() {
    return createConversionContextToken({
      userId,
      workspaceId: null,
      conversionContextId: run.conversionContextId,
      conversionRunId: run._id,
      operationSessionId: run.operationSessionId,
      uploadId: run.converterUploadId,
      targetTemplateId: run.targetTemplateId,
      scopes: ["export"],
    });
  }

  function request() {
    return {
      requestId: "artifact-replay-request",
      user: { _id: userId },
      headers: {
        "x-conversion-context": requestContext(),
        "idempotency-key": run.usageIdempotencyKey,
      },
      body: {
        conversion_run_id: String(run._id),
        upload_id: run.converterUploadId,
        target_template_id: run.targetTemplateId,
      },
    };
  }

  try {
    const first = responseRecorder();
    await exportConversion(request(), first);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, output);
    assert.equal(user.dailyFileCredit, 0);
    assert.equal(artifactObservedBeforeCharge, true);
    assert.equal(artifactWrites, 1);
    assert.equal(run.status, "completed");
    assert.ok(run.exportArtifactKey);
    assert.equal(artifacts.get(run.exportArtifactKey).content.toString(), output.toString());

    received.server.close();
    process.env.CONVERTER_INTERNAL_URL = "http://127.0.0.1:1";
    const replay = responseRecorder();
    await exportConversion(request(), replay);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body, output);
    assert.equal(converterCalls, 1);
    assert.equal(user.dailyFileCredit, 0);
  } finally {
    try { received.server.close(); } catch {}
    restoreReadyState();
    restoreTransaction();
    restoreRunFindOne();
    restoreRunFindById();
    restoreUserFindById();
    restoreUserUpdate();
    restoreRunUpdate();
    restoreArtifactPut();
    restoreArtifactGet();
    for (const [name, value] of Object.entries({
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    mongoose.connection.readyState = previous.readyState;
  }
});

test(
  "real Mongo charges duplicate exports once and rolls back failed transactions",
  {
    skip: mongoIntegrationUri ? false : "set CONVERSION_ENTITLEMENT_TEST_MONGO_URI",
    timeout: 30000,
  },
  async () => {
    const uri = uniqueMongoDatabaseUri(mongoIntegrationUri);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    try {
      await mongoose.connection.dropDatabase();
      const plan = await Plan.create({
        code: "perfile",
        name: "Gói lượt file",
        price: 1,
        displayPrice: "1",
        fileCredits: 0,
      });
      const user = await User.create({
        name: "Entitlement Integration",
        email: `conversion-entitlement-${process.pid}-${Date.now()}@example.com`,
        password: "password123",
        plan: plan._id,
        dailyFileCredit: 0,
        dailyFileCreditDate: vnDateString(),
        fileCredits: 1,
      });
      const run = await ConversionRun.create({
        user: user._id,
        fileName: "integration.xlsx",
        fileSizeBytes: 4,
        targetTemplateId: "bsn_sales",
        conversionContextId: "integration-context",
        operationSessionId: "integration-session",
        converterUploadId: "integration-upload",
        usageIdempotencyKey: "integration-charge-once",
        status: "processing",
        usageState: "chargeable",
      });
      const outputSha256 = "c".repeat(64);
      const artifactKey = `conversion-${run._id}-${outputSha256}.bin`;
      const { chargeCompletedConversion } = require("../services/conversionCreditService");

      const results = await Promise.all([
        chargeCompletedConversion({
          runId: run._id,
          userId: user._id,
          idempotencyKey: run.usageIdempotencyKey,
          artifactKey,
          outputSha256,
        }),
        chargeCompletedConversion({
          runId: run._id,
          userId: user._id,
          idempotencyKey: run.usageIdempotencyKey,
          artifactKey,
          outputSha256,
        }),
      ]);
      assert.equal(results.filter((result) => result.charged).length, 1);
      assert.equal(results.filter((result) => result.idempotent).length, 1);
      assert.equal(results[0].outputSha256, results[1].outputSha256);
      assert.equal((await User.findById(user._id)).fileCredits, 0);
      const chargedRun = await ConversionRun.findById(run._id);
      assert.equal(chargedRun.status, "completed");
      assert.equal(chargedRun.usageState, "charged");
      assert.equal(chargedRun.exportArtifactKey, artifactKey);

      const rollbackUser = await User.create({
        name: "Entitlement Rollback",
        email: `conversion-entitlement-rollback-${process.pid}-${Date.now()}@example.com`,
        password: "password123",
        plan: plan._id,
        dailyFileCredit: 0,
        dailyFileCreditDate: vnDateString(),
        fileCredits: 1,
      });
      const rollbackRun = await ConversionRun.create({
        user: rollbackUser._id,
        fileName: "rollback.xlsx",
        fileSizeBytes: 4,
        targetTemplateId: "bsn_sales",
        conversionContextId: "rollback-context",
        operationSessionId: "rollback-session",
        converterUploadId: "rollback-upload",
        usageIdempotencyKey: "integration-rollback",
        status: "processing",
        usageState: "chargeable",
      });
      const previousRunUpdate = ConversionRun.findOneAndUpdate;
      ConversionRun.findOneAndUpdate = () => {
        throw new Error("forced conversion run update failure");
      };
      try {
        await assert.rejects(
          chargeCompletedConversion({
            runId: rollbackRun._id,
            userId: rollbackUser._id,
            idempotencyKey: rollbackRun.usageIdempotencyKey,
            artifactKey: `conversion-${rollbackRun._id}-${outputSha256}.bin`,
            outputSha256,
          }),
          /forced conversion run update failure/,
        );
      } finally {
        ConversionRun.findOneAndUpdate = previousRunUpdate;
      }
      assert.equal((await User.findById(rollbackUser._id)).fileCredits, 1);
      const pendingRun = await ConversionRun.findById(rollbackRun._id);
      assert.equal(pendingRun.status, "processing");
      assert.equal(pendingRun.usageState, "chargeable");
    } finally {
      await mongoose.disconnect();
    }
  },
);
