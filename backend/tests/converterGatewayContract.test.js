const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspaceRoot = path.resolve(__dirname, "..", "..");

function readEnvExample(relativePath) {
  const content = fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
  const values = new Map();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }

  return { content, values };
}

test("converter gateway environment examples define safe runtime defaults", () => {
  const { values: backend } = readEnvExample("backend/.env.example");
  const { values: converter } = readEnvExample("converter/.env.example");
  const frontend = readEnvExample("frontend/.env.example");

  assert.deepEqual(
    Object.fromEntries(
      [
        "CONVERTER_INTERNAL_URL",
        "CONVERTER_SERVICE_TOKEN",
        "CONVERTER_PUBLIC_PROXY_ENABLED",
        "CONVERTER_GATEWAY_USAGE_READY",
        "CONVERTER_MAX_FILE_BYTES",
        "CONVERTER_TIMEOUT_MS",
        "CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES",
        "CONVERTER_OPERATION_LIMIT_PER_MINUTE",
        "CONVERTER_EXPORT_LIMIT_PER_10_MINUTES",
        "CONVERSION_USAGE_MODE",
        "CONVERTER_ARTIFACT_TTL_SECONDS",
        "CONVERTER_OBJECT_STORAGE_REQUIRED",
      ].map((key) => [key, backend.get(key)]),
    ),
    {
      CONVERTER_INTERNAL_URL: "http://127.0.0.1:8000",
      CONVERTER_SERVICE_TOKEN: "replace-with-a-long-random-secret",
      CONVERTER_PUBLIC_PROXY_ENABLED: "true",
      CONVERTER_GATEWAY_USAGE_READY: "false",
      CONVERTER_MAX_FILE_BYTES: "20971520",
      CONVERTER_TIMEOUT_MS: "120000",
      CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES: "10",
      CONVERTER_OPERATION_LIMIT_PER_MINUTE: "120",
      CONVERTER_EXPORT_LIMIT_PER_10_MINUTES: "10",
      CONVERSION_USAGE_MODE: "charge_on_export",
      CONVERTER_ARTIFACT_TTL_SECONDS: "3600",
      CONVERTER_OBJECT_STORAGE_REQUIRED: "false",
    },
  );

  assert.deepEqual(
    Object.fromEntries(
      [
        "INTERNAL_SERVICE_TOKEN_REQUIRED",
        "MAX_UPLOAD_BYTES",
        "ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS",
        "CORS_ORIGINS",
      ].map((key) => [key, converter.get(key)]),
    ),
    {
      INTERNAL_SERVICE_TOKEN_REQUIRED: "true",
      MAX_UPLOAD_BYTES: "20971520",
      ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS: "false",
      CORS_ORIGINS: "http://127.0.0.1:5173",
    },
  );

  assert.equal(frontend.values.get("VITE_API_URL"), "http://127.0.0.1:5000/api");
  assert.ok(
    /VITE_PYTHON_API_URL is local migration-only; never set in production\./.test(
      frontend.content,
    ),
  );
});
