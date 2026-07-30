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

test("student fast gate includes the attempt ownership and progress contract", async () => {
  const qa = await readFile(path.join(root, "scripts", "qa-qc.ps1"), "utf8");
  assert.match(qa, /backend[\\/]tests[\\/]studentAttempts\.test\.js/);
});
