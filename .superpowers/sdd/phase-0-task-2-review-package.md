# Phase 0 Task 2 review package - revised
## Note
The 127.0.0.1 CORS entries existed before Task 2 and are intentionally preserved. The synthetic server diff below isolates only Task 2 edits.
--- a/backend/server.js
+++ b/backend/server.js
@@ -23,6 +23,8 @@
 const voucherReconstructionEnabled =
   String(process.env.VOUCHER_RECONSTRUCTION_ENABLED || "false").toLowerCase() ===
   "true";
+const studentAssistantEnabled =
+  String(process.env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
 
 // CORS config: allow localhost for dev + Vercel production URL
 const allowedOrigins = [
@@ -69,6 +71,9 @@
 if (voucherReconstructionEnabled) {
   app.use("/api/reconstructions", require("./routes/reconstructions"));
 }
+if (studentAssistantEnabled) {
+  app.use("/api/student", require("./routes/student"));
+}
 if (masterDataWorkspacesEnabled || voucherReconstructionEnabled) {
   app.use("/api/internal", require("./routes/internal"));
 }
@@ -85,6 +90,7 @@
     capabilities: {
       masterDataWorkspaces: masterDataWorkspacesEnabled,
       voucherReconstruction: voucherReconstructionEnabled,
+      studentAssistant: studentAssistantEnabled,
     },
   });
 });
