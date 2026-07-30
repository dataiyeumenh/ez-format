const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");
const validator = path.join(repositoryRoot, "scripts", "validate-task11-evidence.ps1");

function runBinding(root) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(root, "scripts", "validate-task11-evidence.ps1"), "-RepositoryRoot", root],
    { encoding: "utf8", env: { ...process.env } },
  );
}

test("Task 11 evidence binds to the tracked code/test/gate tree without artifact storage", () => {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", validator, "-RepositoryRoot", repositoryRoot],
    { encoding: "utf8", env: { ...process.env } },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TASK11_EVIDENCE_BINDING=PASS/);
  assert.match(result.stdout, /ARTIFACT_DEPENDENCY=NONE/);
});

test("Task 11 tree digest is stable across CRLF checkouts", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task11-evidence-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(fixtureRoot, "docs", "qa"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
  fs.copyFileSync(validator, path.join(fixtureRoot, "scripts", "validate-task11-evidence.ps1"));

  const samplePath = "sample.js";
  const sampleLf = "const value = 1;\nexport { value };\n";
  const sampleHash = crypto.createHash("sha256").update(sampleLf).digest("hex");
  const treeInput = `${samplePath}\0${sampleHash}\n`;
  const treeDigest = crypto.createHash("sha256").update(treeInput).digest("hex");
  const resultText = '{"status":"PASS"}\n';
  const resultHash = crypto.createHash("sha256").update(resultText).digest("hex");

  fs.writeFileSync(path.join(fixtureRoot, samplePath), sampleLf);
  fs.writeFileSync(
    path.join(fixtureRoot, "docs", "qa", "task-11-code-tree.manifest.json"),
    JSON.stringify({
      schema_version: "1",
      algorithm: "sha256-path-v1",
      tree_digest: treeDigest,
      files: [{ path: samplePath, sha256: sampleHash }],
    }),
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "docs", "qa", "task-11-command-results.json"),
    resultText,
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "docs", "qa", "task-11-evidence.json"),
    JSON.stringify({
      subject: { revision: `task11-code-test-gate-tree-sha256:${treeDigest}` },
      checks: [{
        evidence: [{
          path: "docs/qa/task-11-command-results.json",
          sha256: resultHash,
          size: Buffer.byteLength(resultText),
        }],
      }],
    }),
  );

  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: fixtureRoot }).status, 0);
  assert.equal(spawnSync("git", ["add", "."], { cwd: fixtureRoot }).status, 0);
  fs.writeFileSync(path.join(fixtureRoot, samplePath), sampleLf.replaceAll("\n", "\r\n"));

  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(fixtureRoot, "scripts", "validate-task11-evidence.ps1"), "-RepositoryRoot", fixtureRoot],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TASK11_EVIDENCE_BINDING=PASS/);
});

test("Task 11 durable evidence files have deterministic LF checkout", () => {
  const result = spawnSync(
    "git",
    ["check-attr", "eol", "--", "docs/qa/task-11-command-results.json", "docs/qa/task-11-evidence.json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task-11-command-results\.json: eol: lf/);
  assert.match(result.stdout, /task-11-evidence\.json: eol: lf/);
});

test("Task 11 validator rejects code tampering and stale evidence hashes", (t) => {
  const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task11-evidence-clone-"));
  const cloneRoot = path.join(parentRoot, "repository");
  t.after(() => fs.rmSync(parentRoot, { recursive: true, force: true }));

  const clone = spawnSync("git", ["clone", "--no-local", repositoryRoot, cloneRoot], {
    encoding: "utf8",
  });
  assert.equal(clone.status, 0, `${clone.stdout}\n${clone.stderr}`);
  assert.equal(fs.existsSync(path.join(cloneRoot, ".artifacts")), false);

  const codePath = path.join(cloneRoot, "backend", "tests", "coupons.test.js");
  const originalCode = fs.readFileSync(codePath, "utf8");
  fs.appendFileSync(codePath, "\n// Task 11 tamper probe\n");
  let result = runBinding(cloneRoot);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /tracked tree file changed: backend\/tests\/coupons\.test\.js/);

  fs.writeFileSync(codePath, originalCode);
  fs.appendFileSync(
    path.join(cloneRoot, "docs", "qa", "task-11-command-results.json"),
    "\n// Task 11 stale evidence probe\n",
  );
  result = runBinding(cloneRoot);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const evidenceFailure = `${result.stdout}\n${result.stderr}`;
  assert.match(evidenceFailure, /tracked command\/result evidence hash or size mismatch:/);
  assert.match(evidenceFailure, /docs\/qa\/task-11-command-results\.json/);
});
