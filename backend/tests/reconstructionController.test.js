const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const ConversionRun = require("../models/ConversionRun");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const ReconstructionProfile = require("../models/ReconstructionProfile");
const {
  checkInternalReconstructionProfile,
  createReconstructionRun,
  recordInternalReconstructionEvent,
} = require("../controllers/reconstructionController");
const {
  createReconstructionContextToken,
  verifyConversionContextToken,
} = require("../services/conversionContextService");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    setHeader() {},
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function routeByPath(router, path, method) {
  return router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
}

test("reconstruction router exposes one explicit gateway route per operation", () => {
  const routePath = require.resolve("../routes/reconstructions");
  const previousPublic = process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
  const previousUsageReady = process.env.CONVERTER_GATEWAY_USAGE_READY;
  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
  delete require.cache[routePath];

  try {
    const router = require(routePath);
    const expected = [
      ["/:id/operations/analyze", "post"],
      ["/:id/operations/drafts/:draftId", "patch"],
      ["/:id/operations/split", "post"],
      ["/:id/operations/merge", "post"],
      ["/:id/operations/validate", "post"],
      ["/:id/operations/approve", "post"],
      ["/:id/operations/export", "post"],
    ];
    for (const [path, method] of expected) {
      assert.ok(routeByPath(router, path, method), `${method.toUpperCase()} ${path}`);
    }
    assert.equal(
      router.stack.filter((layer) => layer.route?.path?.includes("/operations/")).length,
      expected.length,
    );
  } finally {
    delete require.cache[routePath];
    if (previousPublic === undefined) delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    else process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previousPublic;
    if (previousUsageReady === undefined) delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    else process.env.CONVERTER_GATEWAY_USAGE_READY = previousUsageReady;
  }
});

test("reconstruction gateway verifies run ownership and forwards only operation keys", async () => {
  const gateway = require("../services/converterGatewayService");
  const routePath = require.resolve("../routes/reconstructions");
  const previousForwardJson = gateway.forwardJson;
  const previousFindOne = VoucherReconstructionRun.findOne;
  const previousPublic = process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
  const previousUsageReady = process.env.CONVERTER_GATEWAY_USAGE_READY;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  const conversionRunId = new mongoose.Types.ObjectId();
  let capturedRequest;
  let capturedQuery;

  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
  process.env.CONVERSION_CONTEXT_SECRET = "reconstruction-forwarding-secret";
  gateway.forwardJson = async (request) => {
    capturedRequest = request;
    return { status: 200, headers: {}, data: { success: true } };
  };
  VoucherReconstructionRun.findOne = async (query) => {
    capturedQuery = query;
    return {
      _id: runId,
      user: userId,
      workspace: workspaceId,
      targetTemplateId: "bsn_purchase",
      conversionRun: conversionRunId,
      snapshotSetHash: "snapshot-hash",
      workspaceRevision: 3,
      expiresAt: new Date(Date.now() + 60_000),
    };
  };
  delete require.cache[routePath];

  try {
    const token = createReconstructionContextToken({
      userId,
      runId,
      workspaceId,
      scopes: ["approve"],
    });
    const router = require(routePath);
    const route = routeByPath(router, "/:id/operations/approve", "post");
    assert.ok(route);
    const handler = route.route.stack.at(-1).handle;
    const req = {
      body: {
        acknowledge_warnings: true,
        context_token: token,
        ownerScope: "workspace:attacker",
      },
      headers: { "x-reconstruction-context": token },
      method: "POST",
      params: { id: String(runId) },
      requestId: "reconstruction-forward-request",
      user: { _id: userId },
    };
    await handler(req, responseRecorder(), (error) => {
      throw error;
    });

    assert.equal(String(capturedQuery._id), String(runId));
    assert.equal(String(capturedQuery.user), String(userId));
    assert.ok(capturedQuery.expiresAt.$gt instanceof Date);
    assert.deepEqual(capturedRequest.body, { acknowledge_warnings: true });
    assert.equal(
      capturedRequest.path,
      `/api/v1/reconstructions/${runId}/approve`,
    );
    assert.equal(capturedRequest.extraHeaders["x-reconstruction-context"], token);
    const claims = verifyConversionContextToken(capturedRequest.contextToken);
    assert.equal(claims.owner_scope, `workspace:${workspaceId}`);
    assert.equal(claims.conversion_run_id, String(conversionRunId));
    assert.equal(claims.operation_session_id, String(runId));
  } finally {
    gateway.forwardJson = previousForwardJson;
    VoucherReconstructionRun.findOne = previousFindOne;
    delete require.cache[routePath];
    if (previousPublic === undefined) delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    else process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previousPublic;
    if (previousUsageReady === undefined) delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    else process.env.CONVERTER_GATEWAY_USAGE_READY = previousUsageReady;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("create reconstruction run returns scoped converter context", async () => {
  process.env.CONVERSION_CONTEXT_SECRET = "controller-secret";
  const originalConversionCreate = ConversionRun.create;
  const originalReconstructionCreate = VoucherReconstructionRun.create;
  const userId = new mongoose.Types.ObjectId();
  const conversionId = new mongoose.Types.ObjectId();
  const reconstructionId = new mongoose.Types.ObjectId();
  const conversion = {
    _id: conversionId,
    reconstructionRun: null,
    async save() {},
  };
  ConversionRun.create = async () => conversion;
  VoucherReconstructionRun.create = async (payload) => ({
    _id: reconstructionId,
    ...payload,
    status: "created",
    engineVersion: "phase3-v1",
    createdAt: new Date(),
  });
  const req = {
    body: {
      fileName: "purchase.xlsx",
      fileSizeBytes: 1024,
      mode: "purchase",
    },
    user: { _id: userId, name: "User", email: "user@example.com" },
  };
  const res = responseRecorder();
  try {
    await createReconstructionRun(req, res);
  } finally {
    ConversionRun.create = originalConversionCreate;
    VoucherReconstructionRun.create = originalReconstructionCreate;
  }

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.run.id, String(reconstructionId));
  assert.ok(res.payload.contextToken);
  assert.equal(conversion.reconstructionRun, reconstructionId);
});

test("beta allowlist rejects workspaces that are not enabled", async () => {
  process.env.CONVERSION_CONTEXT_SECRET = "controller-secret";
  process.env.RECONSTRUCTION_BETA_WORKSPACE_IDS = String(
    new mongoose.Types.ObjectId(),
  );
  const req = {
    body: {
      fileName: "purchase.xlsx",
      fileSizeBytes: 1024,
      mode: "purchase",
    },
    user: {
      _id: new mongoose.Types.ObjectId(),
      name: "User",
      email: "user@example.com",
    },
  };
  const res = responseRecorder();
  try {
    await createReconstructionRun(req, res);
  } finally {
    delete process.env.RECONSTRUCTION_BETA_WORKSPACE_IDS;
  }

  assert.equal(res.statusCode, 403);
  assert.match(res.payload.message, /chưa được bật thử nghiệm/i);
});

test("exported event is idempotent before charging credit again", async () => {
  process.env.CONVERSION_CONTEXT_SECRET = "controller-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  const runId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const token = createReconstructionContextToken({
    userId,
    runId,
    expiresIn: "1h",
  });
  const originalFindById = VoucherReconstructionRun.findById;
  VoucherReconstructionRun.findById = async () => ({
    _id: runId,
    user: userId,
    status: "exported",
    fileName: "purchase.xlsx",
    fileSizeBytes: 1,
    conversionRun: new mongoose.Types.ObjectId(),
  });
  const req = {
    params: { id: String(runId) },
    body: { event: "exported", idempotencyKey: "same-export" },
    headers: {
      "x-converter-service-token": "service-secret",
      "x-reconstruction-context": token,
    },
  };
  const res = responseRecorder();
  try {
    await recordInternalReconstructionEvent(req, res);
  } finally {
    VoucherReconstructionRun.findById = originalFindById;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.idempotent, true);
});

