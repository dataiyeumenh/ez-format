const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createConnectDB } = require("../config/db");
const { app, createStartServer } = require("../server");

function createMongoConnection({ topologyType, hello }) {
  return {
    connection: {
      host: "mongo.test",
      db: {
        admin() {
          return { command: async () => hello };
        },
      },
      getClient() {
        return { topology: { description: { type: topologyType } } };
      },
    },
  };
}

test("configured PayOS startup rejects an actual standalone Mongo deployment", async () => {
  const connectDB = createConnectDB({
    env: {
      MONGO_URI: "mongodb://mongo.test:27017/ezformat",
      PAYOS_CLIENT_ID: "client",
      PAYOS_API_KEY: "api-key",
      PAYOS_CHECKSUM_KEY: "checksum",
    },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    mongooseInstance: {
      connect: async () =>
        createMongoConnection({
          topologyType: "Single",
          hello: { isWritablePrimary: true, logicalSessionTimeoutMinutes: 30 },
        }),
    },
  });

  await assert.rejects(connectDB(), /replica set or sharded cluster/i);
});

test("configured PayOS startup rejects missing MongoDB transaction preflight", async () => {
  const connectDB = createConnectDB({
    env: {
      PAYOS_CLIENT_ID: "client",
      PAYOS_API_KEY: "api-key",
      PAYOS_CHECKSUM_KEY: "checksum",
    },
    logger: { error() {}, log() {}, warn() {} },
  });

  await assert.rejects(connectDB(), /MONGO_URI is required/i);
});

test("configured PayOS startup accepts a replica set from connected hello data", async () => {
  const connectDB = createConnectDB({
    env: {
      MONGO_URI: "mongodb://mongo.test:27017/ezformat",
      PAYOS_CLIENT_ID: "client",
      PAYOS_API_KEY: "api-key",
      PAYOS_CHECKSUM_KEY: "checksum",
    },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    ensureCouponUsagePaymentUniqueIndex: async () => {},
    mongooseInstance: {
      connect: async () =>
        createMongoConnection({
          topologyType: "Single",
          hello: { setName: "rs0", logicalSessionTimeoutMinutes: 30 },
        }),
    },
  });

  await assert.doesNotReject(connectDB());
});

test("Student check-work startup rejects standalone Mongo because completion needs transactions", async () => {
  const connectDB = createConnectDB({
    env: {
      MONGO_URI: "mongodb://mongo.test:27017/ezformat",
      STUDENT_ASSISTANT_ENABLED: "true",
      STUDENT_CHECK_WORK_ENABLED: "true",
    },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    mongooseInstance: {
      connect: async () =>
        createMongoConnection({
          topologyType: "Single",
          hello: { isWritablePrimary: true, logicalSessionTimeoutMinutes: 30 },
        }),
    },
  });

  await assert.rejects(connectDB(), /student attempt.*replica set or sharded cluster/i);
});

test("Student check-work startup accepts replica-set transaction readiness", async () => {
  const connectDB = createConnectDB({
    env: {
      MONGO_URI: "mongodb://mongo.test:27017/ezformat",
      STUDENT_ASSISTANT_ENABLED: "true",
      STUDENT_CHECK_WORK_ENABLED: "true",
    },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    ensureCouponUsagePaymentUniqueIndex: async () => {},
    mongooseInstance: {
      connect: async () =>
        createMongoConnection({
          topologyType: "Single",
          hello: { setName: "rs0", logicalSessionTimeoutMinutes: 30 },
        }),
    },
  });

  await assert.doesNotReject(connectDB());
});

test("configured PayOS startup rejects when CouponUsage payment uniqueness cannot be ensured", async () => {
  const connectDB = createConnectDB({
    env: {
      MONGO_URI: "mongodb://mongo.test:27017/ezformat",
      PAYOS_CLIENT_ID: "client",
      PAYOS_API_KEY: "<redacted>",
      PAYOS_CHECKSUM_KEY: "checksum",
    },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    mongooseInstance: {
      connect: async () =>
        createMongoConnection({
          topologyType: "Single",
          hello: { setName: "rs0", logicalSessionTimeoutMinutes: 30 },
        }),
    },
    ensureCouponUsagePaymentUniqueIndex: async () => {
      throw new Error("CouponUsage payment uniqueness migration failed");
    },
  });

  await assert.rejects(connectDB(), /CouponUsage payment uniqueness migration failed/);
});

