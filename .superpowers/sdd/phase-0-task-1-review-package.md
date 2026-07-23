# Phase 0 Task 1 review package - revised
diff --git a/backend/services/conversionContextService.js b/backend/services/conversionContextService.js
index ddcb82f..9e8e27a 100644
--- a/backend/services/conversionContextService.js
+++ b/backend/services/conversionContextService.js
@@ -1,5 +1,7 @@
 const jwt = require("jsonwebtoken");
 
+const MAX_STUDENT_CONTEXT_LIFETIME_SECONDS = 24 * 60 * 60;
+
 function contextSecret() {
   const secret =
     process.env.CONVERSION_CONTEXT_SECRET || process.env.JWT_SECRET;
@@ -74,9 +76,79 @@ function verifyReconstructionContextToken(token, requiredScope = null) {
   return claims;
 }
 
+function parseStudentContextLifetime(expiresIn) {
+  if (typeof expiresIn === "number" && Number.isSafeInteger(expiresIn)) {
+    if (Math.abs(expiresIn) <= MAX_STUDENT_CONTEXT_LIFETIME_SECONDS) {
+      return expiresIn;
+    }
+  } else if (typeof expiresIn === "string") {
+    const match = /^(-?\d+)([smhd])$/.exec(expiresIn);
+    if (match) {
+      const unitSeconds = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };
+      const lifetimeSeconds = Number(match[1]) * unitSeconds[match[2]];
+      if (
+        Number.isSafeInteger(lifetimeSeconds) &&
+        Math.abs(lifetimeSeconds) <= MAX_STUDENT_CONTEXT_LIFETIME_SECONDS
+      ) {
+        return lifetimeSeconds;
+      }
+    }
+  }
+
+  throw new Error("Student context lifetime không hợp lệ");
+}
+
+function createStudentContextToken({
+  sessionId,
+  userId,
+  ownerScope,
+  workspaceId = null,
+  snapshotSetHash = null,
+  allowedScopes = [],
+  expiresIn = "10m",
+}) {
+  const normalizedOwnerScope = String(ownerScope ?? "").trim();
+  if (!normalizedOwnerScope) {
+    throw new Error("Student owner scope là bắt buộc");
+  }
+  const lifetimeSeconds = parseStudentContextLifetime(expiresIn);
+
+  return jwt.sign(
+    {
+      purpose: "student_file_session",
+      session_id: String(sessionId),
+      user_id: String(userId),
+      owner_scope: normalizedOwnerScope,
+      workspace_id: workspaceId == null ? null : String(workspaceId),
+      snapshot_set_hash: snapshotSetHash == null ? null : String(snapshotSetHash),
+      allowed_scopes: allowedScopes.map(String),
+    },
+    contextSecret(),
+    { expiresIn: lifetimeSeconds },
+  );
+}
+
+function verifyStudentContextToken(token, requiredScope) {
+  const normalizedRequiredScope = String(requiredScope ?? "").trim();
+  if (!normalizedRequiredScope) {
+    throw new Error("Student context required scope là bắt buộc");
+  }
+
+  const claims = jwt.verify(token, contextSecret());
+  if (claims.purpose !== "student_file_session") {
+    throw new Error("Student context token không hợp lệ");
+  }
+  if (!(claims.allowed_scopes || []).includes(normalizedRequiredScope)) {
+    throw new Error(`Student context thiếu quyền ${normalizedRequiredScope}`);
+  }
+  return claims;
+}
+
 module.exports = {
+  createStudentContextToken,
   createConversionContextToken,
   createReconstructionContextToken,
+  verifyStudentContextToken,
   verifyConversionContextToken,
   verifyReconstructionContextToken,
 };