test("analysis event attaches and counts the approved profile once", async () => {
  process.env.CONVERSION_CONTEXT_SECRET = "controller-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  const runId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const conversionId = new mongoose.Types.ObjectId();
  const token = createReconstructionContextToken({
    userId,
    runId,
    workspaceId,
    expiresIn: "1h",
  });
  const run = {
    _id: runId,
    user: userId,
    workspace: workspaceId,
    conversionRun: conversionId,
    status: "analyzing",
    profile: null,
    async save() {},
  };
  const profile = {
    _id: profileId,
    workspace: workspaceId,
    sourceSignatureHash: "signature-1",
    status: "active",
    version: 3,
    usageCount: 0,
    reviewCount: 0,
    async save() {},
  };
  const originalRunFind = VoucherReconstructionRun.findById;
  const originalProfileFind = ReconstructionProfile.findOne;
  const originalConversionUpdate = ConversionRun.findByIdAndUpdate;
  VoucherReconstructionRun.findById = async () => run;
  ReconstructionProfile.findOne = async () => profile;
  ConversionRun.findByIdAndUpdate = async () => ({ _id: conversionId });
  const req = {
    params: { id: String(runId) },
    body: {
      event: "analysis_completed",
      sourceSignatureHash: "signature-1",
      profileId: String(profileId),
      profileVersion: 3,
      summary: { review: 2 },
    },
    headers: {
      "x-converter-service-token": "service-secret",
      "x-reconstruction-context": token,
    },
  };
  const res = responseRecorder();
  try {
    await recordInternalReconstructionEvent(req, res);
  } finally {
    VoucherReconstructionRun.findById = originalRunFind;
    ReconstructionProfile.findOne = originalProfileFind;
    ConversionRun.findByIdAndUpdate = originalConversionUpdate;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(String(run.profile), String(profileId));
  assert.equal(run.profileVersion, 3);
  assert.equal(profile.usageCount, 1);
  assert.equal(profile.reviewCount, 1);
});

test("internal profile status rejects a stale profile version", async () => {
  process.env.CONVERSION_CONTEXT_SECRET = "controller-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  const runId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const token = createReconstructionContextToken({
    userId,
    runId,
    workspaceId,
    expiresIn: "1h",
  });
  const originalFind = ReconstructionProfile.findOne;
  ReconstructionProfile.findOne = async () => ({
    _id: profileId,
    workspace: workspaceId,
    status: "active",
    version: 2,
  });
  const req = {
    params: { profileId: String(profileId) },
    query: { version: "1" },
    headers: {
      "x-converter-service-token": "service-secret",
      "x-reconstruction-context": token,
    },
  };
  const res = responseRecorder();
  try {
    await checkInternalReconstructionProfile(req, res);
  } finally {
    ReconstructionProfile.findOne = originalFind;
  }

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.message, /đã thay đổi/i);
});