diff --git a/backend/models/StudentFileSession.js b/backend/models/StudentFileSession.js
new file mode 100755
index 0000000..7505aea
--- /dev/null
+++ b/backend/models/StudentFileSession.js
@@ -0,0 +1,61 @@
+const mongoose = require("mongoose");
+
+const fileMetadataSchema = new mongoose.Schema(
+  {
+    originalName: {
+      type: String,
+      required: [true, "Tên file là bắt buộc"],
+      trim: true,
+      maxlength: 255,
+    },
+    sizeBytes: {
+      type: Number,
+      required: [true, "Kích thước file là bắt buộc"],
+      min: [0, "Kích thước file không được âm"],
+    },
+    extension: { type: String, trim: true, lowercase: true, maxlength: 16 },
+    contentHash: { type: String, trim: true, maxlength: 256, default: "" },
+    rawRetained: { type: Boolean, default: false },
+  },
+  { _id: false },
+);
+
+const studentFileSessionSchema = new mongoose.Schema(
+  {
+    userId: {
+      type: mongoose.Schema.Types.ObjectId,
+      ref: "User",
+      required: true,
+      index: true,
+    },
+    workspaceId: {
+      type: mongoose.Schema.Types.ObjectId,
+      ref: "AccountingWorkspace",
+      default: null,
+      index: true,
+    },
+    ownerScope: { type: String, required: true, trim: true, index: true },
+    mode: {
+      type: String,
+      enum: ["student_assistant"],
+      default: "student_assistant",
+    },
+    status: {
+      type: String,
+      enum: ["created", "analyzed", "in_review", "exported", "expired", "deleted"],
+      default: "created",
+      index: true,
+    },
+    file: { type: fileMetadataSchema, required: true },
+    converterUploadId: { type: String, trim: true, maxlength: 128, default: "" },
+    targetTemplateId: { type: String, trim: true, maxlength: 128, default: "" },
+    sourceSignatureHash: { type: String, trim: true, maxlength: 256, default: "" },
+    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
+    retentionExpiresAt: { type: Date, required: true, expires: 0 },
+  },
+  { timestamps: true },
+);
+
+studentFileSessionSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
+
+module.exports = mongoose.model("StudentFileSession", studentFileSessionSchema);
diff --git a/backend/controllers/studentSessionController.js b/backend/controllers/studentSessionController.js
new file mode 100755
index 0000000..007a908
--- /dev/null
+++ b/backend/controllers/studentSessionController.js
@@ -0,0 +1,268 @@
+const mongoose = require("mongoose");
+const StudentFileSession = require("../models/StudentFileSession");
+const AccountingWorkspace = require("../models/AccountingWorkspace");
+const { userCanAccessWorkspace } = require("../services/masterDataService");
+const {
+  createStudentContextToken,
+  verifyStudentContextToken,
+} = require("../services/conversionContextService");
+const { buildOwnerScope } = require("../services/studentSessionService");
+
+const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
+const STUDENT_CONTEXT_SCOPES = [
+  "analyze",
+  "explain",
+  "ask",
+  "attempt",
+  "accounting_map",
+  "reconcile",
+  "export",
+];
+const UNSAFE_METADATA_KEYS = new Set([
+  "rawrows",
+  "rows",
+  "workbook",
+  "workbookbytes",
+  "rawbytes",
+  "bytes",
+]);
+
+function cleanFileName(value) {
+  return String(value || "")
+    .replace(/[\\/]/g, "")
+    .trim()
+    .slice(0, 255);
+}
+
+function cleanExtension(value) {
+  const extension = String(value || "").trim().toLowerCase().replace(/^\.+/, "");
+  return extension ? `.${extension.slice(0, 15)}` : "";
+}
+
+function cleanString(value, maxLength) {
+  return String(value || "").trim().slice(0, maxLength);
+}
+
+function cleanStudentSessionPayload(body = {}) {
+  const file = body.file || {};
+  const payload = {
+    file: {
+      originalName: cleanFileName(file.originalName),
+      sizeBytes: Number(file.sizeBytes),
+      extension: cleanExtension(file.extension),
+      contentHash: cleanString(file.contentHash, 256),
+      rawRetained: false,
+    },
+    converterUploadId: cleanString(body.converterUploadId, 128),
+    targetTemplateId: cleanString(body.targetTemplateId, 128),
+    sourceSignatureHash: cleanString(body.sourceSignatureHash, 256),
+  };
+  const workspaceId = cleanString(body.workspaceId, 64);
+  if (workspaceId) payload.workspaceId = workspaceId;
+  return payload;
+}
+
+function sanitizeSummary(value) {
+  if (value == null || typeof value !== "object") return value;
+  if (Buffer.isBuffer(value)) return undefined;
+  if (Array.isArray(value)) {
+    return value.map(sanitizeSummary).filter((item) => item !== undefined);
+  }
+  return Object.fromEntries(
+    Object.entries(value)
+      .filter(([key]) => !UNSAFE_METADATA_KEYS.has(key.toLowerCase()))
+      .map(([key, item]) => [key, sanitizeSummary(item)])
+      .filter(([, item]) => item !== undefined),
+  );
+}
+
+function serializeStudentSession(session) {
+  return {
+    id: String(session._id || session.id),
+    workspaceId: session.workspaceId == null ? null : String(session.workspaceId),
+    ownerScope: session.ownerScope,
+    mode: session.mode,
+    status: session.status,
+    file: {
+      originalName: session.file?.originalName || "",
+      sizeBytes: Number(session.file?.sizeBytes || 0),
+      extension: session.file?.extension || "",
+      contentHash: session.file?.contentHash || "",
+      rawRetained: false,
+    },
+    converterUploadId: session.converterUploadId || "",
+    targetTemplateId: session.targetTemplateId || "",
+    sourceSignatureHash: session.sourceSignatureHash || "",
+    summary: sanitizeSummary(session.summary || {}),
+    retentionExpiresAt: session.retentionExpiresAt || null,
+    createdAt: session.createdAt || null,
+    updatedAt: session.updatedAt || null,
+  };
+}
+
+function sessionIsOwnedByUser(session, userId) {
+  if (String(session.userId || "") !== String(userId || "")) return false;
+  return session.ownerScope === buildOwnerScope({
+    userId,
+    workspaceId: session.workspaceId,
+  });
+}
+
+function sessionIsExpired(session, now = new Date()) {
+  if (["expired", "deleted"].includes(session.status)) return true;
+  const retentionExpiresAt = new Date(session.retentionExpiresAt).getTime();
+  return !Number.isFinite(retentionExpiresAt) || retentionExpiresAt <= now.getTime();
+}
+
+function studentContextMatchesSession(claims, session) {
+  return (
+    String(claims.session_id || "") === String(session._id || session.id || "") &&
+    String(claims.user_id || "") === String(session.userId || "") &&
+    String(claims.owner_scope || "") === String(session.ownerScope || "") &&
+    String(claims.workspace_id || "") === String(session.workspaceId || "")
+  );
+}
+
+function verifySessionContext(req, session, res) {
+  const token = req.headers["x-student-context"];
+  if (!token) {
+    res.status(401).json({ success: false, message: "Thiếu student context" });
+    return false;
+  }
+  try {
+    const claims = verifyStudentContextToken(token, "analyze");
+    if (!studentContextMatchesSession(claims, session)) {
+      res.status(403).json({ success: false, message: "Student context không thuộc phiên này" });
+      return false;
+    }
+    return true;
+  } catch (error) {
+    res.status(401).json({ success: false, message: error.message });
+    return false;
+  }
+}
+
+async function findWorkspaceForUser(workspaceId, userId) {
+  if (!mongoose.isValidObjectId(workspaceId)) return null;
+  const workspace = await AccountingWorkspace.findOne({ _id: workspaceId, isActive: true });
+  return workspace && userCanAccessWorkspace(workspace, userId) ? workspace : null;
+}
+
+async function findAccessibleSession(sessionId, userId) {
+  if (!mongoose.isValidObjectId(sessionId)) return null;
+  const session = await StudentFileSession.findOne({ _id: sessionId, userId });
+  if (!session || !sessionIsOwnedByUser(session, userId)) return null;
+  if (session.workspaceId && !(await findWorkspaceForUser(session.workspaceId, userId))) {
+    return null;
+  }
+  return session;
+}
+
+function createContextToken(session) {
+  return createStudentContextToken({
+    sessionId: session._id,
+    userId: session.userId,
+    ownerScope: session.ownerScope,
+    workspaceId: session.workspaceId,
+    allowedScopes: STUDENT_CONTEXT_SCOPES,
+  });
+}
+
+async function createStudentSession(req, res) {
+  try {
+    const payload = cleanStudentSessionPayload(req.body);
+    if (!payload.file.originalName) {
+      return res.status(400).json({ success: false, message: "Tên file là bắt buộc" });
+    }
+    if (!Number.isFinite(payload.file.sizeBytes) || payload.file.sizeBytes < 0) {
+      return res.status(400).json({ success: false, message: "Kích thước file không hợp lệ" });
+    }
+
+    const workspace = payload.workspaceId
+      ? await findWorkspaceForUser(payload.workspaceId, req.user._id)
+      : null;
+    if (payload.workspaceId && !workspace) {
+      return res.status(403).json({
+        success: false,
+        message: "Không có quyền sử dụng hồ sơ doanh nghiệp này",
+      });
+    }
+
+    const session = await StudentFileSession.create({
+      ...payload,
+      userId: req.user._id,
+      workspaceId: workspace?._id || null,
+      ownerScope: buildOwnerScope({ userId: req.user._id, workspaceId: workspace?._id }),
+      retentionExpiresAt: new Date(Date.now() + DEFAULT_RETENTION_MS),
+    });
+    return res.status(201).json({
+      success: true,
+      session: serializeStudentSession(session),
+      contextToken: createContextToken(session),
+    });
+  } catch (error) {
+    return res.status(500).json({ success: false, message: "Không thể tạo phiên học", error: error.message });
+  }
+}
+
+async function getStudentSession(req, res) {
+  try {
+    const session = await findAccessibleSession(req.params.id, req.user._id);
+    if (!session) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+    if (sessionIsExpired(session)) {
+      return res.status(410).json({ success: false, message: "Phiên học đã hết hạn" });
+    }
+    if (!verifySessionContext(req, session, res)) return undefined;
+    return res.json({ success: true, session: serializeStudentSession(session) });
+  } catch (error) {
+    return res.status(500).json({ success: false, message: "Không thể tải phiên học", error: error.message });
+  }
+}
+
+async function deleteStudentSession(req, res) {
+  try {
+    const session = await findAccessibleSession(req.params.id, req.user._id);
+    if (!session) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+    if (!verifySessionContext(req, session, res)) return undefined;
+    await session.deleteOne();
+    return res.json({ success: true });
+  } catch (error) {
+    return res.status(500).json({ success: false, message: "Không thể xoá phiên học", error: error.message });
+  }
+}
+
+async function refreshStudentContext(req, res) {
+  try {
+    const session = await findAccessibleSession(req.params.id, req.user._id);
+    if (!session) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+    if (sessionIsExpired(session)) {
+      return res.status(410).json({ success: false, message: "Phiên học đã hết hạn" });
+    }
+    if (!verifySessionContext(req, session, res)) return undefined;
+    return res.json({
+      success: true,
+      session: serializeStudentSession(session),
+      contextToken: createContextToken(session),
+    });
+  } catch (error) {
+    return res.status(500).json({ success: false, message: "Không thể làm mới context", error: error.message });
+  }
+}
+
+module.exports = {
+  cleanStudentSessionPayload,
+  createStudentSession,
+  deleteStudentSession,
+  getStudentSession,
+  refreshStudentContext,
+  serializeStudentSession,
+  sessionIsExpired,
+  sessionIsOwnedByUser,
+  studentContextMatchesSession,
+};
diff --git a/backend/routes/student.js b/backend/routes/student.js
new file mode 100755
index 0000000..5dfacef
--- /dev/null
+++ b/backend/routes/student.js
@@ -0,0 +1,22 @@
+const express = require("express");
+const requireDb = require("../middleware/requireDb");
+const { protect } = require("../middleware/auth");
+const {
+  createStudentSession,
+  deleteStudentSession,
+  getStudentSession,
+  refreshStudentContext,
+} = require("../controllers/studentSessionController");
+
+const router = express.Router();
+const asyncRoute = (handler) => (req, res, next) => {
+  Promise.resolve(handler(req, res, next)).catch(next);
+};
+
+router.use(requireDb, protect);
+router.post("/sessions", asyncRoute(createStudentSession));
+router.get("/sessions/:id", asyncRoute(getStudentSession));
+router.delete("/sessions/:id", asyncRoute(deleteStudentSession));
+router.post("/sessions/:id/context", asyncRoute(refreshStudentContext));
+
+module.exports = router;
diff --git a/backend/tests/studentSessions.test.js b/backend/tests/studentSessions.test.js
new file mode 100755
index 0000000..8d7c864
--- /dev/null
+++ b/backend/tests/studentSessions.test.js
@@ -0,0 +1,323 @@
+const assert = require("node:assert/strict");
+const test = require("node:test");
+const jwt = require("jsonwebtoken");
+
+const {
+  createStudentContextToken,
+  verifyStudentContextToken,
+} = require("../services/conversionContextService");
+const { buildOwnerScope } = require("../services/studentSessionService");
+const StudentFileSession = require("../models/StudentFileSession");
+const {
+  cleanStudentSessionPayload,
+  getStudentSession,
+  sessionIsExpired,
+  serializeStudentSession,
+  sessionIsOwnedByUser,
+  studentContextMatchesSession,
+} = require("../controllers/studentSessionController");
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
+
+test("student session payload keeps metadata and discards raw rows", () => {
+  assert.deepEqual(
+    cleanStudentSessionPayload({
+      workspaceId: " workspace-1 ",
+      file: {
+        originalName: " ../sales.xlsx ",
+        sizeBytes: "1024",
+        extension: "XLSX",
+        contentHash: " sha256:example ",
+      },
+      converterUploadId: " upload-1 ",
+      targetTemplateId: " bsn_sales ",
+      sourceSignatureHash: " source-hash ",
+      rawRows: [{ customer: "confidential" }],
+      workbookBytes: "confidential bytes",
+    }),
+    {
+      workspaceId: "workspace-1",
+      file: {
+        originalName: "..sales.xlsx",
+        sizeBytes: 1024,
+        extension: ".xlsx",
+        contentHash: "sha256:example",
+        rawRetained: false,
+      },
+      converterUploadId: "upload-1",
+      targetTemplateId: "bsn_sales",
+      sourceSignatureHash: "source-hash",
+    },
+  );
+});
+
+test("student session serializer never exposes raw workbook content", () => {
+  const session = {
+    _id: "session-1",
+    userId: "user-1",
+    workspaceId: "workspace-1",
+    ownerScope: "workspace:workspace-1",
+    mode: "student_assistant",
+    status: "created",
+    file: {
+      originalName: "sales.xlsx",
+      sizeBytes: 1024,
+      extension: ".xlsx",
+      contentHash: "sha256:example",
+      rawRetained: false,
+      rawRows: [{ customer: "confidential" }],
+    },
+    summary: { sheetCount: 2, rawRows: [{ customer: "confidential" }] },
+    retentionExpiresAt: new Date("2026-07-18T00:00:00Z"),
+    rawRows: [{ customer: "confidential" }],
+    workbookBytes: "confidential bytes",
+  };
+
+  const payload = serializeStudentSession(session);
+  assert.equal(payload.id, "session-1");
+  assert.equal(payload.file.rawRows, undefined);
+  assert.equal(payload.summary.rawRows, undefined);
+  assert.equal(payload.rawRows, undefined);
+  assert.equal(payload.workbookBytes, undefined);
+});
+
+test("student session ownership requires the matching user and owner scope", () => {
+  const session = {
+    userId: "user-1",
+    workspaceId: "workspace-1",
+    ownerScope: "workspace:workspace-1",
+  };
+
+  assert.equal(sessionIsOwnedByUser(session, "user-1"), true);
+  assert.equal(sessionIsOwnedByUser(session, "user-2"), false);
+  assert.equal(
+    sessionIsOwnedByUser({ ...session, ownerScope: "user:user-1" }, "user-1"),
+    false,
+  );
+});
+
+test("student context must match the requested session owner", () => {
+  const session = {
+    _id: "session-1",
+    userId: "user-1",
+    workspaceId: "workspace-1",
+    ownerScope: "workspace:workspace-1",
+  };
+  const claims = verifyStudentContextToken(
+    createStudentContextToken({
+      sessionId: "session-1",
+      userId: "user-1",
+      ownerScope: "workspace:workspace-1",
+      workspaceId: "workspace-1",
+      allowedScopes: ["analyze"],
+    }),
+    "analyze",
+  );
+
+  assert.equal(studentContextMatchesSession(claims, session), true);
+  assert.equal(
+    studentContextMatchesSession({ ...claims, session_id: "session-2" }, session),
+    false,
+  );
+  assert.equal(
+    studentContextMatchesSession({ ...claims, owner_scope: "user:user-1" }, session),
+    false,
+  );
+});
+
+test("student session expiry includes elapsed retention and terminal statuses", () => {
+  const now = new Date("2026-07-17T12:00:00Z");
+
+  assert.equal(
+    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:00:00Z"), status: "created" }, now),
+    true,
+  );
+  assert.equal(
+    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "expired" }, now),
+    true,
+  );
+  assert.equal(
+    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "deleted" }, now),
+    true,
+  );
+  assert.equal(
+    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "created" }, now),
+    false,
+  );
+});
+
+test("GET rejects an expired student session before the Mongo TTL sweep", async () => {
+  const session = {
+    _id: "507f1f77bcf86cd799439011",
+    userId: "user-1",
+    workspaceId: null,
+    ownerScope: "user:user-1",
+    status: "created",
+    retentionExpiresAt: new Date(0),
+  };
+  const token = createStudentContextToken({
+    sessionId: session._id,
+    userId: session.userId,
+    ownerScope: session.ownerScope,
+    allowedScopes: ["analyze"],
+  });
+  const originalFindOne = StudentFileSession.findOne;
+  const response = {
+    statusCode: 200,
+    body: null,
+    status(code) {
+      this.statusCode = code;
+      return this;
+    },
+    json(body) {
+      this.body = body;
+      return body;
+    },
+  };
+
+  StudentFileSession.findOne = async () => session;
+  try {
+    await getStudentSession(
+      {
+        params: { id: session._id },
+        user: { _id: session.userId },
+        headers: { "x-student-context": token },
+      },
+      response,
+    );
+  } finally {
+    StudentFileSession.findOne = originalFindOne;
+  }
+
+  assert.equal(response.statusCode, 410);
+  assert.match(response.body.message, /hết hạn/i);
+});
+
+test("student session model expires metadata and has no raw workbook fields", () => {
+  const retentionExpiresAt = StudentFileSession.schema.path("retentionExpiresAt");
+  assert.equal(retentionExpiresAt.options.expires, 0);
+  assert.equal(StudentFileSession.schema.path("rawRows"), undefined);
+  assert.equal(StudentFileSession.schema.path("workbookBytes"), undefined);
+  assert.equal(StudentFileSession.schema.path("file.rawBytes"), undefined);
+});
