const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const gateScript = path.resolve(__dirname, "../../scripts/qa-main-contracts.ps1");
const releaseScript = path.resolve(__dirname, "../../scripts/qa-release.ps1");

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
    PAYOS_CLIENT_ID: "",
    PAYOS_API_KEY: "",
    PAYOS_CHECKSUM_KEY: "",
  });

  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /RELEASE_BLOCKED/);
  assert.match(output, /"missing":\["gridfs","live_gateway","replica_mongo"\]/);
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
