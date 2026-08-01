const assert = require("node:assert/strict");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");

const statusScript = path.resolve(__dirname, "../../scripts/qa-main-integration-status.ps1");
const converterRoot = path.resolve(__dirname, "../../converter");
const fixtureManifest = path.join(
  converterRoot,
  "config",
  "converter-fixture-manifest.json",
);
const approvedRawFixture = path.join(
  converterRoot,
  "fixtures",
  "samples",
  "raw_sales_sample.xlsx",
);
const releaseFixtureRoot = mkdtempSync(
  path.join(os.tmpdir(), "ezformat-main-integration-release-"),
);
const badManifestPath = path.join(
  __dirname,
  `.main-integration-release-manifest-${process.pid}.json`,
);
const evidenceEnv = {
  PAYMENT_REPLICA_SET_TEST_URI: "mongodb://localhost:27017/task11-replica-test",
  GRIDFS_INTEGRATION_TEST_URI: "mongodb://localhost:27017/task11-gridfs-test",
  MISA_IMPORT_REPAIR_TEST_MONGO_URI:
    "mongodb://localhost:27017/task11-misa-repair-test",
  MISA_TEMPLATE_CERTIFICATION_DIR: "",
  QA_EXPECT_LIVE: "true",
  QA_FRONTEND_URL: "https://frontend.example.test",
  QA_GATEWAY_URL: "https://gateway.example.test",
  QA_CONVERTER_URL: "https://converter.example.test",
  QA_OWNER_EMAIL: "qa-owner@example.test",
  QA_OWNER_PASSWORD: "qa-password",
  QA_OWNER_JWT: "qa-owner-jwt",
  QA_RELEASE_ID: "task11",
  QA_RAW_FIXTURE: approvedRawFixture,
  QA_SYNTHETIC_FIXTURE_MANIFEST: fixtureManifest,
};

before(() => {
  const setup = spawnSync(
    "python",
    [
      "-c",
      [
        "import os, runpy",
        "from pathlib import Path",
        "from app.conversion_types import CONVERSION_TYPES",
        "from app.misa_templates import get_misa_template",
        "create = runpy.run_path('tests/test_misa_template_provenance.py')['_create_test_certification']",
        "root = Path(os.environ['CERTIFICATION_TEST_ROOT'])",
        "certification_dir = root / 'certifications'",
        "for template_id in CONVERSION_TYPES:",
        "    workspace = root / template_id",
        "    workspace.mkdir(parents=True, exist_ok=True)",
        "    create(get_misa_template(template_id), certification_dir, workspace)",
        "print(certification_dir)",
      ].join("\n"),
    ],
    {
      cwd: converterRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CERTIFICATION_TEST_ROOT: releaseFixtureRoot,
      },
    },
  );
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
  evidenceEnv.MISA_TEMPLATE_CERTIFICATION_DIR = path.join(
    releaseFixtureRoot,
    "certifications",
  );

  const manifest = JSON.parse(readFileSync(fixtureManifest, "utf8"));
  const rawEntry = Object.values(manifest.fixtures).find(
    (entry) => entry.path === "converter/fixtures/samples/raw_sales_sample.xlsx",
  );
  assert.ok(rawEntry, "approved raw fixture entry must exist");
  rawEntry.sha256 = "0".repeat(64);
  writeFileSync(badManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
});

after(() => {
  rmSync(releaseFixtureRoot, { recursive: true, force: true });
  rmSync(badManifestPath, { force: true });
});

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

test("release mode fails closed when mandatory external evidence is absent", () => {
  const result = runStatus("Release");
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.equal(status.status, "RELEASE_BLOCKED");
  assert.deepEqual(status.missing.sort(), [
    "gridfs",
    "live_gateway",
    "misa_certification",
    "misa_import_repair_mongo",
    "replica_mongo",
  ]);
});

test("local incomplete mode is explicit and non-release", () => {
  const result = runStatus("LocalIncomplete");
  assert.equal(result.status, 0);
  const status = readStatus(result);
  assert.equal(status.status, "LOCAL_INCOMPLETE");
  assert.equal(status.releaseEligible, false);
});

test("release mode emits the exact ready status for complete evidence", () => {
  const result = runStatus("Release", evidenceEnv);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.equal(status.status, "RELEASE_READY");
  assert.equal(status.releaseEligible, true);
  assert.deepEqual(status.missing, []);
});

test("release mode rejects a customer workbook outside the repository", () => {
  const customerWorkbook = path.join(releaseFixtureRoot, "customer-upload.xlsx");
  writeFileSync(customerWorkbook, "customer workbook", "utf8");

  const result = runStatus("Release", {
    ...evidenceEnv,
    QA_RAW_FIXTURE: customerWorkbook,
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.ok(status.missing.includes("live_gateway"));
});

test("release mode rejects a repository workbook absent from the synthetic manifest", () => {
  const result = runStatus("Release", {
    ...evidenceEnv,
    QA_RAW_FIXTURE: path.join(converterRoot, "fixtures", "templates", "bsn_sales.xls"),
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.ok(status.missing.includes("live_gateway"));
});

test("release mode rejects a synthetic manifest with the wrong fixture SHA", () => {
  const result = runStatus("Release", {
    ...evidenceEnv,
    QA_SYNTHETIC_FIXTURE_MANIFEST: badManifestPath,
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const status = readStatus(result);
  assert.ok(status.missing.includes("live_gateway"));
});
