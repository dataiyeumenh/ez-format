const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OWNER_SCOPE_UNIQUE_INDEX,
  OWNER_SCOPE_UNIQUE_INDEX_KEYS,
  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
  OBSOLETE_WORKSPACE_UNIQUE_INDEX_KEYS,
  buildLegacyOwnerScopeUpdate,
  migrateMappingProfileOwnerScope,
  planMappingProfileIndexMigration,
} = require("../services/mappingProfileMigrationService");

function recognizedObsoleteIndex(overrides = {}) {
  return {
    v: 2,
    name: OBSOLETE_WORKSPACE_UNIQUE_INDEX,
    key: OBSOLETE_WORKSPACE_UNIQUE_INDEX_KEYS,
    unique: true,
    ...overrides,
  };
}

test("mapping profile owner migration defaults to off without touching Mongo", async () => {
  let queried = false;
  const result = await migrateMappingProfileOwnerScope({
    model: {
      db: { readyState: 1 },
      find() {
        queried = true;
        throw new Error("off mode must not query Mongo");
      },
    },
  });

  assert.equal(result.mode, "off");
  assert.equal(result.skipped, true);
  assert.equal(queried, false);
});


test("legacy mapping owner migration prefers workspace and falls back to updatedBy", () => {
  assert.deepEqual(
    buildLegacyOwnerScopeUpdate({
      _id: "profile-workspace",
      workspace: "workspace-1",
      updatedBy: "user-1",
    }),
    {
      updateOne: {
        filter: {
          _id: "profile-workspace",
          $or: [
            { ownerScope: { $exists: false } },
            { ownerScope: null },
            { ownerScope: "" },
          ],
        },
        update: { $set: { ownerScope: "workspace:workspace-1" } },
      },
    },
  );
  assert.equal(
    buildLegacyOwnerScopeUpdate({
      _id: "profile-user",
      workspace: null,
      updatedBy: "user-2",
    }).updateOne.update.$set.ownerScope,
    "user:user-2",
  );
  assert.throws(
    () => buildLegacyOwnerScopeUpdate({ _id: "profile-orphan" }),
    /workspace or updatedBy/i,
  );
});


test("mapping profile index plan drops only the obsolete workspace unique index", () => {
  assert.deepEqual(
    planMappingProfileIndexMigration([
      { name: "_id_", key: { _id: 1 }, unique: true },
      {
        ...recognizedObsoleteIndex(),
        ns: "ezformat.mappingprofiles",
      },
      {
        name: "ownerScope_1_targetTemplateId_1_sourceSignatureHash_1",
        key: { ownerScope: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
        unique: true,
      },
    ]),
    {
      dropIndexNames: [OBSOLETE_WORKSPACE_UNIQUE_INDEX],
      createIndexes: [],
      incompatibleIndexNames: [],
    },
  );
});

test("mapping profile owner dry-run reports backfills and index drops without writes", async () => {
  const writes = [];
  const documents = [
    { _id: "profile-1", workspace: "workspace-1", updatedBy: "user-1" },
    { _id: "profile-2", workspace: null, updatedBy: "user-2" },
  ];
  const model = {
    db: { readyState: 1 },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => documents,
      };
    },
    async bulkWrite() {
      writes.push("bulkWrite");
    },
    collection: {
      async indexes() {
        return [recognizedObsoleteIndex()];
      },
      async dropIndex() {
        writes.push("dropIndex");
      },
    },
    async syncIndexes() {
      writes.push("syncIndexes");
    },
  };

  const result = await migrateMappingProfileOwnerScope({ model, mode: "dry-run" });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.plannedBackfills, 2);
  assert.deepEqual(result.indexPlan, {
    dropIndexNames: [OBSOLETE_WORKSPACE_UNIQUE_INDEX],
    createIndexes: [{
      name: OWNER_SCOPE_UNIQUE_INDEX,
      keys: OWNER_SCOPE_UNIQUE_INDEX_KEYS,
      options: { name: OWNER_SCOPE_UNIQUE_INDEX, unique: true },
    }],
    incompatibleIndexNames: [],
  });
  assert.deepEqual(writes, []);
});


