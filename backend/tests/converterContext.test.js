const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const { app } = require("../server");
const {
  assertConversionContextConfig,
  createConversionContextToken,
  verifyConversionContextToken,
} = require("../services/conversionContextService");
const { mappingProfileOwnerFromClaims } = require("../services/mappingProfileService");

function id() {
  return new mongoose.Types.ObjectId().toString();
}

test("production conversion context requires its dedicated secret", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    jwtSecret: process.env.JWT_SECRET,
    allowFallback: process.env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK,
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.CONVERSION_CONTEXT_SECRET;
    process.env.JWT_SECRET = "general-auth-secret";
    process.env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK = "true";

    assert.throws(
      () => assertConversionContextConfig(),
      /CONVERSION_CONTEXT_SECRET/,
    );
  } finally {
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      JWT_SECRET: previous.jwtSecret,
      CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK: previous.allowFallback,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("production conversion context rejects weak dedicated secrets", () => {
  const previous = {
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.NODE_ENV = "production";
  process.env.CONVERSION_CONTEXT_SECRET = "weak-secret";

  try {
    assert.throws(
      () => assertConversionContextConfig(),
      /at least 32 characters/,
    );
  } finally {
    if (previous.contextSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previous.contextSecret;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test("JWT secret fallback is explicit and development-only", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    jwtSecret: process.env.JWT_SECRET,
    allowFallback: process.env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK,
  };
  try {
    process.env.NODE_ENV = "development";
    delete process.env.CONVERSION_CONTEXT_SECRET;
    process.env.JWT_SECRET = "general-auth-secret";
    delete process.env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK;
    assert.throws(
      () => createConversionContextToken({ userId: id() }),
      /CONVERSION_CONTEXT_SECRET/,
    );

    process.env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK = "true";
    const token = createConversionContextToken({ userId: id() });
    assert.equal(verifyConversionContextToken(token).purpose, "misa_conversion");

    delete process.env.NODE_ENV;
    assert.throws(
      () => createConversionContextToken({ userId: id() }),
      /CONVERSION_CONTEXT_SECRET/,
    );
  } finally {
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      JWT_SECRET: previous.jwtSecret,
      CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK: previous.allowFallback,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("personal conversion context is user-scoped and accepted by profile ownership", () => {
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERSION_CONTEXT_SECRET = "personal-context-test-secret";
  try {
    const userId = id();
    const claims = verifyConversionContextToken(createConversionContextToken({
      userId,
      workspaceId: null,
      snapshotSetHash: null,
    }));

    assert.equal(claims.workspace_id, null);
    assert.equal(claims.owner_scope, `user:${userId}`);
    assert.deepEqual(mappingProfileOwnerFromClaims(claims), {
      ownerScope: `user:${userId}`,
      userId,
      workspaceId: null,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("POST /api/converter/context is protected and returns no-workspace context", async () => {
  const layer = app._router.stack.find(
    (candidate) => candidate.route?.path === "/api/converter/context",
  );
  assert.ok(layer, "personal converter context route must exist");
  assert.equal(layer.route.methods.post, true);
  assert.deepEqual(
    layer.route.stack.slice(0, 2).map((item) => item.handle.name),
    ["requireDb", "protect"],
  );

  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERSION_CONTEXT_SECRET = "personal-context-route-secret";
  try {
    const userId = id();
    let body;
    await layer.route.stack.at(-1).handle(
      { user: { _id: userId } },
      { json(value) { body = value; } },
    );
    const claims = verifyConversionContextToken(body.contextToken);
    assert.equal(body.success, true);
    assert.equal(body.ownerScope, `user:${userId}`);
    assert.equal(claims.owner_scope, `user:${userId}`);
    assert.equal(claims.workspace_id, null);
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});
