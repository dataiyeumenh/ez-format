const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createConnectDB } = require("../config/db");
const { app } = require("../server");

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
