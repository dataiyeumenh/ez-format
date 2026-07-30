const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assessMongoTransactionReadiness,
  ensureCouponUsagePaymentUniqueIndex,
} = require("../config/db");

test("Mongo standalone deployment is not payment-settlement ready", () => {
  const readiness = assessMongoTransactionReadiness({
    topologyType: "Single",
    hello: {
      isWritablePrimary: true,
      logicalSessionTimeoutMinutes: 30,
    },
  });

  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /replica set or sharded cluster/i);
});

test("Mongo replica set deployment is payment-settlement ready from hello", () => {
  const readiness = assessMongoTransactionReadiness({
    topologyType: "Single",
    hello: {
      setName: "rs0",
      logicalSessionTimeoutMinutes: 30,
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.deployment, "replica-set");
});

test("Mongo sharded deployment is payment-settlement ready from hello", () => {
  const readiness = assessMongoTransactionReadiness({
    topologyType: "Sharded",
    hello: {
      msg: "isdbgrid",
      logicalSessionTimeoutMinutes: 30,
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.deployment, "sharded");
});

test("Mongo deployment without logical sessions is not payment-settlement ready", () => {
  const readiness = assessMongoTransactionReadiness({
    topologyType: "ReplicaSetWithPrimary",
    hello: { setName: "rs0" },
  });

  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /logical sessions/i);
});

test("CouponUsage payment uniqueness index is explicitly created idempotently", async () => {
  const calls = [];
  const CouponUsageModel = {
    collection: {
      async createIndex(keys, options) {
        calls.push({ keys, options });
        return options.name;
      },
    },
  };

  await ensureCouponUsagePaymentUniqueIndex(CouponUsageModel);
  await ensureCouponUsagePaymentUniqueIndex(CouponUsageModel);

  assert.deepEqual(calls, [
    {
      keys: { payment: 1 },
      options: {
        unique: true,
        partialFilterExpression: { payment: { $type: "objectId" } },
      },
    },
    {
      keys: { payment: 1 },
      options: {
        unique: true,
        partialFilterExpression: { payment: { $type: "objectId" } },
      },
    },
  ]);
});
