const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertConverterGatewayStartupConfig,
  internalHeaders,
  isConverterGatewayUsageReady,
} = require("../services/converterGatewayService");

const VALID_ENV = {
  NODE_ENV: "production",
  CONVERTER_PUBLIC_PROXY_ENABLED: "true",
  CONVERTER_GATEWAY_USAGE_READY: "true",
  JWT_SECRET: "Jwt_9f4Kp2Lm7Qx8Vn3Rc6Td1Yw5Za0HsBe",
  CONVERSION_CONTEXT_SECRET: "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc",
  CONVERTER_SERVICE_TOKEN: "Svc_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs",
  CONVERTER_INTERNAL_URL: "https://converter.example/api",
  CONVERTER_ARTIFACT_STORAGE_DRIVER: "mongodb",
  CONVERTER_MONGODB_GRIDFS_BUCKET: "conversion_artifacts",
  MONGO_URI: "mongodb://mongo.example/ezformat",
};

const DISABLED_PRODUCTION_ENV = {
  NODE_ENV: "production",
  JWT_SECRET: VALID_ENV.JWT_SECRET,
};

test("gateway off validates JWT but does not require converter or artifact secrets", () => {
  assert.equal(
    isConverterGatewayUsageReady(DISABLED_PRODUCTION_ENV),
    false,
  );
  assert.doesNotThrow(() => assertConverterGatewayStartupConfig(DISABLED_PRODUCTION_ENV));
});

test("gateway off rejects a missing production JWT secret", () => {
  for (const validate of [isConverterGatewayUsageReady, assertConverterGatewayStartupConfig]) {
    assert.throws(
      () => validate({ NODE_ENV: "production" }),
      (error) => error.statusCode === 503 && error.code === "WEAK_PRODUCTION_SECRET",
    );
  }
});

test("gateway off rejects placeholder, repeated, and low-diversity JWT secrets", () => {
  for (const jwtSecret of [
    "dev_change_me_in_production",
    "replace-with-a-long-random-secret",
    "x".repeat(64),
    "abc123".repeat(12),
  ]) {
    assert.throws(
      () => isConverterGatewayUsageReady({ ...DISABLED_PRODUCTION_ENV, JWT_SECRET: jwtSecret }),
      (error) => error.statusCode === 503 && error.code === "WEAK_PRODUCTION_SECRET",
      jwtSecret,
    );
  }
});

test("gateway on fails closed for missing context, service, and GridFS config", () => {
  for (const name of [
    "JWT_SECRET",
    "CONVERSION_CONTEXT_SECRET",
    "CONVERTER_SERVICE_TOKEN",
    "CONVERTER_ARTIFACT_STORAGE_DRIVER",
    "CONVERTER_MONGODB_GRIDFS_BUCKET",
    "MONGO_URI",
  ]) {
    const env = { ...VALID_ENV };
    delete env[name];
    assert.throws(
      () => assertConverterGatewayStartupConfig(env),
      (error) => error.statusCode === 503,
      name,
    );
  }
});

test("gateway on accepts strict HTTPS, secrets, and MongoDB/GridFS configuration", () => {
  assert.doesNotThrow(() => assertConverterGatewayStartupConfig(VALID_ENV));
});

test("production gateway rejects every documented auth-secret placeholder", () => {
  const examples = [
    ["JWT_SECRET", "dev_change_me_in_production"],
    ["CONVERSION_CONTEXT_SECRET", "replace-with-a-long-random-secret"],
    ["CONVERSION_CONTEXT_SECRET", "replace-with-the-backend-conversion-context-secret"],
    ["CONVERTER_SERVICE_TOKEN", "replace-with-another-long-random-secret"],
    ["CONVERTER_SERVICE_TOKEN", "replace-with-the-backend-converter-service-token"],
    ["CONVERTER_SERVICE_TOKEN", "<different-same-private-value-on-both-services>"],
  ];

  for (const [name, value] of examples) {
    assert.throws(
      () => assertConverterGatewayStartupConfig({ ...VALID_ENV, [name]: value }),
      (error) => error.statusCode === 503 && error.code === "WEAK_PRODUCTION_SECRET",
      `${name}=${value}`,
    );
  }
});

test("production gateway rejects low-entropy auth secrets", () => {
  for (const name of ["JWT_SECRET", "CONVERSION_CONTEXT_SECRET", "CONVERTER_SERVICE_TOKEN"]) {
    assert.throws(
      () => assertConverterGatewayStartupConfig({ ...VALID_ENV, [name]: "x".repeat(64) }),
      (error) => error.statusCode === 503 && error.code === "WEAK_PRODUCTION_SECRET",
      name,
    );
  }
});

test("production gateway requires bearer, context, and internal secrets to be distinct", () => {
  for (const [left, right] of [
    ["JWT_SECRET", "CONVERSION_CONTEXT_SECRET"],
    ["JWT_SECRET", "CONVERTER_SERVICE_TOKEN"],
    ["CONVERSION_CONTEXT_SECRET", "CONVERTER_SERVICE_TOKEN"],
  ]) {
    assert.throws(
      () => assertConverterGatewayStartupConfig({ ...VALID_ENV, [right]: VALID_ENV[left] }),
      (error) => error.statusCode === 503 && error.code === "DUPLICATE_PRODUCTION_SECRET",
      `${left}/${right}`,
    );
  }
});

test("template gateway requests require service authentication but not a conversion context", () => {
  const previous = process.env.CONVERTER_SERVICE_TOKEN;
  process.env.CONVERTER_SERVICE_TOKEN = "s".repeat(32);
  try {
    const headers = internalHeaders({ requestId: "request-1", requireContext: false });
    assert.equal(headers["x-converter-service-token"], "s".repeat(32));
    assert.equal(headers["x-conversion-context"], undefined);
  } finally {
    if (previous == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previous;
  }
});
