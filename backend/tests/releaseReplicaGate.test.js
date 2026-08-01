const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const gateScript = path.resolve(__dirname, "../../scripts/qa-main-contracts.ps1");
const releaseScript = path.resolve(__dirname, "../../scripts/qa-release.ps1");
const statusScript = path.resolve(
  __dirname,
  "../../scripts/qa-main-integration-status.ps1",
);

function runScript(script, env, args = []) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", script, ...args],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

test("qa:release fails closed when mandatory external evidence is absent", () => {
  const result = runScript(releaseScript, {
    REQUIRE_REPLICA_TESTS: "",
    PAYMENT_REPLICA_SET_TEST_URI: "",
    MISA_IMPORT_REPAIR_TEST_MONGO_URI: "",
    MISA_TEMPLATE_CERTIFICATION_DIR: "",
    PAYOS_CLIENT_ID: "",
    PAYOS_API_KEY: "",
    PAYOS_CHECKSUM_KEY: "",
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /RELEASE_BLOCKED/);
  assert.match(
    output,
    /"missing":\["gridfs","live_gateway","misa_certification","misa_import_repair_mongo","replica_mongo"\]/,
  );
});

test("local incomplete status reports missing certification and real repair Mongo", () => {
  const result = runScript(
    statusScript,
    {
      PAYMENT_REPLICA_SET_TEST_URI: "",
      GRIDFS_INTEGRATION_TEST_URI: "",
      MISA_IMPORT_REPAIR_TEST_MONGO_URI: "",
      MISA_TEMPLATE_CERTIFICATION_DIR: "",
      QA_EXPECT_LIVE: "",
    },
    ["-Mode", "LocalIncomplete"],
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /LOCAL_INCOMPLETE/);
  assert.match(result.stdout, /"releaseEligible":false/);
  assert.match(result.stdout, /"name":"misa_certification","status":"MISSING"/);
  assert.match(result.stdout, /"name":"misa_import_repair_mongo","status":"MISSING"/);
});

test("release evidence rejects non-Mongo URIs even when database names end in test", () => {
  const result = runScript(
    statusScript,
    {
      PAYMENT_REPLICA_SET_TEST_URI: "https://example.invalid/payment-test",
      GRIDFS_INTEGRATION_TEST_URI: "file:///gridfs-test",
      MISA_IMPORT_REPAIR_TEST_MONGO_URI: "redis://example.invalid/repair-test",
      MISA_TEMPLATE_CERTIFICATION_DIR: "",
      QA_EXPECT_LIVE: "",
    },
    ["-Mode", "LocalIncomplete"],
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"name":"replica_mongo","status":"MISSING"/);
  assert.match(result.stdout, /"name":"gridfs","status":"MISSING"/);
  assert.match(result.stdout, /"name":"misa_import_repair_mongo","status":"MISSING"/);
});

test("release evidence rejects encoded nested Mongo database paths", () => {
  const result = runScript(
    statusScript,
    {
      PAYMENT_REPLICA_SET_TEST_URI: "",
      GRIDFS_INTEGRATION_TEST_URI: "",
      MISA_IMPORT_REPAIR_TEST_MONGO_URI:
        "mongodb://example.invalid/customer%2Frepair-test",
      MISA_TEMPLATE_CERTIFICATION_DIR: "",
      QA_EXPECT_LIVE: "",
    },
    ["-Mode", "LocalIncomplete"],
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"name":"misa_import_repair_mongo","status":"MISSING"/);
});

test("local contract check may skip replica tests when release flag is absent", () => {
  const result = runScript(gateScript, {
    REQUIRE_REPLICA_TESTS: "",
    PAYMENT_REPLICA_SET_TEST_URI: "",
    PAYOS_CLIENT_ID: "",
    PAYOS_API_KEY: "",
    PAYOS_CHECKSUM_KEY: "",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Replica-set payment suite: SKIPPED/i);
});
