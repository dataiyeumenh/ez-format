const assert = require("node:assert/strict");
const test = require("node:test");

const User = require("../models/User");
const payosClient = require("../services/payosClient");
const originalFindById = User.findById;
const originalGetPayOSClient = payosClient.getPayOSClient;

payosClient.getPayOSClient = () => ({
  paymentRequests: {
    get: async () => ({ amount: 10000, status: "PAID" }),
  },
});
delete require.cache[require.resolve("../services/paymentStatusSync")];
const { normalizePayOSStatus, syncPaymentStatusFromPayOS } = require("../services/paymentStatusSync");

test.after(() => {
  User.findById = originalFindById;
  payosClient.getPayOSClient = originalGetPayOSClient;
  delete require.cache[require.resolve("../services/paymentStatusSync")];
});

test("PayOS statuses retain their payment-state mapping", () => {
  assert.equal(normalizePayOSStatus("PAID"), "paid");
  assert.equal(normalizePayOSStatus("CANCELLED"), "cancelled");
  assert.equal(normalizePayOSStatus("PROCESSING"), "pending");
});

test("PayOS sync applies a paid per-file plan exactly once", async () => {
  const user = {
    _id: "user-id",
    plan: "Free",
    fileCredits: 2,
    async save() {},
  };
  User.findById = async () => user;
  let saves = 0;
  const payment = {
    _id: "payment-id",
    user: user._id,
    amount: 10000,
    paymentLinkId: "payment-link-id",
    plan: { _id: "perfile-plan", code: "perfile", fileCredits: 1, durationDays: 0 },
    status: "pending",
    async save() {
      saves += 1;
    },
  };

  const result = await syncPaymentStatusFromPayOS(payment);

  assert.equal(result.status, "paid");
  assert.equal(user.plan, "perfile-plan");
  assert.equal(user.fileCredits, 3);
  assert.equal(saves, 1);
});
