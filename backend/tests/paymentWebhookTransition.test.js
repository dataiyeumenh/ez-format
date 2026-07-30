const assert = require("node:assert/strict");
const test = require("node:test");

const Payment = require("../models/Payment");
const payosClient = require("../services/payosClient");
const paymentStatusSync = require("../services/paymentStatusSync");

const originals = {
  findOne: Payment.findOne,
  getPayOSClient: payosClient.getPayOSClient,
  applyNonPaidPaymentStatus: paymentStatusSync.applyNonPaidPaymentStatus,
};

test.after(() => {
  Payment.findOne = originals.findOne;
  payosClient.getPayOSClient = originals.getPayOSClient;
  paymentStatusSync.applyNonPaidPaymentStatus = originals.applyNonPaidPaymentStatus;
  delete require.cache[require.resolve("../controllers/paymentController")];
});

test("mismatched webhook uses conditional settlement transition instead of stale save", async () => {
  const payment = {
    _id: "payment-id",
    orderCode: 123,
    amount: 10000,
    paymentLinkId: "payment-link-id",
    status: "pending",
    plan: null,
    payosData: {},
    async save() {
      throw new Error("stale webhook must not save directly");
    },
  };
  let transition;
  Payment.findOne = () => ({
    populate() {
      return Promise.resolve(payment);
    },
  });
  payosClient.getPayOSClient = () => ({
    webhooks: {
      verify: async () => ({
        orderCode: 123,
        amount: 9000,
        paymentLinkId: "payment-link-id",
      }),
    },
  });
  paymentStatusSync.applyNonPaidPaymentStatus = async (...args) => {
    transition = args;
    return { ...payment, status: "paid" };
  };

  delete require.cache[require.resolve("../controllers/paymentController")];
  const { handlePayOSWebhook } = require("../controllers/paymentController");
  const response = {
    statusCode: null,
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

  await handlePayOSWebhook({ body: { success: false } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(transition[0], payment);
  assert.equal(transition[1], "failed");
  assert.equal(transition[2].amount, 9000);
});
