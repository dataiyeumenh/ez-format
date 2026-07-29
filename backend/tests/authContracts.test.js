const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

process.env.JWT_SECRET ||= "main-contract-test-secret";
process.env.JWT_EXPIRE ||= "1h";

const User = require("../models/User");
const googleAuth = require("../services/googleAuth");
const originalFindOne = User.findOne;
const originalVerifyGoogleCredential = googleAuth.verifyGoogleCredential;
const requireDbPath = require.resolve("../middleware/requireDb");
const originalRequireDb = require.cache[requireDbPath];

let server;
let baseUrl;

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

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  googleAuth.verifyGoogleCredential = async () => ({
    googleId: "google-user-id",
    email: "google@example.com",
    name: "Google User",
    avatar: "",
  });
  require.cache[requireDbPath] = {
    id: requireDbPath,
    filename: requireDbPath,
    loaded: true,
    exports: (_req, _res, next) => next(),
  };
  delete require.cache[require.resolve("../controllers/authController")];
  delete require.cache[require.resolve("../routes/auth")];

  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../routes/auth"));
  server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  User.findOne = originalFindOne;
  googleAuth.verifyGoogleCredential = originalVerifyGoogleCredential;
  if (originalRequireDb) require.cache[requireDbPath] = originalRequireDb;
  else delete require.cache[requireDbPath];
  delete require.cache[require.resolve("../controllers/authController")];
  delete require.cache[require.resolve("../routes/auth")];
});

test("POST /api/auth/login runs route validation before the controller", async () => {
  const response = await post("/api/auth/login", { email: "not-an-email" });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.ok(Array.isArray(response.body.errors));
});

test("POST /api/auth/login returns a token for an active account", async () => {
  const user = createUser();
  User.findOne = () => ({
    select() {
      return { populate: async () => user };
    },
  });

  const response = await post("/api/auth/login", {
    email: user.email,
    password: "correct-password",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(typeof response.body.token, "string");
  assert.equal(response.body.user.email, user.email);
});

test("POST /api/auth/login blocks an inactive account", async () => {
  const user = createUser({ isActive: false });
  User.findOne = () => ({
    select() {
      return { populate: async () => user };
    },
  });

  const response = await post("/api/auth/login", {
    email: user.email,
    password: "correct-password",
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
});

test("POST /api/auth/google returns a token but blocks an inactive linked account", async () => {
  const activeUser = createUser({ googleId: "google-user-id" });
  User.findOne = () => ({ select: async () => activeUser });

  const activeResponse = await post("/api/auth/google", {
    credential: "verified-credential",
  });

  assert.equal(activeResponse.status, 200);
  assert.equal(activeResponse.body.success, true);
  assert.equal(typeof activeResponse.body.token, "string");

  const inactiveUser = createUser({ isActive: false, googleId: "google-user-id" });
  User.findOne = () => ({ select: async () => inactiveUser });

  const inactiveResponse = await post("/api/auth/google", {
    credential: "verified-credential",
  });

  assert.equal(inactiveResponse.status, 403);
  assert.equal(inactiveResponse.body.success, false);
});
