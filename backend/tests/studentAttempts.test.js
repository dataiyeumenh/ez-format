const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backendRoot = path.resolve(__dirname, "..");

test("no-grading contract removes attempt and progress persistence", () => {
  for (const relativePath of [
    "models/StudentAttempt.js",
    "models/StudentSkillProgress.js",
    "services/studentAttemptMigrationService.js",
    "services/studentAttemptPersistenceService.js",
  ]) {
    assert.equal(existsSync(path.join(backendRoot, relativePath)), false, relativePath);
  }
});

test("Student backend contains no grading vocabulary or persistence hooks", () => {
  const studentController = readFileSync(
    path.join(backendRoot, "controllers/studentSessionController.js"),
    "utf8",
  );
  const databaseConfig = readFileSync(path.join(backendRoot, "config/db.js"), "utf8");
  const workspaceController = readFileSync(
    path.join(backendRoot, "controllers/accountingWorkspaceController.js"),
    "utf8",
  );

  assert.doesNotMatch(
    studentController,
    /StudentAttempt|StudentSkillProgress|rubric|score|progress/i,
  );
  assert.doesNotMatch(
    databaseConfig,
    /STUDENT_CHECK_WORK_ENABLED|isStudentAttemptPersistenceConfigured|Student attempt/i,
  );
  assert.doesNotMatch(
    workspaceController,
    /authenticateInternalContext\(req,\s*["']attempt["']\)/i,
  );
});
