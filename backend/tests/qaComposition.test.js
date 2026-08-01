const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

test("workspace QA runs the repair gate in default and fast modes", async () => {
  const qa = await readFile(path.join(root, "scripts", "qa-qc.ps1"), "utf8");
  const focused = await readFile(
    path.join(root, "scripts", "qa-misa-import-repair.ps1"),
    "utf8",
  );
  const gateIndex = qa.indexOf('Step "MISA import repair Task 9 gate"');
  const fastOnlyIndex = qa.indexOf("if ($SkipSlowTests)");

  assert.ok(gateIndex >= 0, "repair gate must exist");
  assert.ok(
    fastOnlyIndex < 0 || gateIndex < fastOnlyIndex,
    "repair gate must be outside the fast-only branch",
  );
  assert.doesNotMatch(focused, /requires -SkipSlowTests/);
});

test("student fast gate includes the no-grading contract", async () => {
  const qa = await readFile(path.join(root, "scripts", "qa-qc.ps1"), "utf8");
  assert.match(qa, /backend[\\/]tests[\\/]studentAttempts\.test\.js/);
  assert.match(qa, /backend[\\/]tests[\\/]studentPrivacy\.test\.js/);
  assert.doesNotMatch(qa, /backend[\\/]models[\\/]StudentAttempt\.js/);
  assert.doesNotMatch(qa, /backend[\\/]models[\\/]StudentSkillProgress\.js/);
});

test("accounting operations gate only accepts attested repository synthetic fixtures", async () => {
  const gate = await readFile(
    path.join(root, "scripts", "qa-accounting-operations.ps1"),
    "utf8",
  );

  assert.match(gate, /\[string\]\$SyntheticFixtureManifest/);
  assert.match(gate, /synthetic_no_customer_data/);
  assert.match(gate, /approval_status/);
  assert.match(gate, /Assert-RepoContainedFixture/);
  assert.match(gate, /Protect-EvidenceText/);
  assert.doesNotMatch(gate, /E:\\0\. EXE2|Downloads\\|USERPROFILE/);
  assert.doesNotMatch(gate, /"sum_total"/);
  assert.doesNotMatch(gate, /Missing fixture: \$\(\$item\.Value\)/);
});

test("converter global tests provision release-grade certification and fence defaults", async () => {
  const conftest = await readFile(
    path.join(root, "converter", "tests", "conftest.py"),
    "utf8",
  );
  const status = await readFile(
    path.join(root, "scripts", "qa-main-integration-status.ps1"),
    "utf8",
  );

  assert.match(conftest, /os\.environ\["OPERATION_FENCE_HMAC_SECRET"\]\s*=/);
  assert.match(conftest, /for template_id in CONVERSION_TYPES/);
  assert.match(status, /Count\s+-eq\s+7/);
});

test("real Mongo repair tests require the dedicated disposable URI", async () => {
  const tests = await readFile(
    path.join(root, "backend", "tests", "misaImportRepairModels.test.js"),
    "utf8",
  );

  assert.match(tests, /process\.env\.MISA_IMPORT_REPAIR_TEST_MONGO_URI/);
  assert.doesNotMatch(tests, /\|\|\s*process\.env\.MONGO_URI/);
});
