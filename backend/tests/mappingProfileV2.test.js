const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const MappingProfileV2 = require("../models/MappingProfileV2");
const {
  activateProfile,
  confirmProfile,
  buildProfileKey,
  buildStateHash,
  classifyProfileMatch,
  createDraft,
  createVersion,
  detectRiskFlags,
  getProfileHistory,
  matchProfiles,
  quarantineProfile,
  recordConfirmedExport,
} = require("../services/mappingProfileV2Service");
const {
  resolvePublicOwnerAccess,
} = require("../controllers/mappingProfileV2Controller");
const mappingProfilesV2Router = require("../routes/mappingProfilesV2");

function id() {
  return new mongoose.Types.ObjectId().toString();
}

function identity(overrides = {}) {
  return {
    sourceFamily: "invoice_export_x",
    documentType: "purchase_goods",
    headerFingerprint: "header-hash",
    dataShapeFingerprint: "shape-hash",
    targetTemplateId: "misa_purchase_domestic",
    targetTemplateVersion: "template-hash",
    ...overrides,
  };
}

function profile(overrides = {}) {
  const ownerScope = `workspace:${id()}`;
  const user = id();
  const base = {
    _id: id(),
    ownerScope,
    profileFamilyId: crypto.randomUUID(),
    version: 1,
    status: "draft",
    name: "Mua vào",
    ...identity(),
    mapping: { "Số hóa đơn": "Số chứng từ (*)" },
    defaults: {},
    formulas: {},
    riskFlags: [],
    user,
    createdBy: user,
  };
  const result = { ...base, ...overrides };
  result.profileKey = result.profileKey || buildProfileKey(result);
  result.stateHash = result.stateHash || buildStateHash(result);
  return result;
}

const crypto = require("node:crypto");

test("MappingProfileV2 enforces owner format, immutable content, and active uniqueness", () => {
  assert.equal(MappingProfileV2.schema.options.autoIndex, false);
  const document = new MappingProfileV2(profile());
  assert.equal(document.validateSync(), undefined);

  const invalid = new MappingProfileV2(profile({ ownerScope: "workspace:not-an-id" }));
  assert.match(invalid.validateSync().errors.ownerScope.message, /owner scope/i);

  for (const path of [
    "profileFamilyId",
    "version",
    "sourceFamily",
    "documentType",
    "headerFingerprint",
    "dataShapeFingerprint",
    "targetTemplateId",
    "targetTemplateVersion",
    "mapping",
    "defaults",
    "formulas",
  ]) {
    assert.equal(MappingProfileV2.schema.path(path).options.immutable, true, path);
  }

  const activeIndex = MappingProfileV2.schema.indexes().find(
    ([fields, options]) =>
      fields.ownerScope === 1 &&
      fields.profileFamilyId === 1 &&
      options.unique === true &&
      options.partialFilterExpression?.status === "active",
  );
  assert.ok(activeIndex);
});

test("semantic quarantine persists status and excludes profile from active use", async () => {
  const current = profile({ status: "active" });
  let captured;
  const model = {
    async findOneAndUpdate(filter, update) {
      captured = { filter, update };
      return {
        ...current,
        ...update.$set,
      };
    },
  };

  const quarantined = await quarantineProfile({
    model,
    ownerScope: current.ownerScope,
    profileId: current._id,
    reason: "semantic_validation_failed:mapping_domain_mismatch",
  });

  assert.equal(quarantined.status, "quarantined");
  assert.equal(captured.filter.ownerScope, current.ownerScope);
  assert.deepEqual(captured.filter.status.$in, ["active", "draft"]);
  assert.match(captured.update.$set.quarantineReason, /mapping_domain_mismatch/);
});

test("profile hashes are deterministic and high-risk fields are server-detected", () => {
  const a = { ...identity(), mapping: { B: "TK Nợ", A: "Thuế suất GTGT" } };
  const b = { ...identity(), mapping: { A: "Thuế suất GTGT", B: "TK Nợ" } };
  assert.equal(buildProfileKey(a), buildProfileKey(b));
  assert.equal(buildStateHash(a), buildStateHash(b));
  assert.deepEqual(
    detectRiskFlags({
      mapping: a.mapping,
      defaults: { "Thành tiền": 1000, "Loại chứng từ": "Mua hàng" },
      formulas: { "Số lượng": "-${Số lượng}" },
    }),
    ["account", "document_classification", "money", "sign", "vat"],
  );
});

