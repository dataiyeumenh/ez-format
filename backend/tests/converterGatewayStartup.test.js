const assert = require("node:assert/strict");
const test = require("node:test");

function mockModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
  return () => {
    if (previous === undefined) delete require.cache[modulePath];
    else require.cache[modulePath] = previous;
  };
}

test("converter gateway startup validation rejects incomplete usage-ready config", () => {
  const { assertConverterGatewayStartupConfig } = require("../services/converterGatewayService");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    publicProxy: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    usageReady: process.env.CONVERTER_GATEWAY_USAGE_READY,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
    allowInsecure: process.env.CONVERTER_ALLOW_INSECURE_LOCALHOST,
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
    process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
    delete process.env.CONVERTER_INTERNAL_URL;
    delete process.env.CONVERTER_SERVICE_TOKEN;
    assert.throws(
      () => assertConverterGatewayStartupConfig(),
      (error) => error?.statusCode === 503 && error?.code === "MISSING_CONVERTER_INTERNAL_URL",
    );

    process.env.CONVERTER_INTERNAL_URL = "https://converter.example/api";
    assert.throws(
      () => assertConverterGatewayStartupConfig(),
      (error) => error?.statusCode === 503 && error?.code === "MISSING_CONVERTER_SERVICE_TOKEN",
    );

    process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
    process.env.CONVERTER_INTERNAL_URL = "http://converter.example/api";
    assert.throws(
      () => assertConverterGatewayStartupConfig(),
      (error) => error?.statusCode === 503 && error?.code === "INSECURE_CONVERTER_URL",
    );
  } finally {
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      CONVERTER_PUBLIC_PROXY_ENABLED: previous.publicProxy,
      CONVERTER_GATEWAY_USAGE_READY: previous.usageReady,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
      CONVERTER_ALLOW_INSECURE_LOCALHOST: previous.allowInsecure,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("converter gateway production startup rejects weak or placeholder service tokens when usage-ready", () => {
  const { assertConverterGatewayStartupConfig } = require("../services/converterGatewayService");
  const baseEnv = {
    NODE_ENV: "production",
    CONVERTER_PUBLIC_PROXY_ENABLED: "true",
    CONVERTER_GATEWAY_USAGE_READY: "true",
    CONVERTER_INTERNAL_URL: "https://converter.example/api",
  };

  for (const serviceToken of [
    "short-local-token",
    "replace-with-a-long-random-secret",
  ]) {
    assert.throws(
      () =>
        assertConverterGatewayStartupConfig({
          ...baseEnv,
          CONVERTER_SERVICE_TOKEN: serviceToken,
        }),
      (error) =>
        error?.statusCode === 503 &&
        error?.code === "WEAK_CONVERTER_SERVICE_TOKEN",
    );
  }
});

test("converter gateway startup allows short local service tokens outside production", () => {
  const { assertConverterGatewayStartupConfig } = require("../services/converterGatewayService");

  assert.doesNotThrow(() =>
    assertConverterGatewayStartupConfig({
      NODE_ENV: "test",
      CONVERTER_PUBLIC_PROXY_ENABLED: "true",
      CONVERTER_GATEWAY_USAGE_READY: "true",
      CONVERTER_INTERNAL_URL: "https://converter.example/api",
      CONVERTER_SERVICE_TOKEN: "short-local-token",
    }),
  );
});

test("startServer fails closed before connectDB when usage-ready config is incomplete", async () => {
  const serverPath = require.resolve("../server");
  const connectDbPath = require.resolve("../config/db");
  const artifactServicePath = require.resolve("../services/conversionArtifactService");
  const sessionStateServicePath = require.resolve("../services/conversionSessionStateService");
  const migrationServicePath = require.resolve("../services/mappingProfileMigrationService");
  const migrationV2ServicePath = require.resolve("../services/mappingProfileV2MigrationService");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    publicProxy: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    usageReady: process.env.CONVERTER_GATEWAY_USAGE_READY,
    internalUrl: process.env.CONVERTER_INTERNAL_URL,
    serviceToken: process.env.CONVERTER_SERVICE_TOKEN,
    contextSecret: process.env.CONVERSION_CONTEXT_SECRET,
    allowInsecure: process.env.CONVERTER_ALLOW_INSECURE_LOCALHOST,
  };
  let connectDbCalls = 0;
  let listenCalls = 0;
  const restorers = [];

  try {
    process.env.NODE_ENV = "production";
    process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
    process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
    delete process.env.CONVERTER_INTERNAL_URL;
    delete process.env.CONVERTER_SERVICE_TOKEN;
    process.env.CONVERSION_CONTEXT_SECRET = "x".repeat(32);
    process.env.CONVERTER_ALLOW_INSECURE_LOCALHOST = "true";

    restorers.push(
      mockModule(connectDbPath, async () => {
        connectDbCalls += 1;
      }),
      mockModule(artifactServicePath, {
        assertArtifactStorageConfigured() {
          return true;
        },
        ensureConversionArtifactIndexes: async () => ({ droppedIndexes: [] }),
        startConversionArtifactSweeper: () => ({ stop() {} }),
      }),
      mockModule(sessionStateServicePath, {
        ensureConversionSessionStateIndexes: async () => ({ droppedIndexes: [] }),
        startConversionSessionStateSweeper: () => ({ stop() {} }),
      }),
      mockModule(migrationServicePath, {
        migrateMappingProfileOwnerScope: async () => ({ skipped: true }),
      }),
      mockModule(migrationV2ServicePath, {
        ensureMappingProfileV2Indexes: async () => undefined,
        migrateMappingProfilesV1ToV2: async () => ({ skipped: true }),
      }),
    );

    delete require.cache[serverPath];
    const { app, startServer } = require("../server");
    const originalListen = app.listen;
    app.listen = () => {
      listenCalls += 1;
      return { once() {}, close() {} };
    };

    try {
      await assert.rejects(
        startServer(),
        (error) =>
          error?.statusCode === 503 &&
          (error?.code === "MISSING_CONVERTER_INTERNAL_URL" ||
            error?.code === "MISSING_CONVERTER_SERVICE_TOKEN"),
      );
    } finally {
      app.listen = originalListen;
    }

    assert.equal(connectDbCalls, 0);
    assert.equal(listenCalls, 0);
  } finally {
    delete require.cache[serverPath];
    for (const restore of restorers.reverse()) restore();
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      CONVERTER_PUBLIC_PROXY_ENABLED: previous.publicProxy,
      CONVERTER_GATEWAY_USAGE_READY: previous.usageReady,
      CONVERTER_INTERNAL_URL: previous.internalUrl,
      CONVERTER_SERVICE_TOKEN: previous.serviceToken,
      CONVERSION_CONTEXT_SECRET: previous.contextSecret,
      CONVERTER_ALLOW_INSECURE_LOCALHOST: previous.allowInsecure,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