diff --git a/backend/services/studentSessionService.js b/backend/services/studentSessionService.js
new file mode 100755
index 0000000..7086854
--- /dev/null
+++ b/backend/services/studentSessionService.js
@@ -0,0 +1,15 @@
+function normalizeIdentifier(value) {
+  return String(value ?? "").trim();
+}
+
+function buildOwnerScope({ userId, workspaceId } = {}) {
+  const normalizedWorkspaceId = normalizeIdentifier(workspaceId);
+  if (normalizedWorkspaceId) return `workspace:${normalizedWorkspaceId}`;
+
+  const normalizedUserId = normalizeIdentifier(userId);
+  if (normalizedUserId) return `user:${normalizedUserId}`;
+
+  throw new Error("Student owner scope là bắt buộc");
+}
+
+module.exports = { buildOwnerScope };
diff --git a/backend/tests/studentSessions.test.js b/backend/tests/studentSessions.test.js
new file mode 100755
index 0000000..7743103
--- /dev/null
+++ b/backend/tests/studentSessions.test.js
@@ -0,0 +1,132 @@
+const assert = require("node:assert/strict");
+const test = require("node:test");
+const jwt = require("jsonwebtoken");
+
+const {
+  createStudentContextToken,
+  verifyStudentContextToken,
+} = require("../services/conversionContextService");
+const { buildOwnerScope } = require("../services/studentSessionService");
+
+process.env.CONVERSION_CONTEXT_SECRET = "test-student-session-secret";
+
+test("owner scope uses the selected workspace or falls back to the user", () => {
+  assert.equal(buildOwnerScope({ userId: " user-1 " }), "user:user-1");
+  assert.equal(
+    buildOwnerScope({ userId: "user-1", workspaceId: " workspace-1 " }),
+    "workspace:workspace-1",
+  );
+});
+
+test("owner scope rejects requests without a user or workspace", () => {
+  assert.throws(() => buildOwnerScope({}), /owner scope/i);
+  assert.throws(() => buildOwnerScope({ userId: " ", workspaceId: " " }), /owner scope/i);
+});
+
+test("student context contains its owner and allowed scopes", () => {
+  const ownerScope = buildOwnerScope({ userId: "user-1" });
+  const token = createStudentContextToken({
+    sessionId: "session-1",
+    userId: "user-1",
+    ownerScope,
+    workspaceId: null,
+    snapshotSetHash: null,
+    allowedScopes: ["analyze", "explain"],
+  });
+
+  const claims = verifyStudentContextToken(token, "analyze");
+  assert.equal(claims.purpose, "student_file_session");
+  assert.equal(claims.session_id, "session-1");
+  assert.equal(claims.user_id, "user-1");
+  assert.equal(claims.owner_scope, "user:user-1");
+  assert.equal(claims.workspace_id, null);
+  assert.equal(claims.snapshot_set_hash, null);
+  assert.deepEqual(claims.allowed_scopes, ["analyze", "explain"]);
+});
+
+test("student context rejects a token with another purpose", () => {
+  const token = jwt.sign(
+    { purpose: "misa_conversion", allowed_scopes: ["analyze"] },
+    process.env.CONVERSION_CONTEXT_SECRET,
+    { expiresIn: "10m" },
+  );
+
+  assert.throws(() => verifyStudentContextToken(token, "analyze"), /student context token/i);
+});
+
+test("student context rejects missing required scopes", () => {
+  const token = createStudentContextToken({
+    sessionId: "session-1",
+    userId: "user-1",
+    ownerScope: "user:user-1",
+    allowedScopes: ["analyze"],
+  });
+
+  assert.throws(() => verifyStudentContextToken(token, "export"), /thiếu quyền export/i);
+});
+
+test("student context requires an explicit required scope during verification", () => {
+  const token = createStudentContextToken({
+    sessionId: "session-1",
+    userId: "user-1",
+    ownerScope: "user:user-1",
+    allowedScopes: ["analyze"],
+  });
+
+  assert.throws(() => verifyStudentContextToken(token), /required scope/i);
+  assert.throws(() => verifyStudentContextToken(token, " "), /required scope/i);
+});
+
+test("student context accepts a 24-hour lifetime", () => {
+  assert.doesNotThrow(() =>
+    createStudentContextToken({
+      sessionId: "session-1",
+      userId: "user-1",
+      ownerScope: "user:user-1",
+      allowedScopes: ["analyze"],
+      expiresIn: "24h",
+    }),
+  );
+});
+
+test("student context rejects lifetimes longer than 24 hours", () => {
+  for (const expiresIn of ["48h", "2d"]) {
+    assert.throws(
+      () =>
+        createStudentContextToken({
+          sessionId: "session-1",
+          userId: "user-1",
+          ownerScope: "user:user-1",
+          allowedScopes: ["analyze"],
+          expiresIn,
+        }),
+      /lifetime/i,
+    );
+  }
+});
+
+test("student context rejects unsupported lifetime formats", () => {
+  assert.throws(
+    () =>
+      createStudentContextToken({
+        sessionId: "session-1",
+        userId: "user-1",
+        ownerScope: "user:user-1",
+        allowedScopes: ["analyze"],
+        expiresIn: "1w",
+      }),
+    /lifetime/i,
+  );
+});
+
+test("student context rejects expired tokens", () => {
+  const token = createStudentContextToken({
+    sessionId: "session-1",
+    userId: "user-1",
+    ownerScope: "user:user-1",
+    allowedScopes: ["analyze"],
+    expiresIn: "-1s",
+  });
+
+  assert.throws(() => verifyStudentContextToken(token, "analyze"), /jwt expired/i);
+});