test("matching separates exact, compatible, review, and rejected profiles", () => {
  const candidate = profile({ status: "active" });
  assert.equal(classifyProfileMatch(candidate, identity()).tier, "exact");
  assert.equal(
    classifyProfileMatch(candidate, identity({ headerFingerprint: "reordered" })).tier,
    "review",
  );
  assert.equal(
    classifyProfileMatch(
      candidate,
      identity({
        headerFingerprint: "reordered",
        headerCompatibility: "safe",
      }),
    ).tier,
    "compatible",
  );
  assert.equal(
    classifyProfileMatch(candidate, identity({ dataShapeFingerprint: "changed" })).tier,
    "review",
  );
  assert.equal(
    classifyProfileMatch(candidate, identity({ documentType: "sales_goods" })).tier,
    "rejected",
  );
});

test("matching and history always include the signed owner scope", async () => {
  const ownerScope = `workspace:${id()}`;
  const calls = [];
  const active = profile({ ownerScope, status: "active" });
  const model = {
    async find(filter, _projection, options) {
      calls.push({ method: "find", filter, options });
      return [active];
    },
  };

  const match = await matchProfiles({ model, ownerScope, identity: identity() });
  const history = await getProfileHistory({
    model,
    ownerScope,
    profileFamilyId: active.profileFamilyId,
  });

  assert.equal(match.tier, "exact");
  assert.equal(history.length, 1);
  assert.ok(calls.every((call) => call.filter.ownerScope === ownerScope));
});

test("matching separates explicitly approved risk from unapproved risk and drift", async () => {
  const ownerScope = `workspace:${id()}`;
  const approved = profile({
    ownerScope,
    status: "active",
    approvedBy: id(),
    riskFlags: ["vat"],
  });
  const model = { find: async () => [approved] };

  const exact = await matchProfiles({ model, ownerScope, identity: identity() });
  assert.deepEqual(
    {
      approvalState: exact.approvalState,
      approvalAppliesToMatch: exact.approvalAppliesToMatch,
      riskFlags: exact.riskFlags,
      approvedRiskFlags: exact.approvedRiskFlags,
      unapprovedRiskFlags: exact.unapprovedRiskFlags,
      canSuggest: exact.canSuggest,
      requiresPreview: exact.requiresPreview,
    },
    {
      approvalState: "approved",
      approvalAppliesToMatch: true,
      riskFlags: ["vat"],
      approvedRiskFlags: ["vat"],
      unapprovedRiskFlags: [],
      canSuggest: true,
      requiresPreview: true,
    },
  );

  const drifted = await matchProfiles({
    model,
    ownerScope,
    identity: identity({ dataShapeFingerprint: "changed" }),
  });
  assert.equal(drifted.tier, "review");
  assert.equal(drifted.approvalState, "approved");
  assert.equal(drifted.approvalAppliesToMatch, false);
  assert.deepEqual(drifted.approvedRiskFlags, []);
  assert.deepEqual(drifted.unapprovedRiskFlags, ["vat"]);
  assert.equal(drifted.canSuggest, false);

  approved.approvedBy = null;
  const unapproved = await matchProfiles({ model, ownerScope, identity: identity() });
  assert.equal(unapproved.tier, "exact");
  assert.equal(unapproved.approvalState, "unapproved");
  assert.equal(unapproved.approvalAppliesToMatch, false);
  assert.deepEqual(unapproved.approvedRiskFlags, []);
  assert.deepEqual(unapproved.unapprovedRiskFlags, ["vat"]);
  assert.equal(unapproved.canSuggest, false);
});

