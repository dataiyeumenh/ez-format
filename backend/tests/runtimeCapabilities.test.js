const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getRuntimeCapabilities,
  parseFeatureFlag,
} = require("../services/runtimeCapabilitiesService");

test("runtime capabilities default every unfinished feature to disabled", () => {
  assert.deepEqual(getRuntimeCapabilities({}), {
    mapping_profile_v2: false,
    anomaly_detection: false,
    bulk_correction: false,
    reconciliation: false,
    accounting_assistant: false,
    ai_explanation: false,
    limits: {
      comparison_files: 2,
      raw_ttl_minutes: 60,
      max_rows_per_file: 50000,
    },
  });
});

test("runtime capabilities parse explicit flags and bounded limits", () => {
  const capabilities = getRuntimeCapabilities({
    FEATURE_MAPPING_PROFILE_V2: "true",
    FEATURE_ANOMALY_DETECTION: "1",
    FEATURE_BULK_CORRECTION: "yes",
    FEATURE_RECONCILIATION: "on",
    FEATURE_ACCOUNTING_ASSISTANT: "TRUE",
    FEATURE_AI_EXPLANATION: "true",
    ACCOUNTING_COMPARISON_FILE_LIMIT: "4",
    ACCOUNTING_RAW_TTL_MINUTES: "0",
    ACCOUNTING_MAX_ROWS_PER_FILE: "999999",
  });

  assert.equal(parseFeatureFlag(" false "), false);
  assert.equal(capabilities.mapping_profile_v2, true);
  assert.equal(capabilities.ai_explanation, true);
  assert.deepEqual(capabilities.limits, {
    comparison_files: 2,
    raw_ttl_minutes: 5,
    max_rows_per_file: 100000,
  });
});

test("server exposes capabilities and mounts Mapping Profile V2 only when enabled", () => {
  const previous = process.env.FEATURE_MAPPING_PROFILE_V2;
  process.env.FEATURE_MAPPING_PROFILE_V2 = "true";
  const serverPath = require.resolve("../server");
  delete require.cache[serverPath];
  try {
    const { app } = require("../server");
    const layers = app._router.stack;
    assert.ok(
      layers.some((layer) =>
        layer.route?.path === "/api/converter/capabilities" &&
        layer.route.methods.get,
      ),
    );
    assert.ok(
      layers.some((layer) =>
        String(layer.regexp).includes("mapping-profiles\\/v2"),
      ),
    );
  } finally {
    delete require.cache[serverPath];
    if (previous === undefined) delete process.env.FEATURE_MAPPING_PROFILE_V2;
    else process.env.FEATURE_MAPPING_PROFILE_V2 = previous;
  }
});

test("server does not mount legacy public /api/convert route", () => {
  const previous = {
    publicProxy: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
    usageReady: process.env.CONVERTER_GATEWAY_USAGE_READY,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
  process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
  process.env.NODE_ENV = "test";
  const serverPath = require.resolve("../server");
  delete require.cache[serverPath];

  try {
    const { app } = require("../server");
    assert.equal(
      app._router.stack.some(
        (layer) =>
          String(layer.regexp) === "/^\\/api\\/convert\\/?(?=\\/|$)/i",
      ),
      false,
    );
    assert.ok(
      app._router.stack.some(
        (layer) =>
          String(layer.regexp) === "/^\\/api\\/converter\\/?(?=\\/|$)/i",
      ),
    );
  } finally {
    delete require.cache[serverPath];
    if (previous.publicProxy === undefined) delete process.env.CONVERTER_PUBLIC_PROXY_ENABLED;
    else process.env.CONVERTER_PUBLIC_PROXY_ENABLED = previous.publicProxy;
    if (previous.usageReady === undefined) delete process.env.CONVERTER_GATEWAY_USAGE_READY;
    else process.env.CONVERTER_GATEWAY_USAGE_READY = previous.usageReady;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});
