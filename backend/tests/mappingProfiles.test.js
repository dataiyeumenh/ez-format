const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const MappingProfile = require("../models/MappingProfile");
const {
  authenticateInternalContext,
} = require("../controllers/accountingWorkspaceController");
const {
  createConversionContextToken,
} = require("../services/conversionContextService");
const {
  cleanMappingProfilePayload,
  serializeMappingProfile,
} = require("../services/mappingProfileService");

test("mapping profile is scoped by workspace, template and source signature", () => {
  const workspace = new mongoose.Types.ObjectId();
  const user = new mongoose.Types.ObjectId();
  const profile = new MappingProfile({
    workspace,
    updatedBy: user,
    name: "KiotViet mua hàng",
    targetTemplateId: "misa_purchase_domestic",
    sourceSignatureHash: "signature-1",
    sourceHeaders: ["Số hóa đơn", "Mã hàng"],
    mapping: { "Số hóa đơn": "Số chứng từ (*)" },
  });

  assert.equal(profile.validateSync(), undefined);
  const uniqueIndex = MappingProfile.schema
    .indexes()
    .find(
      ([fields, options]) =>
        fields.workspace === 1 &&
        fields.targetTemplateId === 1 &&
        fields.sourceSignatureHash === 1 &&
        options.unique,
    );
  assert.ok(uniqueIndex);
});

test("mapping profile payload drops unsupported values and serializes safely", () => {
  const payload = cleanMappingProfilePayload({
    name: "  Thiết lập BAE  ",
    targetTemplateId: "bsn_purchase",
    sourceSignatureHash: "hash-1",
    sourceHeaders: ["Mã NCC", null, "Mã hàng"],
    headerRow: 0,
    mapping: { "Mã NCC": "Mã nhà cung cấp" },
    defaults: [],
    confidence: 2,
  });
  assert.equal(payload.name, "Thiết lập BAE");
  assert.deepEqual(payload.sourceHeaders, ["Mã NCC", "Mã hàng"]);
  assert.equal(payload.headerRow, 1);
  assert.deepEqual(payload.defaults, {});
  assert.equal(payload.confidence, 1);

  const serialized = serializeMappingProfile({
    _id: "profile-1",
    workspace: "workspace-1",
    ...payload,
  });
  assert.equal(serialized.id, "profile-1");
  assert.equal(serialized.workspaceId, "workspace-1");
});

test("internal context requires service token and verifies conversion claims", () => {
  const previousContextSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  try {
    const contextToken = createConversionContextToken({
      userId: "user-1",
      workspaceId: "workspace-1",
      snapshotSetHash: "snapshot-hash",
      masterDataRevision: 2,
    });
    const claims = authenticateInternalContext({
      headers: {
        "x-converter-service-token": "service-secret",
        "x-conversion-context": contextToken,
      },
    });
    assert.equal(claims.workspace_id, "workspace-1");
    assert.equal(claims.master_data_revision, 2);

    assert.throws(
      () =>
        authenticateInternalContext({
          headers: {
            "x-converter-service-token": "wrong",
            "x-conversion-context": contextToken,
          },
        }),
      (error) => error.statusCode === 401,
    );
  } finally {
    if (previousContextSecret === undefined)
      delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousContextSecret;
    if (previousServiceToken === undefined)
      delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
  }
});