test("draft creation and editing create immutable increasing versions", async () => {
  const ownerScope = `workspace:${id()}`;
  const createdBy = id();
  const stored = [];
  const model = {
    async create(value) {
      const saved = { _id: id(), ...value };
      stored.push(saved);
      return saved;
    },
    async findOne(filter, _projection, options = {}) {
      const matches = stored.filter((item) =>
        Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)),
      );
      if (options.sort?.version === -1) {
        matches.sort((a, b) => b.version - a.version);
      }
      return matches[0] || null;
    },
  };

  const first = await createDraft({
    model,
    ownerScope,
    createdBy,
    payload: { name: "Nguồn A", ...identity(), mapping: {}, defaults: {}, formulas: {} },
  });
  const second = await createVersion({
    model,
    ownerScope,
    profileId: first._id,
    createdBy,
    patch: { name: "Nguồn A v2", mapping: { A: "B" } },
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.status, "draft");
  assert.equal(second.profileFamilyId, first.profileFamilyId);
  assert.equal(first.name, "Nguồn A");

  await assert.rejects(
    () => createVersion({
      model,
      ownerScope,
      profileId: first._id,
      createdBy,
      patch: { targetTemplateVersion: "template-v2" },
    }),
    (error) => error.statusCode === 400 && /identity/i.test(error.message),
  );
});

test("confirming a V2 candidate creates and activates the next immutable version", async () => {
  const ownerScope = `workspace:${id()}`;
  const active = profile({ ownerScope, status: "active", version: 1 });
  const docs = [active];
  let draft = null;
  const model = {
    db: { transaction: async (work) => work({ transaction: true }) },
    async findOne(filter, _projection, options = {}) {
      const matches = docs.filter((item) =>
        Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)),
      );
      if (options.sort?.version === -1) matches.sort((a, b) => b.version - a.version);
      return matches[0] || null;
    },
    async create(value) {
      draft = { _id: id(), ...value };
      docs.push(draft);
      return draft;
    },
    async updateOne(filter, update) {
      const item = docs.find((candidate) =>
        Object.entries(filter).every(([key, value]) => String(candidate[key]) === String(value)),
      );
      if (!item) return { modifiedCount: 0 };
      Object.assign(item, update.$set || {});
      return { modifiedCount: 1 };
    },
  };

  const result = await confirmProfile({
    model,
    ownerScope,
    profileId: active._id,
    sourceSignatureHash: active.headerFingerprint,
    targetTemplateId: active.targetTemplateId,
    mapping: { "Số hóa đơn": "Số chứng từ (*)" },
    defaults: {},
    formulas: {},
    expectedVersion: 1,
    userCorrection: true,
    approvedBy: active.createdBy,
  });

  assert.equal(result.status, "active");
  assert.equal(result.version, 2);
  assert.equal(result.previousVersion, active._id);
  assert.equal(result.stateHash, buildStateHash(result));
  assert.equal(draft.status, "active");
  assert.equal(active.status, "superseded");
});

test("activation atomically supersedes the expected active version and rejects stale state", async () => {
  const ownerScope = `workspace:${id()}`;
  const active = profile({ ownerScope, status: "active", version: 1 });
  const draft = profile({
    ownerScope,
    profileFamilyId: active.profileFamilyId,
    profileKey: "corrupt-different-key",
    status: "draft",
    version: 2,
  });
  draft.stateHash = buildStateHash(draft);
  const docs = [active, draft];
  const model = {
    db: { transaction: async (work) => work({ transaction: true }) },
    async findOne(filter) {
      return docs.find((item) =>
        Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)),
      ) || null;
    },
    async updateOne(filter, update) {
      const item = docs.find((candidate) =>
        Object.entries(filter).every(([key, value]) => String(candidate[key]) === String(value)),
      );
      if (!item) return { modifiedCount: 0 };
      Object.assign(item, update.$set || {});
      return { modifiedCount: 1 };
    },
  };

  const activated = await activateProfile({
    model,
    ownerScope,
    profileId: draft._id,
    stateHash: draft.stateHash,
    expectedPreviousVersion: 1,
    approvedBy: id(),
  });
  assert.equal(activated.status, "active");
  assert.equal(active.status, "superseded");

  await assert.rejects(
    () => activateProfile({
      model,
      ownerScope,
      profileId: draft._id,
      stateHash: "stale",
      expectedPreviousVersion: 1,
      approvedBy: id(),
    }),
    (error) => error.statusCode === 409,
  );
});

