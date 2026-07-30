const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const MappingProfile = require("../models/MappingProfile");
const {
  authenticateInternalContext,
  findInternalMappingProfile,
  getInternalMappingProfile,
  markInternalMappingProfileUsed,
  saveInternalMappingProfile,
} = require("../controllers/accountingWorkspaceController");
const {
  createConversionContextToken,
  createStudentContextToken,
} = require("../services/conversionContextService");
const {
  cleanMappingProfilePayload,
  serializeMappingProfile,
} = require("../services/mappingProfileService");

test("mapping profile is scoped by owner, template and source signature", () => {
  assert.equal(MappingProfile.schema.options.autoIndex, false);
  const workspace = new mongoose.Types.ObjectId();
  const user = new mongoose.Types.ObjectId();
  const profile = new MappingProfile({
    ownerScope: `workspace:${workspace}`,
    workspace,
    user,
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
        fields.ownerScope === 1 &&
        fields.targetTemplateId === 1 &&
        fields.sourceSignatureHash === 1 &&
        options.unique,
  );
  assert.ok(uniqueIndex);

  const missingOwner = new MappingProfile({
    updatedBy: user,
    name: "Missing owner",
    targetTemplateId: "misa_purchase_domestic",
    sourceSignatureHash: "signature-2",
  });
  assert.match(
    missingOwner.validateSync().errors.ownerScope.message,
    /owner scope/i,
  );
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
    ownerScope: "workspace:workspace-1",
    workspace: "workspace-1",
    user: "user-1",
    ...payload,
  });
  assert.equal(serialized.id, "profile-1");
  assert.equal(serialized.ownerScope, "workspace:workspace-1");
  assert.equal(serialized.workspaceId, "workspace-1");
  assert.equal(serialized.userId, "user-1");
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function internalRequest(token, overrides = {}) {
  return {
    headers: {
      "x-converter-service-token": "service-secret",
      "x-conversion-context": token,
    },
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

test("mapping profile lookup/get/save/use stay bound to the signed student owner", async () => {
  const previousContextSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const originalFindOne = MappingProfile.findOne;
  const originalFindOneAndUpdate = MappingProfile.findOneAndUpdate;
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";

  const profileId = new mongoose.Types.ObjectId().toString();
  const ownerA = "user:user-a";
  const ownerB = "user:user-b";
  const storedProfile = {
    _id: profileId,
    ownerScope: ownerA,
    user: "user-a",
    workspace: null,
    name: "Student mapping",
    targetTemplateId: "bsn_purchase",
    sourceSignatureHash: "signature-1",
  };
  const findFilters = [];
  const updateCalls = [];
  MappingProfile.findOne = async (filter) => {
    findFilters.push(filter);
    return filter.ownerScope === ownerA ? storedProfile : null;
  };
  MappingProfile.findOneAndUpdate = async (filter, update) => {
    updateCalls.push({ filter, update });
    return filter.ownerScope === ownerA ? { ...storedProfile, ...update.$set } : null;
  };

  const tokenFor = (userId, ownerScope, allowedScopes) =>
    createStudentContextToken({
      sessionId: `session-${userId}`,
      userId,
      ownerScope,
      allowedScopes,
    });

  try {
    const analyzeA = tokenFor("user-a", ownerA, ["analyze"]);
    const analyzeB = tokenFor("user-b", ownerB, ["analyze"]);
    const accountingMapA = tokenFor("user-a", ownerA, ["accounting_map"]);
    const exportA = tokenFor("user-a", ownerA, ["export"]);
    const exportB = tokenFor("user-b", ownerB, ["export"]);

    const findA = responseRecorder();
    await findInternalMappingProfile(
      internalRequest(analyzeA, {
        query: {
          targetTemplateId: "bsn_purchase",
          sourceSignatureHash: "signature-1",
        },
      }),
      findA,
    );
    assert.equal(findA.statusCode, 200);
    assert.equal(findA.body.profile.ownerScope, ownerA);

    const findB = responseRecorder();
    await findInternalMappingProfile(
      internalRequest(analyzeB, {
        query: {
          targetTemplateId: "bsn_purchase",
          sourceSignatureHash: "signature-1",
        },
      }),
      findB,
    );
    assert.equal(findB.body.profile, null);

    const getA = responseRecorder();
    await getInternalMappingProfile(
      internalRequest(exportA, { params: { profileId } }),
      getA,
    );
    assert.equal(getA.statusCode, 200);
    assert.equal(getA.body.profile.ownerScope, ownerA);

    const getB = responseRecorder();
    await getInternalMappingProfile(
      internalRequest(exportB, { params: { profileId } }),
      getB,
    );
    assert.equal(getB.statusCode, 404);

    const deniedSave = responseRecorder();
    await saveInternalMappingProfile(
      internalRequest(analyzeA, {
        body: {
          name: "Denied student mapping",
          targetTemplateId: "bsn_purchase",
          sourceSignatureHash: "signature-1",
        },
      }),
      deniedSave,
    );
    assert.equal(deniedSave.statusCode, 401);
    assert.equal(updateCalls.length, 0);

    const saveA = responseRecorder();
    await saveInternalMappingProfile(
      internalRequest(accountingMapA, {
        body: {
          name: "Student mapping",
          targetTemplateId: "bsn_purchase",
          sourceSignatureHash: "signature-1",
          mapping: { Source: "Target" },
        },
      }),
      saveA,
    );
    assert.equal(saveA.statusCode, 201);
    assert.equal(updateCalls.at(-1).filter.ownerScope, ownerA);
    assert.equal(updateCalls.at(-1).update.$set.ownerScope, ownerA);
    assert.equal(updateCalls.at(-1).update.$set.user, "user-a");
    assert.equal(updateCalls.at(-1).update.$set.workspace, null);

    const usedB = responseRecorder();
    await markInternalMappingProfileUsed(
      internalRequest(analyzeB, { params: { profileId } }),
      usedB,
    );
    assert.equal(usedB.statusCode, 404);

    assert.ok(findFilters.every((filter) => filter.ownerScope));
    assert.ok(updateCalls.every(({ filter }) => filter.ownerScope));
  } finally {
    MappingProfile.findOne = originalFindOne;
    MappingProfile.findOneAndUpdate = originalFindOneAndUpdate;
    if (previousContextSecret === undefined)
      delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousContextSecret;
    if (previousServiceToken === undefined)
      delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
  }
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
