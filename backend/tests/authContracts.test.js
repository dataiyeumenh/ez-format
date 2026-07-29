const assert = require("node:assert/strict");
const test = require("node:test");

process.env.JWT_SECRET ||= "main-contract-test-secret";
process.env.JWT_EXPIRE ||= "1h";

const User = require("../models/User");
const googleAuth = require("../services/googleAuth");
const originalFindOne = User.findOne;
const originalVerifyGoogleCredential = googleAuth.verifyGoogleCredential;

googleAuth.verifyGoogleCredential = async () => ({
  googleId: "google-user-id",
  email: "google@example.com",
  name: "Google User",
  avatar: "",
});
delete require.cache[require.resolve("../controllers/authController")];
const { login, googleLogin } = require("../controllers/authController");

test.after(() => {
  User.findOne = originalFindOne;
  googleAuth.verifyGoogleCredential = originalVerifyGoogleCredential;
  delete require.cache[require.resolve("../controllers/authController")];
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

function createUser({ isActive = true, googleId = null } = {}) {
  return {
    _id: "user-id",
    name: "Contract User",
    email: "user@example.com",
    role: "user",
    plan: { _id: "free-plan", code: "free", name: "Free", isActive: true },
    planStartedAt: null,
    planExpiresAt: null,
    fileCredits: 0,
    dailyFileCredit: 1,
    dailyFileCreditDate: new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    avatar: "",
    authProvider: googleId ? "google" : "local",
    googleId,
    password: "hashed-password",
    isActive,
    loginCount: 0,
    async matchPassword(password) {
      return password === "correct-password";
    },
    isModified() {
      return false;
    },
    async save() {},
    async populate() {
      return this;
    },
  };
}

test("email/password login returns a token for an active account", async () => {
  const user = createUser();
  User.findOne = () => ({
    select() {
      return {
        populate: async () => user,
      };
    },
  });
  const res = createResponse();

  await login({ body: { email: user.email, password: "correct-password" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.token, "string");
  assert.equal(res.body.user.email, user.email);
});

test("email/password login blocks an inactive account", async () => {
  const user = createUser({ isActive: false });
  User.findOne = () => ({
    select() {
      return {
        populate: async () => user,
      };
    },
  });
  const res = createResponse();

  await login({ body: { email: user.email, password: "correct-password" } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test("Google login returns a token but blocks an inactive linked account", async () => {
  const activeUser = createUser({ googleId: "google-user-id" });
  User.findOne = () => ({
    select: async () => activeUser,
  });
  const activeResponse = createResponse();

  await googleLogin({ body: { credential: "verified-credential" } }, activeResponse);

  assert.equal(activeResponse.statusCode, 200);
  assert.equal(activeResponse.body.success, true);
  assert.equal(typeof activeResponse.body.token, "string");

  const inactiveUser = createUser({ isActive: false, googleId: "google-user-id" });
  User.findOne = () => ({
    select: async () => inactiveUser,
  });
  const inactiveResponse = createResponse();

  await googleLogin({ body: { credential: "verified-credential" } }, inactiveResponse);

  assert.equal(inactiveResponse.statusCode, 403);
  assert.equal(inactiveResponse.body.success, false);
});