test("internal confirmation creates and activates a new immutable version", async () => {
  const ownerScope = `workspace:${id()}`;
  const createdBy = id();
  const stored = [];
  const model = {
    async create(value) {
      const saved = { _id: id(), ...value };
      stored.push(saved);
      return saved;
    },
    async findOne(filter, _projection, options = {}) {
      const matches = stored.filter((item) =>
        Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)),
      );
      if (options.sort?.version === -1) matches.sort((a, b) => b.version - a.version);
      return matches[0] || null;
    },
    async updateOne(filter, update) {
      const item = stored.find((candidate) =>
        Object.entries(filter).every(([key, value]) => String(candidate[key]) === String(value)),
      );
      if (!item) return { modifiedCount: 0 };
      Object.assign(item, update.$set || {});
      return { modifiedCount: 1 };
    },
  };
  const candidate = await createDraft({
    model,
    ownerScope,
    createdBy,
    payload: { name: "Nguồn A", ...identity(), mapping: {}, defaults: {}, formulas: {} },
  });
  const confirmed = await confirmProfile({
    model,
    ownerScope,
    profileId: candidate._id,
    sourceSignatureHash: candidate.headerFingerprint,
    targetTemplateId: candidate.targetTemplateId,
    mapping: { "Mã hàng": "Mã hàng (*)" },
    defaults: {},
    formulas: {},
    expectedVersion: 1,
    userCorrection: true,
    approvedBy: createdBy,
  });
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.version, 2);
  assert.equal(stored.filter((item) => item.status === "active").length, 1);
  assert.notEqual(confirmed.stateHash, candidate.stateHash);
});

test("confirmed export requires matching immutable version/state and is idempotent", async () => {
  const ownerScope = `workspace:${id()}`;
  const active = profile({ ownerScope, status: "active", version: 3 });
  active.confirmedExportIds = [];
  active.confirmationCount = 0;
  const model = {
    async findOneAndUpdate(filter, update) {
      if (
        String(filter._id) !== String(active._id) ||
        filter.ownerScope !== ownerScope ||
        filter.status !== "active" ||
        filter.version !== active.version ||
        filter.stateHash !== active.stateHash ||
        active.confirmedExportIds.includes(filter.confirmedExportIds.$ne)
      ) return null;
      active.confirmedExportIds.push(update.$addToSet.confirmedExportIds);
      active.confirmationCount += update.$inc.confirmationCount;
      active.lastConfirmedAt = update.$set.lastConfirmedAt;
      return active;
    },
    async findOne(filter) {
      return String(filter._id) === String(active._id) && filter.ownerScope === ownerScope
        ? active
        : null;
    },
  };

  const first = await recordConfirmedExport({
    model,
    ownerScope,
    profileId: active._id,
    exportId: "export-1",
    version: 3,
    stateHash: active.stateHash,
  });
  const repeated = await recordConfirmedExport({
    model,
    ownerScope,
    profileId: active._id,
    exportId: "export-1",
    version: 3,
    stateHash: active.stateHash,
  });

  assert.equal(first.recorded, true);
  assert.equal(repeated.recorded, false);
  assert.equal(active.confirmationCount, 1);
  await assert.rejects(
    () => recordConfirmedExport({
      model,
      ownerScope,
      profileId: active._id,
      exportId: "export-2",
      version: 2,
      stateHash: active.stateHash,
    }),
    (error) => error.statusCode === 409,
  );
});

test("public owner resolution never trusts owner_scope and denies foreign workspaces", async () => {
  const userId = id();
  const workspaceId = id();
  const foreignOwner = id();
  const workspaceModel = {
    async findOne() {
      return { _id: workspaceId, owner: foreignOwner, members: [], isActive: true };
    },
  };

  await assert.rejects(
    () => resolvePublicOwnerAccess({
      user: { _id: userId, role: "user" },
      workspaceId,
      requireEdit: true,
      workspaceModel,
    }),
    (error) => error.statusCode === 403,
  );

  const personal = await resolvePublicOwnerAccess({
    user: { _id: userId, role: "user" },
    workspaceId: null,
    requestedOwnerScope: `user:${foreignOwner}`,
    workspaceModel,
  });
  assert.equal(personal.ownerScope, `user:${userId}`);
});

test("Mapping Profile V2 router exposes lifecycle endpoints", () => {
  const routes = mappingProfilesV2Router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.deepEqual(routes, [
    "POST /match",
    "POST /",
    "POST /:id/versions",
    "POST /:id/activate",
    "POST /:id/suspend",
    "GET /",
    "GET /:id/history",
  ]);
});

test("internal Mapping Profile V2 router exposes the confirm endpoint", () => {
  const routes = mappingProfilesV2Router.internalRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(routes.includes("POST /confirm"));
});
