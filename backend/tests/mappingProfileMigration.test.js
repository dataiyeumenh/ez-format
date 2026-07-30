const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
  buildLegacyOwnerScopeUpdate,
  migrateMappingProfileOwnerScope,
  planMappingProfileIndexMigration,
} = require("../services/mappingProfileMigrationService");

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
        name: OBSOLETE_WORKSPACE_UNIQUE_INDEX,
        key: { workspace: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
        unique: true,
      },
      {
        name: "ownerScope_1_targetTemplateId_1_sourceSignatureHash_1",
        key: { ownerScope: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
        unique: true,
      },
    ]),
    { dropIndexNames: [OBSOLETE_WORKSPACE_UNIQUE_INDEX] },
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
        return [{ name: OBSOLETE_WORKSPACE_UNIQUE_INDEX }];
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
  });
  assert.deepEqual(writes, []);
});


test("mapping profile migration backfills before dropping and syncing indexes", async () => {
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
          { name: OBSOLETE_WORKSPACE_UNIQUE_INDEX },
        ];
      },
      async dropIndex(name) {
        calls.push(["dropIndex", name]);
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
    calls.filter(([name]) => ["bulkWrite", "dropIndex", "syncIndexes"].includes(name)).map(([name]) => name),
    ["bulkWrite", "dropIndex", "syncIndexes"],
  );
});


test("mapping profile migration syncs indexes for a fresh collection", async () => {
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
    },
    async syncIndexes() {
      calls.push("syncIndexes");
    },
  };

  const result = await migrateMappingProfileOwnerScope({ model, mode: "apply" });

  assert.deepEqual(result.droppedIndexes, []);
  assert.deepEqual(calls, ["syncIndexes"]);
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
        return [{ name: OBSOLETE_WORKSPACE_UNIQUE_INDEX }];
      },
      async dropIndex(name) {
        calls.push(["dropIndex", name]);
        const error = new Error("index not found after concurrent drop");
        error.code = 27;
        error.codeName = "IndexNotFound";
        throw error;
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
    ["syncIndexes"],
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
        return [{ name: OBSOLETE_WORKSPACE_UNIQUE_INDEX }];
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