test("mapping profile migration backfills before explicit drop and create operations", async () => {
  const calls = [];
  const documents = [
    { _id: "profile-1", workspace: "workspace-1", updatedBy: "user-1" },
    { _id: "profile-2", workspace: null, updatedBy: "user-2" },
  ];
  const model = {
    db: { readyState: 1 },
    find(filter) {
      calls.push(["find", filter]);
      return {
        select(selection) {
          calls.push(["select", selection]);
          return this;
        },
        lean: async () => documents,
      };
    },
    async bulkWrite(operations) {
      calls.push(["bulkWrite", operations]);
      return { modifiedCount: operations.length };
    },
    collection: {
      async indexes() {
        calls.push(["indexes"]);
        return [
          { name: "_id_", key: { _id: 1 } },
          recognizedObsoleteIndex(),
        ];
      },
      async dropIndex(name) {
        calls.push(["dropIndex", name]);
      },
      async createIndex(keys, options) {
        calls.push(["createIndex", keys, options]);
        return options.name;
      },
    },
    async syncIndexes() {
      calls.push(["syncIndexes"]);
    },
  };

  const result = await migrateMappingProfileOwnerScope({ model, mode: "apply" });

  assert.equal(result.backfilled, 2);
  assert.deepEqual(result.droppedIndexes, [OBSOLETE_WORKSPACE_UNIQUE_INDEX]);
  assert.deepEqual(
    calls
      .filter(([name]) => ["bulkWrite", "dropIndex", "createIndex", "syncIndexes"].includes(name))
      .map(([name]) => name),
    ["bulkWrite", "dropIndex", "createIndex"],
  );
});


test("mapping profile migration creates only the allowlisted index for a fresh collection", async () => {
  const calls = [];
  const model = {
    db: { readyState: 1 },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => [],
      };
    },
    collection: {
      async indexes() {
        const error = new Error("namespace not found");
        error.code = 26;
        error.codeName = "NamespaceNotFound";
        throw error;
      },
      async dropIndex() {
        throw new Error("dropIndex must not be called for a fresh collection");
      },
      async createIndex(keys, options) {
        calls.push(["createIndex", keys, options]);
        return options.name;
      },
    },
    async syncIndexes() {
      calls.push("syncIndexes");
    },
  };

  const result = await migrateMappingProfileOwnerScope({ model, mode: "apply" });

  assert.deepEqual(result.droppedIndexes, []);
  assert.deepEqual(calls, [[
    "createIndex",
    OWNER_SCOPE_UNIQUE_INDEX_KEYS,
    { name: OWNER_SCOPE_UNIQUE_INDEX, unique: true },
  ]]);
});


test("concurrent mapping migrations ignore IndexNotFound while dropping the obsolete index", async () => {
  const calls = [];
  const model = {
    db: { readyState: 1 },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => [],
      };
    },
    collection: {
      async indexes() {
        return [recognizedObsoleteIndex()];
      },
      async dropIndex(name) {
        calls.push(["dropIndex", name]);
        const error = new Error("index not found after concurrent drop");
        error.code = 27;
        error.codeName = "IndexNotFound";
        throw error;
      },
      async createIndex(keys, options) {
        calls.push(["createIndex", keys, options]);
        return options.name;
      },
    },
    async syncIndexes() {
      calls.push(["syncIndexes"]);
    },
  };

  const result = await migrateMappingProfileOwnerScope({ model, mode: "apply" });

  assert.deepEqual(result.droppedIndexes, [OBSOLETE_WORKSPACE_UNIQUE_INDEX]);
  assert.deepEqual(calls, [
    ["dropIndex", OBSOLETE_WORKSPACE_UNIQUE_INDEX],
    [
      "createIndex",
      OWNER_SCOPE_UNIQUE_INDEX_KEYS,
      { name: OWNER_SCOPE_UNIQUE_INDEX, unique: true },
    ],
  ]);
});


