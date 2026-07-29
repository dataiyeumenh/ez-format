const assert = require("node:assert/strict");
const test = require("node:test");

const User = require("../models/User");
const originalFindById = User.findById;
const { updateUser, deleteUser } = require("../controllers/adminController");
const adminRouter = require("../routes/admin");

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

test("admin router keeps users, plans, revenue, files, and coupon routes", () => {
  const routes = adminRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods).join(",")}:${layer.route.path}`);

  assert.ok(routes.includes("get,post:/users"));
  assert.ok(routes.includes("get,post:/plans"));
  assert.ok(routes.includes("get:/revenue"));
  assert.ok(routes.includes("get:/conversion-runs"));
  assert.ok(routes.includes("get,post:/coupons"));
});

test("server mounts auth, admin, payment, and revenue contracts", () => {
  const originalLog = console.log;
  let app;
  try {
    console.log = () => {};
    ({ app } = require("../server"));
  } finally {
    console.log = originalLog;
  }

  const mounts = app._router.stack
    .filter((layer) => layer.regexp)
    .map((layer) => String(layer.regexp));
  const directPaths = app._router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);

  assert.ok(mounts.some((mount) => mount.includes("api\\/auth")));
  assert.ok(mounts.some((mount) => mount.includes("api\\/admin")));
  assert.ok(mounts.some((mount) => mount.includes("api\\/payments")));
  assert.ok(directPaths.includes("/api/revenue"));
  assert.ok(directPaths.includes("/admin/revenue"));
});
