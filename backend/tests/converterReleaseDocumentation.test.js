const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const PRIMARY_REF = "rollback/main-pre-task11-reconcile-20260730-203721";
const PRIMARY_SHA = "2250102293021a54bcd1cf4fc8a7d6037e980524";
const LEGACY_REF = "rollback/main-pre-experimental-integration-20260730-055323";
const LEGACY_SHA = "8d1a9343dc98a8abb715fe7efc8df9adf65a10fa";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("all service env examples keep Student privacy migration explicitly off", () => {
  for (const relativePath of [".env.example", "backend/.env.example", "converter/.env.example"]) {
    assert.match(read(relativePath), /^STUDENT_PRIVACY_MIGRATION_MODE=off$/m, relativePath);
  }
});

test("release and rollback docs use the pre-task11 ref as the primary emergency rollback", () => {
  for (const relativePath of [
    "docs/deployment/main-experimental-release-runbook.md",
    "docs/deployment/main-experimental-rollback-runbook.md",
  ]) {
    const document = read(relativePath);
    assert.ok(document.indexOf(PRIMARY_REF) >= 0, relativePath);
    assert.ok(document.indexOf(PRIMARY_SHA) >= 0, relativePath);
    assert.ok(document.indexOf(PRIMARY_REF) < document.indexOf(LEGACY_REF), relativePath);
    for (const line of document.split(/\r?\n/).filter((item) => item.includes(LEGACY_REF) || item.includes(LEGACY_SHA))) {
      assert.match(line, /legacy deep fallback/i, `${relativePath}: ${line}`);
    }
  }
});

test("release QA docs require secret startup checks and conversion-context replay denial", () => {
  const release = read("docs/deployment/main-experimental-release-runbook.md");
  const qa = read("docs/qa/converter-gateway-release-gate.md");

  for (const document of [release, qa]) {
    assert.match(document, /high-entropy/i);
    assert.match(document, /JWT_SECRET/);
    assert.match(document, /CONVERSION_CONTEXT_SECRET/);
    assert.match(document, /CONVERTER_SERVICE_TOKEN/);
    assert.match(document, /cross-user replay/i);
    assert.match(document, /malformed.*expired|expired.*malformed/i);
  }
});
