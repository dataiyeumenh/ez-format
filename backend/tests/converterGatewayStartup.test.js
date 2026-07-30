const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertConverterGatewayStartupConfig,
  isConverterGatewayUsageReady,
} = require("../services/converterGatewayService");

const VALID_ENV = {
  NODE_ENV: "production",
  CONVERTER_PUBLIC_PROXY_ENABLED: "true",
  CONVERTER_GATEWAY_USAGE_READY: "true",
  CONVERSION_CONTEXT_SECRET: "c".repeat(32),
  CONVERTER_SERVICE_TOKEN: "s".repeat(32),
  CONVERTER_INTERNAL_URL: "https://converter.example/api",
  CONVERTER_ARTIFACT_STORAGE_DRIVER: "mongodb",
  CONVERTER_GRIDFS_BUCKET: "conversion_artifacts",
  MONGO_URI: "mongodb://mongo.example/ezformat",
};

test("gateway off passes without converter or artifact secrets", () => {
  assert.equal(
    isConverterGatewayUsageReady({ NODE_ENV: "production" }),
    false,
  );
  assert.doesNotThrow(() => assertConverterGatewayStartupConfig({ NODE_ENV: "production" }));
});

test("gateway on fails closed for missing context, service, and GridFS config", () => {
  for (const name of [
    "CONVERSION_CONTEXT_SECRET",
    "CONVERTER_SERVICE_TOKEN",
    "CONVERTER_ARTIFACT_STORAGE_DRIVER",
    "CONVERTER_GRIDFS_BUCKET",
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
