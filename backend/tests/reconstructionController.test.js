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
  };
}

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
