const assert = require("node:assert/strict");
const test = require("node:test");

const User = require("../models/User");
const originalFindById = User.findById;
const { updateUser, deleteUser } = require("../controllers/adminController");

test.after(() => {
  User.findById = originalFindById;
});

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("admin cannot edit or ban their own account", async () => {
  const admin = { _id: "admin-id", role: "admin", isActive: true };
  User.findById = async () => admin;

  const updateResponse = createResponse();
  await updateUser(
    { body: { isActive: false }, params: { id: "admin-id" }, user: admin },
    updateResponse,
  );
  assert.equal(updateResponse.statusCode, 403);
  assert.equal(updateResponse.body.success, false);
  assert.equal(admin.isActive, true);

  const deleteResponse = createResponse();
  await deleteUser({ params: { id: "admin-id" }, user: admin }, deleteResponse);
  assert.equal(deleteResponse.statusCode, 403);
  assert.equal(deleteResponse.body.success, false);
  assert.equal(admin.isActive, true);
});

test("server exposes main admin, payment, and revenue routes through HTTP", async () => {
  const originalLog = console.log;
  let app;
  try {
    console.log = () => {};
    ({ app } = require("../server"));
  } finally {
    console.log = originalLog;
  }

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const path of [
      "/api/admin/users",
      "/api/admin/plans",
      "/api/admin/revenue",
      "/api/admin/conversion-runs",
      "/api/admin/coupons",
      "/api/payments/contract-test",
      "/api/revenue",
      "/admin/revenue",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.notEqual(response.status, 404, `${path} must remain mounted`);
      assert.ok([401, 503].includes(response.status), `${path} must hit an auth or DB guard`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