test("health never advertises payment settlement as ready before transaction preflight", async () => {
  await createConnectDB({ env: {}, logger: { error() {}, log() {}, warn() {} } })();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(JSON.parse(data)));
      }).on("error", reject);
    });

    assert.equal(body.capabilities.paymentSettlement, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CORS exposes Content-Disposition for browser export filenames", async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const headers = await new Promise((resolve, reject) => {
      const request = http.request(
        `http://127.0.0.1:${port}/api/health`,
        { headers: { Origin: "http://localhost:5173" } },
        (response) => resolve(response.headers),
      );
      request.on("error", reject);
      request.end();
    });

    assert.match(headers["access-control-expose-headers"] || "", /content-disposition/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("disabled repair feature performs no index migration, database mutation, or sweeper startup", async () => {
  let ensureRepairCalls = 0;
  let startRepairCalls = 0;
  const fakeServer = { once() {} };
  const startServer = createStartServer({
    repairEnabled: false,
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async () => ({ skipped: true }),
    ensureV2Indexes: async () => undefined,
    migrateMappingProfilesV2: async () => ({ skipped: true }),
    migrateQuestionEvents: async () => ({ purged: 0 }),
    migrateStudentAttempts: async () => ({ purged: 0 }),
    ensureRepairIndexes: async () => {
      ensureRepairCalls += 1;
      return { droppedIndexes: [], unsetNullKeys: 0 };
    },
    startRepairSweeper: () => {
      startRepairCalls += 1;
      return { stop() {} };
    },
    listen: () => fakeServer,
    logger: { error() {}, log() {} },
  });

  assert.equal(await startServer(), fakeServer);
  assert.equal(ensureRepairCalls, 0);
  assert.equal(startRepairCalls, 0);
});

test("disabled Student Assistant startup still attempts privacy purge and remains available", async () => {
  const serverPath = require.resolve("../server");
  const previousEnabled = process.env.STUDENT_ASSISTANT_ENABLED;
  delete require.cache[serverPath];
  process.env.STUDENT_ASSISTANT_ENABLED = "false";

  try {
    const { createStartServer, studentAssistantEnabled } = require("../server");
    const errors = [];
    let questionMigrationCalls = 0;
    let attemptMigrationCalls = 0;
    let listenCalls = 0;
    const startServer = createStartServer({
      connectDatabase: async () => ({}),
      migrateMappingProfiles: async () => ({ skipped: true }),
      migrateQuestionEvents: async () => {
        questionMigrationCalls += 1;
        throw new Error("privacy migration unavailable");
      },
      migrateStudentAttempts: async () => {
        attemptMigrationCalls += 1;
        throw new Error("attempt retention migration unavailable");
      },
      listen: () => {
        listenCalls += 1;
        return { once() {} };
      },
      logger: { error: (message) => errors.push(message), log() {} },
    });

    assert.equal(studentAssistantEnabled, false);
    await startServer();
    assert.equal(questionMigrationCalls, 1);
    assert.equal(attemptMigrationCalls, 1);
    assert.equal(listenCalls, 1);
    assert.match(errors[0], /Student question privacy migration failed/i);
    assert.match(errors[1], /Student attempt persistence migration failed/i);
  } finally {
    if (previousEnabled === undefined) delete process.env.STUDENT_ASSISTANT_ENABLED;
    else process.env.STUDENT_ASSISTANT_ENABLED = previousEnabled;
    delete require.cache[serverPath];
  }
});

test("enabled Student check-work refuses startup when attempt safeguards cannot be ensured", async () => {
  let listenCalls = 0;
  const startServer = createStartServer({
    studentAttemptsEnabled: true,
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async () => ({ skipped: true }),
    migrateMappingProfilesV2: async () => ({ skipped: true }),
    migrateQuestionEvents: async () => ({ purged: 0 }),
    migrateStudentAttempts: async () => {
      throw new Error("attempt indexes unavailable");
    },
    listen: () => {
      listenCalls += 1;
      return { once() {} };
    },
    logger: { error() {}, log() {} },
  });

  await assert.rejects(startServer(), /attempt indexes unavailable/);
  assert.equal(listenCalls, 0);
});

test("mapping-profile startup off mode performs compatibility checks without index mutation", async () => {
  const previousMode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
  process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = "off";
  const calls = [];
  const fakeServer = { once() {} };
  const startServer = createStartServer({
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async (options) => {
      calls.push(["owner", options]);
      return { skipped: true };
    },
    ensureV2Indexes: async () => {
      calls.push(["indexes"]);
    },
    migrateMappingProfilesV2: async (options) => {
      calls.push(["v2", options]);
      return { skipped: true };
    },
    migrateQuestionEvents: async () => ({ purged: 0 }),
    migrateStudentAttempts: async () => ({ purged: 0 }),
    listen: () => fakeServer,
    logger: { error() {}, log() {} },
  });

  try {
    assert.equal(await startServer(), fakeServer);
    assert.deepEqual(calls, [
      ["owner", { mode: "off" }],
      ["v2", { mode: "off" }],
    ]);
  } finally {
    if (previousMode === undefined) delete process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
    else process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = previousMode;
  }
});

test("mapping-profile startup apply mode composes owner, index, and V2 mutations", async () => {
  const previousMode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
  process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = "apply";
  const calls = [];
  const fakeServer = { once() {} };
  const startServer = createStartServer({
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async (options) => {
      calls.push(["owner", options]);
      return { skipped: false, backfilled: 0, droppedIndexes: [] };
    },
    ensureV2Indexes: async (options) => {
      calls.push(["indexes", options]);
      return { skipped: false, indexes: [], auditIndexes: [] };
    },
    migrateMappingProfilesV2: async (options) => {
      calls.push(["v2", options]);
      return {
        skipped: false,
        mode: "apply",
        created: 0,
        skippedExisting: 0,
        quarantined: 0,
      };
    },
    migrateQuestionEvents: async () => ({ purged: 0 }),
    migrateStudentAttempts: async () => ({ purged: 0 }),
    listen: () => fakeServer,
    logger: { error() {}, log() {} },
  });

  try {
    assert.equal(await startServer(), fakeServer);
    assert.deepEqual(calls, [
      ["owner", { mode: "apply" }],
      ["indexes", { mode: "apply" }],
      ["v2", { mode: "apply" }],
    ]);
  } finally {
    if (previousMode === undefined) delete process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
    else process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = previousMode;
  }
});

test("mapping-profile startup rejects rollback mode before any migration mutation", async () => {
  const previousMode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
  process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = "rollback";
  let migrationCalls = 0;
  let listenCalls = 0;
  const startServer = createStartServer({
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async () => {
      migrationCalls += 1;
      return { skipped: true };
    },
    ensureV2Indexes: async () => {
      migrationCalls += 1;
    },
    migrateMappingProfilesV2: async () => {
      migrationCalls += 1;
      return { skipped: true };
    },
    migrateQuestionEvents: async () => ({ purged: 0 }),
    migrateStudentAttempts: async () => ({ purged: 0 }),
    listen: () => {
      listenCalls += 1;
      return { once() {} };
    },
    logger: { error() {}, log() {} },
  });

  try {
    await assert.rejects(startServer(), /rollback.*startup|startup.*rollback/i);
    assert.equal(migrationCalls, 0);
    assert.equal(listenCalls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.MAPPING_PROFILE_V2_MIGRATION_MODE;
    else process.env.MAPPING_PROFILE_V2_MIGRATION_MODE = previousMode;
  }
});