test("mapping migration fails closed for non-IndexNotFound drop errors", async () => {
  let syncCalled = false;
  const model = {
    db: { readyState: 1 },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => [],
      };
    },
    collection: {
      async indexes() {
        return [recognizedObsoleteIndex()];
      },
      async dropIndex() {
        const error = new Error("drop denied");
        error.code = 13;
        throw error;
      },
    },
    async syncIndexes() {
      syncCalled = true;
    },
  };

  await assert.rejects(
    () => migrateMappingProfileOwnerScope({ model, mode: "apply" }),
    /drop denied/,
  );
  assert.equal(syncCalled, false);
});

test("obsolete index name with unrelated keys blocks apply and is never dropped", async () => {
  const writes = [];
  const model = {
    db: { readyState: 1 },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => [{
          _id: "profile-1",
          workspace: "workspace-1",
          updatedBy: "user-1",
        }],
      };
    },
    async bulkWrite() {
      writes.push("bulkWrite");
    },
    collection: {
      async indexes() {
        return [recognizedObsoleteIndex({ key: { unrelated: 1 } })];
      },
      async dropIndex(name) {
        writes.push(["dropIndex", name]);
      },
      async createIndex(keys, options) {
        writes.push(["createIndex", keys, options]);
      },
    },
  };

  await assert.rejects(
    migrateMappingProfileOwnerScope({ model, mode: "apply" }),
    /compatibility/i,
  );
  assert.deepEqual(writes, []);
});

test("obsolete index semantic option mismatches block drop", () => {
  const mismatches = [
    { sparse: true },
    { collation: { locale: "vi", strength: 1 } },
    { partialFilterExpression: { workspace: { $exists: true } } },
    { expireAfterSeconds: 3600 },
    { hidden: true },
  ];

  for (const mismatch of mismatches) {
    const plan = planMappingProfileIndexMigration([
      recognizedObsoleteIndex(mismatch),
    ]);
    assert.deepEqual(plan.dropIndexNames, []);
    assert.deepEqual(
      plan.incompatibleIndexNames,
      [OBSOLETE_WORKSPACE_UNIQUE_INDEX],
    );
  }
});

test("mapping migration leaves unmanaged and unrelated missing schema indexes untouched", async () => {
  const writes = [];
  const unmanagedIndex = {
    name: "ops_manual_lookup",
    key: { updatedAt: -1, status: 1 },
  };
  const model = {
    db: { readyState: 1 },
    schema: {
      indexes() {
        return [
          [OWNER_SCOPE_UNIQUE_INDEX_KEYS, { unique: true }],
          [{ workspace: 1 }, {}],
        ];
      },
    },
    find() {
      return {
        select() {
          return this;
        },
        lean: async () => [],
      };
    },
    collection: {
      async indexes() {
        return [{ name: "_id_", key: { _id: 1 } }, unmanagedIndex];
      },
      async dropIndex(name) {
        writes.push(["dropIndex", name]);
      },
      async createIndex(keys, options) {
        writes.push(["createIndex", keys, options]);
        return options.name;
      },
    },
    async syncIndexes() {
      writes.push(["syncIndexes"]);
    },
  };

  const report = await migrateMappingProfileOwnerScope({ model, mode: "apply" });

  assert.deepEqual(report.indexPlan.createIndexes, [{
    name: OWNER_SCOPE_UNIQUE_INDEX,
    keys: OWNER_SCOPE_UNIQUE_INDEX_KEYS,
    options: { name: OWNER_SCOPE_UNIQUE_INDEX, unique: true },
  }]);
  assert.deepEqual(writes, [[
    "createIndex",
    OWNER_SCOPE_UNIQUE_INDEX_KEYS,
    { name: OWNER_SCOPE_UNIQUE_INDEX, unique: true },
  ]]);
});
