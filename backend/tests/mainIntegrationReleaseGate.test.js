const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const statusScript = path.resolve(__dirname, "../../scripts/qa-main-integration-status.ps1");
const evidenceEnv = {
  PAYMENT_REPLICA_SET_TEST_URI: "mongodb://localhost:27017/task11-replica-test",
  GRIDFS_INTEGRATION_TEST_URI: "mongodb://localhost:27017/task11-gridfs-test",
  QA_EXPECT_LIVE: "true",
  QA_FRONTEND_URL: "https://frontend.example.test",
  QA_GATEWAY_URL: "https://gateway.example.test",
  QA_CONVERTER_URL: "https://converter.example.test",
  QA_OWNER_EMAIL: "qa-owner@example.test",
  QA_OWNER_PASSWORD: "qa-password",
  QA_OWNER_JWT: "qa-owner-jwt",
  QA_RELEASE_ID: "task11",
  QA_RAW_FIXTURE: path.resolve(__dirname, "../../converter/fixtures/samples/raw_sales_sample.xlsx"),
};

function runStatus(mode, overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(evidenceEnv)) env[name] = "";
  Object.assign(env, overrides);
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", statusScript, "-Mode", mode],
    { encoding: "utf8", env },
  );
}

function readStatus(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/QA_MAIN_INTEGRATION_STATUS_JSON=(\{[^\r\n]+\})/);
  assert.ok(match, output);
  return JSON.parse(match[1]);
}

test("release mode fails closed when replica, GridFS, and live evidence are absent", () => {
  const result = runStatus("Release");
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.equal(status.status, "RELEASE_BLOCKED");
  assert.deepEqual(status.missing.sort(), ["gridfs", "live_gateway", "replica_mongo"]);
});

test("local incomplete mode is explicit and non-release", () => {
  const result = runStatus("LocalIncomplete");
  assert.equal(result.status, 0);
  const status = readStatus(result);
  assert.equal(status.status, "LOCAL_INCOMPLETE");
  assert.equal(status.releaseEligible, false);
});

test("release mode accepts a complete evidence configuration", () => {
  const result = runStatus("Release", evidenceEnv);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.equal(status.status, "RELEASE_PREREQUISITES_PRESENT");
  assert.equal(status.releaseEligible, true);
  assert.deepEqual(status.missing, []);
});
