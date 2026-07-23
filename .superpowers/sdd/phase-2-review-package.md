# Phase 2 review package - resumed final
diff --git a/backend/routes/internal.js b/backend/routes/internal.js
index 19ce72b..72fc3b4 100644
--- a/backend/routes/internal.js
+++ b/backend/routes/internal.js
@@ -14,6 +14,11 @@ const {
   findInternalReconstructionProfile,
   recordInternalReconstructionEvent,
 } = require("../controllers/reconstructionController");
+const {
+  checkStudentSessionActive,
+  recordStudentAnalysisCompleted,
+  recordStudentQuestionEvent,
+} = require("../controllers/studentSessionController");
 router.get("/master-data/context/:snapshotSetHash", (req, res, next) => {
   Promise.resolve(getInternalMasterDataContext(req, res, next)).catch(next);
 });
@@ -47,5 +52,14 @@ router.post("/reconstructions/:id/events", (req, res, next) => {
     next,
   );
 });
+router.post("/student/sessions/:id/events", (req, res, next) => {
+  Promise.resolve(recordStudentAnalysisCompleted(req, res, next)).catch(next);
+});
+router.post("/student/sessions/:id/questions", (req, res, next) => {
+  Promise.resolve(recordStudentQuestionEvent(req, res, next)).catch(next);
+});
+router.get("/student/sessions/:id/active", (req, res, next) => {
+  Promise.resolve(checkStudentSessionActive(req, res, next)).catch(next);
+});
 
 module.exports = router;
diff --git a/converter/app/main.py b/converter/app/main.py
index d51c5d4..8f5b5cf 100644
--- a/converter/app/main.py
+++ b/converter/app/main.py
@@ -56,15 +56,51 @@ from app.reconstruction_workflow import (
     update_reconstruction_draft,
     validate_reconstruction,
 )
+from app.student_store import cleanup_expired_student_uploads
+from app.student_models import StudentQuestionRequest
+from app.student_workflow import (
+    StudentWorkflowError,
+    analyze_student_file,
+    ask_student_question,
+    get_student_overview,
+    get_student_source_row,
+)
 
 
 app = FastAPI(title="EzFormat Converter API")
 _RECONSTRUCTION_RATE_LOCK = threading.Lock()
 _RECONSTRUCTION_RATE_BUCKETS: dict[str, tuple[float, int]] = {}
+_STUDENT_CLEANUP_LOCK = threading.Lock()
+_LAST_STUDENT_CLEANUP = 0.0
+
+
+def _opportunistic_student_cleanup(*, force: bool = False) -> None:
+    global _LAST_STUDENT_CLEANUP
+    try:
+        interval_seconds = max(
+            1,
+            int(os.getenv("STUDENT_UPLOAD_CLEANUP_INTERVAL_SECONDS", "300")),
+        )
+    except ValueError:
+        interval_seconds = 300
+    now = time.monotonic()
+    with _STUDENT_CLEANUP_LOCK:
+        if not force and now - _LAST_STUDENT_CLEANUP < interval_seconds:
+            return
+        _LAST_STUDENT_CLEANUP = now
+    cleanup_expired_student_uploads()
+
+
+async def _cleanup_student_uploads_at_startup() -> None:
+    await run_in_threadpool(_opportunistic_student_cleanup, force=True)
+
+
+app.router.add_event_handler("startup", _cleanup_student_uploads_at_startup)
 
 
 @app.middleware("http")
 async def attach_request_id(request: Request, call_next):
+    await run_in_threadpool(_opportunistic_student_cleanup)
     supplied = str(request.headers.get("x-request-id") or "").strip()
     request_id = supplied[:128] if supplied else uuid.uuid4().hex
     request.state.request_id = request_id
@@ -156,7 +192,17 @@ def healthz() -> dict[str, object]:
             "voucherReconstruction": os.getenv(
                 "VOUCHER_RECONSTRUCTION_ENABLED", "false"
             ).lower()
-            == "true"
+            == "true",
+            "studentAssistant": os.getenv(
+                "STUDENT_ASSISTANT_ENABLED", "false"
+            ).lower()
+            == "true",
+            "studentFileExplain": os.getenv(
+                "STUDENT_FILE_EXPLAIN_ENABLED", "false"
+            ).lower()
+            == "true",
+            "studentFileQa": os.getenv("STUDENT_FILE_QA_ENABLED", "false").lower()
+            == "true",
         },
     }
 
@@ -208,6 +254,7 @@ async def analyze_raw_upload(
     file: Annotated[UploadFile, File()],
     target_template_id: Annotated[str | None, Form()] = None,
     conversion_context_token: Annotated[str | None, Form()] = None,
+    student_context_token: Annotated[str | None, Form()] = None,
 ) -> JSONResponse:
     try:
         content = await file.read()
@@ -217,12 +264,84 @@ async def analyze_raw_upload(
             content=content,
             requested_target_template_id=target_template_id,
             conversion_context_token=conversion_context_token,
+            student_context_token=student_context_token,
         )
         return JSONResponse(jsonable_encoder(payload))
     except ValueError as exc:
         raise HTTPException(status_code=400, detail=str(exc)) from exc
 
 
+@app.post("/api/v1/student/sessions/analyze")
+async def analyze_student_session(
+    file: Annotated[UploadFile, File()],
+    context_token: Annotated[str, Form()],
+    target_template_id: Annotated[str | None, Form()] = None,
+) -> JSONResponse:
+    try:
+        payload = await run_in_threadpool(
+            analyze_student_file,
+            filename=file.filename or "upload.xlsx",
+            content=await file.read(),
+            context_token=context_token,
+            target_template_id=target_template_id,
+        )
+        return JSONResponse(jsonable_encoder(payload))
+    except StudentWorkflowError as exc:
+        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
+
+
+@app.get("/api/v1/student/sessions/{session_id}/overview")
+async def student_session_overview(
+    session_id: str,
+    x_student_context: Annotated[str | None, Header()] = None,
+) -> JSONResponse:
+    try:
+        payload = await run_in_threadpool(
+            get_student_overview,
+            session_id=session_id,
+            context_token=x_student_context or "",
+        )
+        return JSONResponse(jsonable_encoder(payload))
+    except StudentWorkflowError as exc:
+        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
+
+
+@app.post("/api/v1/student/sessions/{session_id}/questions")
+async def student_session_question(
+    session_id: str,
+    request: StudentQuestionRequest,
+    x_student_context: Annotated[str | None, Header()] = None,
+) -> JSONResponse:
+    try:
+        payload = await run_in_threadpool(
+            ask_student_question,
+            session_id=session_id,
+            context_token=x_student_context or "",
+            question=request.question,
+        )
+        return JSONResponse(jsonable_encoder(payload))
+    except StudentWorkflowError as exc:
+        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
+
+
+@app.get("/api/v1/student/sessions/{session_id}/source-rows/{worksheet_row}")
+async def student_session_source_row(
+    session_id: str,
+    worksheet_row: int,
+    x_student_context: Annotated[str | None, Header()] = None,
+) -> JSONResponse:
+    try:
+        payload = await run_in_threadpool(
+            get_student_source_row,
+            session_id=session_id,
+            worksheet_row=worksheet_row,
+            context_token=x_student_context or "",
+        )
+        return JSONResponse(jsonable_encoder(payload))
+    except StudentWorkflowError as exc:
+        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
+
+
 @app.post("/api/v1/reconstructions/analyze")
 async def analyze_voucher_reconstruction(
     file: Annotated[UploadFile, File()],
@@ -474,6 +593,7 @@ async def preview_misa_mapping(body: dict) -> JSONResponse:
             defaults=body.get("defaults") or {},
             formulas=body.get("formulas") or {},
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -495,6 +615,7 @@ async def readiness_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             edited_rows=edited_rows if isinstance(edited_rows, list) else None,
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -515,6 +636,7 @@ async def confirm_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             profile_name=body.get("profile_name"),
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -579,6 +701,7 @@ async def export_conversion_rows(body: dict) -> Response:
                 edited_rows=edited_rows if isinstance(edited_rows, list) and edited_rows else None,
                 acknowledge_warnings=bool(body.get("acknowledge_warnings")),
                 conversion_context_token=body.get("conversion_context_token"),
+                student_context_token=body.get("student_context_token"),
             )
         except KeyError as exc:
             raise HTTPException(status_code=404, detail=str(exc)) from exc
diff --git a/frontend/package.json b/frontend/package.json
index 6a5599b..56423c9 100644
--- a/frontend/package.json
+++ b/frontend/package.json
@@ -5,6 +5,7 @@
   "type": "module",
   "scripts": {
     "dev": "vite",
+    "test": "node --test src/utils/converterUx.test.mjs src/utils/masterData.test.mjs src/utils/reconstruction.test.mjs src/utils/studentAssistant.test.mjs src/utils/validationUi.test.mjs src/hooks/useConverterApi.status.test.mjs",
     "build": "vite build",
     "preview": "vite preview",
     "lint": "eslint .",
diff --git a/backend/models/StudentQuestionEvent.js b/backend/models/StudentQuestionEvent.js
new file mode 100755
index 0000000..2a31f2e
--- /dev/null
+++ b/backend/models/StudentQuestionEvent.js
@@ -0,0 +1,50 @@
+const mongoose = require("mongoose");
+
+const studentQuestionEventSchema = new mongoose.Schema(
+  {
+    sessionId: {
+      type: mongoose.Schema.Types.ObjectId,
+      ref: "StudentFileSession",
+      required: true,
+      index: true,
+    },
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
+    question: { type: String, required: true, trim: true, maxlength: 2000 },
+    answerType: {
+      type: String,
+      required: true,
+      enum: ["deterministic_file_query", "deterministic_explanation", "unsupported"],
+    },
+    evidenceIds: {
+      type: [String],
+      default: [],
+      validate: {
+        validator: (values) => values.length <= 20,
+        message: "Evidence identifiers vượt quá giới hạn",
+      },
+    },
+    evidenceCount: { type: Number, required: true, min: 0 },
+    outcome: {
+      type: String,
+      required: true,
+      enum: ["supported", "unsupported", "ai_unavailable"],
+    },
+  },
+  { timestamps: true },
+);
+
+studentQuestionEventSchema.index({ sessionId: 1, createdAt: -1 });
+
+module.exports = mongoose.model("StudentQuestionEvent", studentQuestionEventSchema);
diff --git a/backend/controllers/studentSessionController.js b/backend/controllers/studentSessionController.js
new file mode 100755
index 0000000..3836b2c
--- /dev/null
+++ b/backend/controllers/studentSessionController.js
@@ -0,0 +1,672 @@
+const crypto = require("crypto");
+const mongoose = require("mongoose");
+const StudentFileSession = require("../models/StudentFileSession");
+const StudentQuestionEvent = require("../models/StudentQuestionEvent");
+const AccountingWorkspace = require("../models/AccountingWorkspace");
+const { userCanAccessWorkspace } = require("../services/masterDataService");
+const {
+  createStudentContextToken,
+  verifyStudentContextToken,
+} = require("../services/conversionContextService");
+const { buildOwnerScope } = require("../services/studentSessionService");
+
+const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
+const UNSAFE_METADATA_KEYS = new Set([
+  "rawrows",
+  "rows",
+  "workbook",
+  "workbookbytes",
+  "rawbytes",
+  "bytes",
+]);
+const STUDENT_TEMPLATE_IDS = new Set([
+  "bsn_sales",
+  "bsn_purchase",
+  "misa_purchase_domestic",
+  "sales_goods",
+  "sales_service",
+  "purchase_goods",
+  "purchase_service",
+]);
+const SAFE_MAPPING_COUNT_KEYS = ["mapped", "default", "formula", "unresolved", "mixed"];
+const SAFE_ISSUE_COUNT_KEYS = ["blocker", "warning", "info"];
+const STUDENT_ANSWER_TYPES = new Set([
+  "deterministic_file_query",
+  "deterministic_explanation",
+  "unsupported",
+]);
+const STUDENT_QUESTION_OUTCOMES = new Set([
+  "supported",
+  "unsupported",
+  "ai_unavailable",
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
+function studentContextScopesFromFlags(env = process.env) {
+  const enabled = (name) => String(env[name] || "false").toLowerCase() === "true";
+  if (!enabled("STUDENT_ASSISTANT_ENABLED")) return [];
+
+  const scopes = [];
+  if (enabled("STUDENT_FILE_EXPLAIN_ENABLED")) scopes.push("analyze", "explain");
+  if (enabled("STUDENT_FILE_QA_ENABLED")) scopes.push("ask");
+  if (enabled("STUDENT_CHECK_WORK_ENABLED")) scopes.push("attempt");
+  if (enabled("STUDENT_ACCOUNTING_MAP_ENABLED")) scopes.push("accounting_map");
+  if (enabled("STUDENT_RECONCILIATION_ENABLED")) scopes.push("reconcile");
+  if (enabled("STUDENT_INTERNSHIP_ENABLED")) scopes.push("export");
+  return scopes;
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
+function cleanNonNegativeNumber(value) {
+  const parsed = Number(value);
+  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
+}
+
+function cleanCountMap(value, allowedKeys) {
+  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
+  const cleaned = {};
+  for (const key of allowedKeys) {
+    const count = cleanNonNegativeNumber(value[key]);
+    if (count !== undefined) cleaned[key] = count;
+  }
+  return Object.keys(cleaned).length ? cleaned : undefined;
+}
+
+function cleanAnalysisSummary(value) {
+  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
+  const summary = {};
+  for (const key of [
+    "dataRowCount",
+    "documentCount",
+    "recognizedColumns",
+    "unresolvedColumns",
+    "explanationCount",
+    "readinessScore",
+  ]) {
+    const cleaned = cleanNonNegativeNumber(value[key]);
+    if (cleaned !== undefined) summary[key] = cleaned;
+  }
+  const mappingCounts = cleanCountMap(value.mappingCounts, SAFE_MAPPING_COUNT_KEYS);
+  if (mappingCounts) summary.mappingCounts = mappingCounts;
+  const issueCounts = cleanCountMap(value.issueCounts, SAFE_ISSUE_COUNT_KEYS);
+  if (issueCounts) summary.issueCounts = issueCounts;
+  const masterDataStatus = cleanString(value.masterDataStatus, 64);
+  if (masterDataStatus) summary.masterDataStatus = masterDataStatus;
+  const stateHash = cleanString(value.stateHash, 256);
+  if (stateHash) summary.stateHash = stateHash;
+  const readinessStatus = cleanString(value.readinessStatus, 64);
+  if (readinessStatus) summary.readinessStatus = readinessStatus;
+  return summary;
+}
+
+function cleanAnalysisCompletedPayload(body = {}) {
+  const targetTemplateId = cleanString(body.targetTemplateId, 128);
+  return {
+    event: cleanString(body.event, 64),
+    converterUploadId: cleanString(body.converterUploadId, 128),
+    targetTemplateId: STUDENT_TEMPLATE_IDS.has(targetTemplateId) ? targetTemplateId : "",
+    sourceSignatureHash: cleanString(body.sourceSignatureHash, 256),
+    summary: cleanAnalysisSummary(body.summary),
+    status: "analyzed",
+  };
+}
+
+function cleanQuestionEventPayload(body = {}) {
+  const answerType = cleanString(body.answerType, 64);
+  const outcome = cleanString(body.outcome, 64);
+  const evidenceIds = Array.isArray(body.evidenceIds)
+    ? body.evidenceIds
+        .map((value) => cleanString(value, 128))
+        .filter(Boolean)
+        .slice(0, 20)
+    : [];
+  const evidenceCount = cleanNonNegativeNumber(body.evidenceCount);
+  return {
+    event: cleanString(body.event, 64),
+    question: cleanString(body.question, 2000),
+    answerType: STUDENT_ANSWER_TYPES.has(answerType) ? answerType : "",
+    evidenceIds,
+    evidenceCount: evidenceCount === undefined ? 0 : evidenceCount,
+    outcome: STUDENT_QUESTION_OUTCOMES.has(outcome) ? outcome : "",
+  };
+}
+
+function secureTokenEquals(actual, expected) {
+  const actualBuffer = Buffer.from(String(actual || ""));
+  const expectedBuffer = Buffer.from(String(expected || ""));
+  return (
+    actualBuffer.length === expectedBuffer.length &&
+    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
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
+    allowedScopes: studentContextScopesFromFlags(),
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
+async function recordStudentAnalysisCompleted(req, res) {
+  try {
+    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
+    if (!expectedServiceToken) {
+      return res.status(503).json({
+        success: false,
+        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
+      });
+    }
+    if (
+      !secureTokenEquals(
+        req.headers["x-converter-service-token"],
+        expectedServiceToken,
+      )
+    ) {
+      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
+    }
+
+    const contextToken = req.headers["x-student-context"];
+    if (!contextToken) {
+      return res.status(401).json({ success: false, message: "Thiếu student context" });
+    }
+    let claims;
+    try {
+      claims = verifyStudentContextToken(contextToken, "analyze");
+    } catch (error) {
+      return res.status(401).json({ success: false, message: error.message });
+    }
+    if (String(req.params.id || "") !== String(claims.session_id || "")) {
+      return res.status(403).json({
+        success: false,
+        message: "Student context không thuộc phiên này",
+      });
+    }
+
+    const payload = cleanAnalysisCompletedPayload(req.body);
+    if (payload.event !== "analysis_completed") {
+      return res.status(400).json({ success: false, message: "Student event không hợp lệ" });
+    }
+    if (
+      !payload.converterUploadId ||
+      !payload.targetTemplateId ||
+      !payload.sourceSignatureHash
+    ) {
+      return res.status(400).json({
+        success: false,
+        message: "Metadata phân tích chưa đầy đủ",
+      });
+    }
+    if (!mongoose.isValidObjectId(claims.session_id)) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+
+    const sessionFilter = {
+      _id: claims.session_id,
+      userId: claims.user_id,
+      ownerScope: claims.owner_scope,
+      workspaceId: claims.workspace_id || null,
+      retentionExpiresAt: { $gt: new Date() },
+      status: { $nin: ["expired", "deleted"] },
+      $or: [
+        { converterUploadId: "" },
+        { converterUploadId: payload.converterUploadId },
+        { converterUploadId: { $exists: false } },
+        { converterUploadId: null },
+      ],
+    };
+    const session = await StudentFileSession.findOneAndUpdate(
+      sessionFilter,
+      {
+        $set: {
+          converterUploadId: payload.converterUploadId,
+          targetTemplateId: payload.targetTemplateId,
+          sourceSignatureHash: payload.sourceSignatureHash,
+          summary: payload.summary,
+          status: "analyzed",
+        },
+      },
+      { new: true, runValidators: true },
+    );
+    if (session) {
+      return res.json({ success: true, session: serializeStudentSession(session) });
+    }
+
+    const existingSession = await StudentFileSession.findOne({
+      _id: claims.session_id,
+      userId: claims.user_id,
+    });
+    if (!existingSession || !studentContextMatchesSession(claims, existingSession)) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+    if (sessionIsExpired(existingSession)) {
+      return res.status(410).json({ success: false, message: "Phiên học đã hết hạn" });
+    }
+    if (
+      existingSession.converterUploadId &&
+      existingSession.converterUploadId !== payload.converterUploadId
+    ) {
+      return res.status(409).json({
+        success: false,
+        message: "Phiên học đã liên kết với upload khác",
+      });
+    }
+    return res.status(409).json({
+      success: false,
+      message: "Phiên học đang được cập nhật",
+    });
+  } catch (error) {
+    return res.status(500).json({
+      success: false,
+      message: "Không thể cập nhật kết quả phân tích",
+      error: error.message,
+    });
+  }
+}
+
+async function recordStudentQuestionEvent(req, res) {
+  try {
+    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
+    if (!expectedServiceToken) {
+      return res.status(503).json({
+        success: false,
+        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
+      });
+    }
+    if (
+      !secureTokenEquals(
+        req.headers["x-converter-service-token"],
+        expectedServiceToken,
+      )
+    ) {
+      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
+    }
+
+    const contextToken = req.headers["x-student-context"];
+    if (!contextToken) {
+      return res.status(401).json({ success: false, message: "Thiếu student context" });
+    }
+    let claims;
+    try {
+      claims = verifyStudentContextToken(contextToken, "ask");
+    } catch (error) {
+      return res.status(401).json({ success: false, message: error.message });
+    }
+    if (String(req.params.id || "") !== String(claims.session_id || "")) {
+      return res.status(403).json({
+        success: false,
+        message: "Student context không thuộc phiên này",
+      });
+    }
+    if (!mongoose.isValidObjectId(claims.session_id)) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học" });
+    }
+
+    const payload = cleanQuestionEventPayload(req.body);
+    if (
+      payload.event !== "question_answered" ||
+      !payload.question ||
+      !payload.answerType ||
+      !payload.outcome ||
+      payload.evidenceCount < payload.evidenceIds.length
+    ) {
+      return res.status(400).json({
+        success: false,
+        message: "Student question event không hợp lệ",
+      });
+    }
+
+    const session = await StudentFileSession.findOne({
+      _id: claims.session_id,
+      userId: claims.user_id,
+      ownerScope: claims.owner_scope,
+      workspaceId: claims.workspace_id || null,
+      retentionExpiresAt: { $gt: new Date() },
+      status: { $nin: ["expired", "deleted"] },
+      converterUploadId: { $nin: ["", null] },
+    });
+    if (!session) {
+      return res.status(404).json({ success: false, message: "Không tìm thấy phiên học đang hoạt động" });
+    }
+
+    const event = await StudentQuestionEvent.create({
+      sessionId: session._id,
+      userId: session.userId,
+      workspaceId: session.workspaceId || null,
+      ownerScope: session.ownerScope,
+      question: payload.question,
+      answerType: payload.answerType,
+      evidenceIds: payload.evidenceIds,
+      evidenceCount: payload.evidenceCount,
+      outcome: payload.outcome,
+    });
+    return res.status(202).json({
+      success: true,
+      event: {
+        id: String(event._id),
+        answerType: event.answerType,
+        evidenceCount: event.evidenceCount,
+        outcome: event.outcome,
+      },
+    });
+  } catch (error) {
+    return res.status(500).json({
+      success: false,
+      message: "Không thể ghi nhận câu hỏi student",
+      error: error.message,
+    });
+  }
+}
+
+async function checkStudentSessionActive(req, res) {
+  try {
+    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
+    if (!expectedServiceToken) {
+      return res.status(503).json({
+        success: false,
+        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
+      });
+    }
+    if (
+      !secureTokenEquals(
+        req.headers["x-converter-service-token"],
+        expectedServiceToken,
+      )
+    ) {
+      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
+    }
+
+    const contextToken = req.headers["x-student-context"];
+    if (!contextToken) {
+      return res.status(401).json({ success: false, message: "Thiếu student context" });
+    }
+    let claims;
+    try {
+      claims = verifyStudentContextToken(contextToken, "ask");
+    } catch (error) {
+      return res.status(401).json({ success: false, message: error.message });
+    }
+    if (String(req.params.id || "") !== String(claims.session_id || "")) {
+      return res.status(403).json({
+        success: false,
+        message: "Student context không thuộc phiên này",
+      });
+    }
+    if (!mongoose.isValidObjectId(claims.session_id)) {
+      return res.status(410).json({ success: false, message: "Phiên học không còn hoạt động" });
+    }
+
+    const session = await StudentFileSession.findById(claims.session_id);
+    if (!session) {
+      return res.status(410).json({ success: false, message: "Phiên học không còn hoạt động" });
+    }
+    if (!studentContextMatchesSession(claims, session)) {
+      return res.status(403).json({
+        success: false,
+        message: "Student context không khớp owner hoặc workspace của phiên",
+      });
+    }
+    if (sessionIsExpired(session)) {
+      return res.status(410).json({ success: false, message: "Phiên học đã hết hạn" });
+    }
+    const uploadId = cleanString(req.query?.uploadId, 128);
+    if (
+      !uploadId ||
+      !session.converterUploadId ||
+      String(session.converterUploadId) !== uploadId
+    ) {
+      return res.status(409).json({
+        success: false,
+        message: "Phiên học chưa liên kết đúng converter upload",
+      });
+    }
+    return res.json({
+      success: true,
+      active: true,
+      sessionId: String(session._id),
+    });
+  } catch (error) {
+    return res.status(503).json({
+      success: false,
+      message: "Không thể kiểm tra trạng thái phiên học",
+      error: error.message,
+    });
+  }
+}
+
+module.exports = {
+  checkStudentSessionActive,
+  cleanAnalysisCompletedPayload,
+  cleanQuestionEventPayload,
+  cleanStudentSessionPayload,
+  createContextToken,
+  createStudentSession,
+  deleteStudentSession,
+  getStudentSession,
+  recordStudentAnalysisCompleted,
+  recordStudentQuestionEvent,
+  refreshStudentContext,
+  serializeStudentSession,
+  sessionIsExpired,
+  sessionIsOwnedByUser,
+  studentContextMatchesSession,
+  studentContextScopesFromFlags,
+};
diff --git a/backend/tests/studentQuestions.test.js b/backend/tests/studentQuestions.test.js
new file mode 100755
index 0000000..d5c114e
--- /dev/null
+++ b/backend/tests/studentQuestions.test.js
@@ -0,0 +1,337 @@
+const assert = require("node:assert/strict");
+const test = require("node:test");
+
+const StudentFileSession = require("../models/StudentFileSession");
+const StudentQuestionEvent = require("../models/StudentQuestionEvent");
+const { createStudentContextToken } = require("../services/conversionContextService");
+const {
+  checkStudentSessionActive,
+  cleanQuestionEventPayload,
+  recordStudentQuestionEvent,
+} = require("../controllers/studentSessionController");
+
+process.env.CONVERSION_CONTEXT_SECRET = "test-student-question-secret";
+
+function responseRecorder() {
+  return {
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
+}
+
+function questionToken(overrides = {}) {
+  return createStudentContextToken({
+    sessionId: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    ownerScope: "user:507f1f77bcf86cd799439012",
+    workspaceId: null,
+    allowedScopes: ["analyze", "explain", "ask"],
+    ...overrides,
+  });
+}
+
+test("question event payload keeps metadata only and rejects raw row fields", () => {
+  assert.deepEqual(
+    cleanQuestionEventPayload({
+      event: "question_answered",
+      question: "  Có bao nhiêu hóa đơn?  ",
+      answerType: "deterministic_file_query",
+      evidenceIds: [" evidence-1 ", "evidence-2"],
+      evidenceCount: 22,
+      outcome: "supported",
+      rows: [{ customer: "confidential" }],
+      rawRows: [{ supplier: "confidential" }],
+      evidence: [{ actual: "secret" }],
+      answer: "full answer",
+    }),
+    {
+      event: "question_answered",
+      question: "Có bao nhiêu hóa đơn?",
+      answerType: "deterministic_file_query",
+      evidenceIds: ["evidence-1", "evidence-2"],
+      evidenceCount: 22,
+      outcome: "supported",
+    },
+  );
+});
+
+test("StudentQuestionEvent schema contains no full row or answer payload", () => {
+  assert.equal(StudentQuestionEvent.schema.path("question").instance, "String");
+  assert.equal(StudentQuestionEvent.schema.path("answerType").instance, "String");
+  assert.equal(StudentQuestionEvent.schema.path("evidenceIds").instance, "Array");
+  assert.equal(StudentQuestionEvent.schema.path("evidenceCount").instance, "Number");
+  assert.equal(StudentQuestionEvent.schema.path("outcome").instance, "String");
+  assert.equal(StudentQuestionEvent.schema.path("rows"), undefined);
+  assert.equal(StudentQuestionEvent.schema.path("rawRows"), undefined);
+  assert.equal(StudentQuestionEvent.schema.path("evidence"), undefined);
+  assert.equal(StudentQuestionEvent.schema.path("answer"), undefined);
+});
+
+test("internal question event is ask-scope and owner bounded", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const session = {
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: null,
+    ownerScope: "user:507f1f77bcf86cd799439012",
+    converterUploadId: "upload-1",
+    status: "analyzed",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+  };
+  const token = questionToken();
+  const originalFindOne = StudentFileSession.findOne;
+  const originalCreate = StudentQuestionEvent.create;
+  const findCalls = [];
+  const createCalls = [];
+  StudentFileSession.findOne = async (filter) => {
+    findCalls.push(filter);
+    return session;
+  };
+  StudentQuestionEvent.create = async (payload) => {
+    createCalls.push(payload);
+    return { _id: "507f1f77bcf86cd799439099", ...payload };
+  };
+
+  try {
+    const response = responseRecorder();
+    await recordStudentQuestionEvent(
+      {
+        params: { id: session._id },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": token,
+        },
+        body: {
+          event: "question_answered",
+          question: "Có bao nhiêu hóa đơn?",
+          answerType: "deterministic_file_query",
+          evidenceIds: ["evidence-1", "evidence-2"],
+          evidenceCount: 2,
+          outcome: "supported",
+          rows: [{ confidential: true }],
+        },
+      },
+      response,
+    );
+
+    assert.equal(response.statusCode, 202);
+    assert.deepEqual(response.body, {
+      success: true,
+      event: {
+        id: "507f1f77bcf86cd799439099",
+        answerType: "deterministic_file_query",
+        evidenceCount: 2,
+        outcome: "supported",
+      },
+    });
+    assert.equal(findCalls.length, 1);
+    assert.equal(String(findCalls[0]._id), session._id);
+    assert.equal(String(findCalls[0].userId), session.userId);
+    assert.equal(findCalls[0].ownerScope, session.ownerScope);
+    assert.equal(findCalls[0].workspaceId, null);
+    assert.deepEqual(findCalls[0].status, { $nin: ["expired", "deleted"] });
+    assert.equal(createCalls.length, 1);
+    assert.deepEqual(createCalls[0], {
+      sessionId: session._id,
+      userId: session.userId,
+      workspaceId: null,
+      ownerScope: session.ownerScope,
+      question: "Có bao nhiêu hóa đơn?",
+      answerType: "deterministic_file_query",
+      evidenceIds: ["evidence-1", "evidence-2"],
+      evidenceCount: 2,
+      outcome: "supported",
+    });
+  } finally {
+    StudentFileSession.findOne = originalFindOne;
+    StudentQuestionEvent.create = originalCreate;
+  }
+});
+
+test("internal question event rejects a different session before database access", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const originalFindOne = StudentFileSession.findOne;
+  const originalCreate = StudentQuestionEvent.create;
+  let databaseCalled = false;
+  StudentFileSession.findOne = async () => {
+    databaseCalled = true;
+    return null;
+  };
+  StudentQuestionEvent.create = async () => {
+    databaseCalled = true;
+    return null;
+  };
+
+  try {
+    const response = responseRecorder();
+    await recordStudentQuestionEvent(
+      {
+        params: { id: "507f1f77bcf86cd799439099" },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": questionToken(),
+        },
+        body: { event: "question_answered" },
+      },
+      response,
+    );
+
+    assert.equal(response.statusCode, 403);
+    assert.equal(databaseCalled, false);
+  } finally {
+    StudentFileSession.findOne = originalFindOne;
+    StudentQuestionEvent.create = originalCreate;
+  }
+});
+
+test("internal active check validates session user owner workspace and ask scope", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const session = {
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: "507f1f77bcf86cd799439013",
+    ownerScope: "workspace:507f1f77bcf86cd799439013",
+    converterUploadId: "upload-1",
+    status: "analyzed",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+  };
+  const token = questionToken({
+    ownerScope: session.ownerScope,
+    workspaceId: session.workspaceId,
+  });
+  const originalFindById = StudentFileSession.findById;
+  const calls = [];
+  StudentFileSession.findById = async (sessionId) => {
+    calls.push(String(sessionId));
+    return session;
+  };
+
+  try {
+    const response = responseRecorder();
+    await checkStudentSessionActive(
+      {
+        params: { id: session._id },
+        query: { uploadId: "upload-1" },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": token,
+        },
+      },
+      response,
+    );
+
+    assert.equal(response.statusCode, 200);
+    assert.deepEqual(response.body, {
+      success: true,
+      active: true,
+      sessionId: session._id,
+    });
+    assert.deepEqual(calls, [session._id]);
+  } finally {
+    StudentFileSession.findById = originalFindById;
+  }
+});
+
+test("internal active check returns 410 for expired or deleted sessions", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const originalFindById = StudentFileSession.findById;
+  StudentFileSession.findById = async () => ({
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: null,
+    ownerScope: "user:507f1f77bcf86cd799439012",
+    status: "deleted",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+  });
+
+  try {
+    const response = responseRecorder();
+    await checkStudentSessionActive(
+      {
+        params: { id: "507f1f77bcf86cd799439011" },
+        query: { uploadId: "upload-1" },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": questionToken(),
+        },
+      },
+      response,
+    );
+    assert.equal(response.statusCode, 410);
+  } finally {
+    StudentFileSession.findById = originalFindById;
+  }
+});
+
+test("internal active check returns 403 for owner or workspace mismatch", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const originalFindById = StudentFileSession.findById;
+  StudentFileSession.findById = async () => ({
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: "507f1f77bcf86cd799439013",
+    ownerScope: "workspace:507f1f77bcf86cd799439013",
+    status: "analyzed",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+  });
+
+  try {
+    const response = responseRecorder();
+    await checkStudentSessionActive(
+      {
+        params: { id: "507f1f77bcf86cd799439011" },
+        query: { uploadId: "upload-1" },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": questionToken(),
+        },
+      },
+      response,
+    );
+    assert.equal(response.statusCode, 403);
+  } finally {
+    StudentFileSession.findById = originalFindById;
+  }
+});
+
+test("internal active check requires exact non-empty converter upload binding", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const originalFindById = StudentFileSession.findById;
+  StudentFileSession.findById = async () => ({
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: null,
+    ownerScope: "user:507f1f77bcf86cd799439012",
+    converterUploadId: "upload-bound",
+    status: "analyzed",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+  });
+
+  try {
+    for (const uploadId of [undefined, "", "upload-other"]) {
+      const response = responseRecorder();
+      await checkStudentSessionActive(
+        {
+          params: { id: "507f1f77bcf86cd799439011" },
+          query: { uploadId },
+          headers: {
+            "x-converter-service-token": "converter-service-secret",
+            "x-student-context": questionToken(),
+          },
+        },
+        response,
+      );
+      assert.equal(response.statusCode, 409);
+    }
+  } finally {
+    StudentFileSession.findById = originalFindById;
+  }
+});
diff --git a/converter/app/student_queries.py b/converter/app/student_queries.py
new file mode 100755
index 0000000..b97c9a0
--- /dev/null
+++ b/converter/app/student_queries.py
@@ -0,0 +1,773 @@
+from __future__ import annotations
+
+import hashlib
+import re
+import unicodedata
+from datetime import date, datetime
+from decimal import Decimal
+from typing import Any, Callable
+
+from app.excel_io import InputTable
+from app.parsing import parse_number
+from app.student_field_dictionary import field_definition
+from app.student_models import StudentAnswer, StudentAnswerEvidence
+
+
+MAX_ANSWER_EVIDENCE = 20
+_DOCUMENT_TERMS = ("ma hoa don", "so hoa don", "so chung tu", "so phieu nhap")
+_UNSUPPORTED_PATTERNS = (
+    "duoc khau tru",
+    "duoc tru khi tinh thue",
+    "dung luat",
+    "hop le khong",
+    "chac chan",
+    "nen hach toan",
+    "tai khoan nao",
+    "dung tai khoan",
+)
+
+
+def answer_question(question: str, session_state: dict[str, Any]) -> StudentAnswer:
+    normalized_question = _normalize(question)
+    if not normalized_question:
+        return _unsupported(
+            "unsupported_legal_or_business_judgment",
+            "Câu hỏi đang trống nên chưa thể truy vấn file.",
+            "empty_question",
+        )
+
+    intent = _classify_intent(normalized_question)
+    handlers: dict[str, Callable[[str, dict[str, Any]], StudentAnswer]] = {
+        "file_summary": _answer_file_summary,
+        "locate_column": _answer_locate_column,
+        "locate_rows": _answer_locate_rows,
+        "explain_mapping": _answer_explain_mapping,
+        "explain_issue": _answer_explain_issue,
+        "aggregate_amount": _answer_aggregate_amount,
+        "count_documents": _answer_count_documents,
+        "find_duplicates": _answer_find_duplicates,
+        "find_vat_mismatches": _answer_find_vat_mismatches,
+        "required_actions_before_export": _answer_required_actions,
+        "concept_explanation": _answer_concept,
+        "unsupported_legal_or_business_judgment": _answer_unsupported_judgment,
+    }
+    if intent is None:
+        if not bool(session_state.get("ai_available")):
+            return _unsupported(
+                "unsupported_legal_or_business_judgment",
+                "Câu hỏi chưa khớp truy vấn deterministic và AI bổ sung hiện không khả dụng.",
+                "ai_unavailable",
+                outcome="ai_unavailable",
+            )
+        return _unsupported(
+            "unsupported_legal_or_business_judgment",
+            "Câu hỏi này chưa thuộc nhóm truy vấn file được hỗ trợ.",
+            "unsupported_question",
+        )
+
+    answer = handlers[intent](normalized_question, session_state)
+    if answer.outcome == "supported":
+        validate_answer_evidence(answer, session_state)
+    return answer
+
+
+def validate_answer_evidence(
+    answer: StudentAnswer,
+    session_state: dict[str, Any],
+) -> None:
+    table = _table(session_state)
+    headers = set(table.headers)
+    target_headers = set(str(item) for item in session_state.get("target_headers") or [])
+    first_data_row = table.header_row_index + 2
+    last_data_row = first_data_row + len(table.rows) - 1
+    sheet_name = str(table.sheet_name or "")
+    issues = list((session_state.get("readiness") or {}).get("issues") or [])
+
+    if answer.outcome == "supported" and not answer.evidence:
+        raise ValueError("answer evidence is required")
+    if answer.evidence_count < len(answer.evidence):
+        raise ValueError("answer evidence count is invalid")
+
+    for evidence in answer.evidence:
+        expected_id = _evidence_id(
+            session_state,
+            evidence.kind,
+            evidence.sheet,
+            evidence.row,
+            evidence.field,
+            evidence.target_field,
+            evidence.issue_code,
+        )
+        if evidence.id != expected_id:
+            raise ValueError("answer evidence id is invalid")
+        if evidence.sheet != sheet_name:
+            raise ValueError("answer evidence sheet is invalid")
+
+        if evidence.kind == "source_column":
+            if evidence.field not in headers or evidence.row is not None:
+                raise ValueError("answer evidence column is invalid")
+            if evidence.actual is not None or evidence.expected is not None:
+                raise ValueError("answer evidence column values are invalid")
+            continue
+
+        if evidence.kind == "template":
+            if evidence.target_field not in target_headers or evidence.row is not None:
+                raise ValueError("answer evidence template field is invalid")
+            continue
+
+        if evidence.field not in headers:
+            raise ValueError("answer evidence field is invalid")
+        if evidence.row is None or not first_data_row <= evidence.row <= last_data_row:
+            raise ValueError("answer evidence row is invalid")
+        data_row_number = evidence.row - table.header_row_index - 1
+        source_row = table.rows[data_row_number - 1]
+
+        if evidence.kind == "source_cell":
+            if evidence.actual != _json_value(source_row.get(evidence.field)):
+                raise ValueError("answer evidence value is invalid")
+            if evidence.expected is not None:
+                raise ValueError("answer evidence expected value is invalid")
+            continue
+
+        matching_issue = next(
+            (
+                issue
+                for issue in issues
+                if str(issue.get("code") or "") == str(evidence.issue_code or "")
+                and int(issue.get("row") or 0) == data_row_number
+                and str(issue.get("field") or "") == str(evidence.target_field or "")
+            ),
+            None,
+        )
+        if matching_issue is None:
+            raise ValueError("answer evidence issue is invalid")
+        if evidence.actual != _json_value(matching_issue.get("actual")):
+            raise ValueError("answer evidence issue actual is invalid")
+        if evidence.expected != _json_value(matching_issue.get("expected")):
+            raise ValueError("answer evidence issue expected is invalid")
+
+
+def _classify_intent(question: str) -> str | None:
+    if any(pattern in question for pattern in _UNSUPPORTED_PATTERNS):
+        return "unsupported_legal_or_business_judgment"
+    if any(
+        pattern in question
+        for pattern in (
+            "can sua gi",
+            "can xu ly gi",
+            "bat buoc lam",
+            "truoc khi export",
+            "truoc khi xuat",
+            "truoc khi import",
+            "cac buoc can lam",
+        )
+    ):
+        return "required_actions_before_export"
+    if (
+        "giai thich" in question
+        and any(term in question for term in ("loi", "blocker", "canh bao", "vi sao"))
+    ) or ("vi sao" in question and any(term in question for term in ("loi", "blocker", "canh bao"))):
+        return "explain_issue"
+    if "trung" in question:
+        return "find_duplicates"
+    if any(term in question for term in ("vat", "thue gtgt", "tien thue")) and any(
+        term in question for term in ("lech", "khong khop", "loi", "chenh lech")
+    ):
+        return "find_vat_mismatches"
+    if any(
+        pattern in question
+        for pattern in ("bao nhieu hoa don", "dem so chung tu", "bao nhieu chung tu")
+    ):
+        return "count_documents"
+    if "tong quan" in question or "tom tat" in question or "tinh trang file" in question:
+        return "file_summary"
+    if "file" in question and ("bao nhieu dong" in question or "co gi" in question):
+        return "file_summary"
+    if any(term in question for term in ("mapping", " map ", "map vao", "ghep sang", "dua vao dau")):
+        return "explain_mapping"
+    if "cot" in question and any(
+        term in question for term in ("nam o dau", "tim cot", "la cot nao", "co cot")
+    ):
+        return "locate_column"
+    if "dong" in question and any(
+        term in question for term in ("nhung dong", "tim", "xuat hien", "o dong", "dong nao", "nam o")
+    ):
+        return "locate_rows"
+    if any(term in question for term in ("tinh tong", "cong cot", "cong tien", "tong thanh tien", "tong thanh toan", "tong so luong", "tong don gia")):
+        return "aggregate_amount"
+    if any(term in question for term in ("y nghia gi", "khai niem", "dung de lam gi")):
+        return "concept_explanation"
+    return None
+
+
+def _answer_file_summary(question: str, state: dict[str, Any]) -> StudentAnswer:
+    table = _table(state)
+    if not table.rows or not table.headers:
+        return _unsupported("file_summary", "File không có dòng dữ liệu để trích dẫn.", "no_evidence")
+    summary = state.get("summary") or {}
+    row_count = int(summary.get("data_row_count") or len(table.rows))
+    document_count = summary.get("document_count")
+    issue_counts = summary.get("issue_counts") or {}
+    evidence = [_cell_evidence(state, 1, table.headers[0])]
+    if len(table.rows) > 1:
+        evidence.append(_cell_evidence(state, len(table.rows), table.headers[0]))
+    document_text = (
+        "chưa đủ dữ liệu để đếm chứng từ"
+        if document_count is None
+        else f"{int(document_count)} chứng từ ước tính"
+    )
+    return _supported(
+        "file_summary",
+        (
+            f"File có {row_count} dòng dữ liệu, {document_text}, "
+            f"{int(issue_counts.get('blocker') or 0)} lỗi chặn và "
+            f"{int(issue_counts.get('warning') or 0)} cảnh báo."
+        ),
+        evidence,
+    )
+
+
+def _answer_locate_column(question: str, state: dict[str, Any]) -> StudentAnswer:
+    header = _select_header(question, state)
+    if header is None:
+        return _unsupported("locate_column", "Không tìm thấy cột phù hợp trong file đang mở.", "no_evidence")
+    evidence = [_column_evidence(state, header)]
+    return _supported(
+        "locate_column",
+        f"Cột nguồn phù hợp là '{header}' trên sheet '{_table(state).sheet_name or ''}'.",
+        evidence,
+    )
+
+
+def _answer_locate_rows(question: str, state: dict[str, Any]) -> StudentAnswer:
+    table = _table(state)
+    preferred_header = _select_header(question, state)
+    search_headers = [preferred_header] if preferred_header else table.headers
+    matches: list[tuple[int, str]] = []
+    for row_number, row in enumerate(table.rows, start=1):
+        for header in search_headers:
+            value = row.get(header)
+            normalized_value = _normalize(value)
+            if len(normalized_value) >= 2 and normalized_value in question:
+                matches.append((row_number, header))
+                break
+    if not matches:
+        return _unsupported("locate_rows", "Không tìm thấy dòng khớp câu hỏi trong file.", "no_evidence")
+    evidence = [_cell_evidence(state, row_number, header) for row_number, header in matches]
+    return _supported(
+        "locate_rows",
+        f"Tìm thấy {len(matches)} dòng khớp trong file đang mở.",
+        evidence,
+        evidence_count=len(matches),
+    )
+
+
+def _answer_explain_mapping(question: str, state: dict[str, Any]) -> StudentAnswer:
+    header = _select_header(question, state)
+    mapping = state.get("mapping") or {}
+    target_spec = mapping.get(header) if header else None
+    if not header or not target_spec:
+        return _unsupported(
+            "explain_mapping",
+            "Không có mapping deterministic phù hợp để giải thích.",
+            "no_evidence",
+        )
+    targets = target_spec if isinstance(target_spec, list) else [target_spec]
+    return _supported(
+        "explain_mapping",
+        f"Cột '{header}' đang được map vào {', '.join(str(item) for item in targets)}.",
+        [_column_evidence(state, header, target_field=str(targets[0]))],
+        answer_type="deterministic_explanation",
+    )
+
+
+def _answer_explain_issue(question: str, state: dict[str, Any]) -> StudentAnswer:
+    issues = list((state.get("readiness") or {}).get("issues") or [])
+    requested_worksheet_row = _requested_row(question)
+    if requested_worksheet_row is not None:
+        requested_data_row = _worksheet_data_row(state, requested_worksheet_row)
+        if requested_data_row is None:
+            return _unsupported(
+                "explain_issue",
+                "Dòng được hỏi là header hoặc nằm ngoài vùng dữ liệu đang hoạt động.",
+                "row_out_of_range",
+            )
+        issues = [
+            issue
+            for issue in issues
+            if int(issue.get("row") or 0) == requested_data_row
+        ]
+    elif "blocker" in question:
+        issues = [issue for issue in issues if issue.get("severity") == "blocker"]
+    if not issues:
+        return _unsupported("explain_issue", "Không có issue phù hợp để giải thích.", "no_evidence")
+    evidence = [_issue_evidence(state, issue) for issue in issues if issue.get("row")]
+    evidence = [item for item in evidence if item is not None]
+    if not evidence:
+        return _unsupported("explain_issue", "Issue không có bằng chứng dòng để trích dẫn.", "no_evidence")
+    return _supported(
+        "explain_issue",
+        f"Có {len(issues)} issue phù hợp. {str(issues[0].get('message') or '').strip()}",
+        evidence,
+        evidence_count=len(issues),
+        answer_type="deterministic_explanation",
+        rule_sources=_issue_sources(issues),
+    )
+
+
+def _answer_aggregate_amount(question: str, state: dict[str, Any]) -> StudentAnswer:
+    header = _select_header(question, state, numeric_only=True)
+    table = _table(state)
+    if header is None:
+        return _unsupported("aggregate_amount", "Không xác định được cột số cần cộng.", "no_evidence")
+    total = Decimal("0")
+    contributing_rows: list[int] = []
+    for row_number, row in enumerate(table.rows, start=1):
+        parsed = parse_number(row.get(header))
+        if parsed is None:
+            continue
+        total += Decimal(str(parsed))
+        contributing_rows.append(row_number)
+    if not contributing_rows:
+        return _unsupported("aggregate_amount", "Cột được hỏi không có giá trị số.", "no_evidence")
+    evidence = [_cell_evidence(state, row_number, header) for row_number in contributing_rows]
+    return _supported(
+        "aggregate_amount",
+        f"Tổng cột '{header}' là {_format_decimal(total)} trên {len(contributing_rows)} dòng có số.",
+        evidence,
+        evidence_count=len(contributing_rows),
+    )
+
+
+def _answer_count_documents(question: str, state: dict[str, Any]) -> StudentAnswer:
+    header = _document_header(state)
+    table = _table(state)
+    if header is None:
+        return _unsupported("count_documents", "Không xác định được cột chứng từ.", "no_evidence")
+    first_rows: dict[str, int] = {}
+    for row_number, row in enumerate(table.rows, start=1):
+        value = str(row.get(header) or "").strip()
+        if value:
+            first_rows.setdefault(value, row_number)
+    if not first_rows:
+        return _unsupported("count_documents", "Cột chứng từ không có giá trị.", "no_evidence")
+    evidence = [_cell_evidence(state, row_number, header) for row_number in first_rows.values()]
+    return _supported(
+        "count_documents",
+        f"File có {len(first_rows)} chứng từ khác nhau theo cột '{header}'.",
+        evidence,
+        evidence_count=len(first_rows),
+    )
+
+
+def _answer_find_duplicates(question: str, state: dict[str, Any]) -> StudentAnswer:
+    issues = _issues_by_code(state, "duplicate_document_key")
+    if issues:
+        evidence = [_issue_evidence(state, issue) for issue in issues]
+        evidence = [item for item in evidence if item is not None]
+        if not evidence:
+            return _unsupported(
+                "find_duplicates",
+                "Các duplicate issue không có evidence hợp lệ trong bảng đang hoạt động.",
+                "no_evidence",
+            )
+        return _supported(
+            "find_duplicates",
+            f"Có {len(issues)} dòng chứng từ trùng nhưng thông tin không thống nhất.",
+            evidence,
+            evidence_count=len(issues),
+            rule_sources=_issue_sources(issues),
+        )
+    header = _document_header(state)
+    if header is None:
+        return _unsupported("find_duplicates", "Không có cột chứng từ để kiểm tra trùng.", "no_evidence")
+    return _supported(
+        "find_duplicates",
+        "Không phát hiện duplicate_document_key trong readiness hiện tại.",
+        [_column_evidence(state, header)],
+    )
+
+
+def _answer_find_vat_mismatches(question: str, state: dict[str, Any]) -> StudentAnswer:
+    issues = _issues_by_code(state, "vat_amount_mismatch")
+    if issues:
+        evidence = [_issue_evidence(state, issue) for issue in issues]
+        evidence = [item for item in evidence if item is not None]
+        if not evidence:
+            return _unsupported(
+                "find_vat_mismatches",
+                "Các VAT issue không có evidence hợp lệ trong bảng đang hoạt động.",
+                "no_evidence",
+            )
+        return _supported(
+            "find_vat_mismatches",
+            f"Có {len(issues)} dòng có tiền thuế GTGT không khớp.",
+            evidence,
+            evidence_count=len(issues),
+            rule_sources=_issue_sources(issues),
+        )
+    header = _select_header("tien thue gtgt", state)
+    if header is None:
+        return _unsupported("find_vat_mismatches", "Không có cột tiền thuế để kiểm tra.", "no_evidence")
+    return _supported(
+        "find_vat_mismatches",
+        "Không phát hiện vat_amount_mismatch trong readiness hiện tại.",
+        [_column_evidence(state, header)],
+    )
+
+
+def _answer_required_actions(question: str, state: dict[str, Any]) -> StudentAnswer:
+    issues = list((state.get("readiness") or {}).get("issues") or [])
+    actionable = [issue for issue in issues if issue.get("severity") in {"blocker", "warning"}]
+    if actionable:
+        evidence = [_issue_evidence(state, issue) for issue in actionable if issue.get("row")]
+        evidence = [item for item in evidence if item is not None]
+        if not evidence:
+            return _unsupported(
+                "required_actions_before_export",
+                "Các action hiện tại không có bằng chứng dòng để trích dẫn.",
+                "no_evidence",
+            )
+        blockers = sum(issue.get("severity") == "blocker" for issue in actionable)
+        warnings = sum(issue.get("severity") == "warning" for issue in actionable)
+        return _supported(
+            "required_actions_before_export",
+            f"Cần xử lý {blockers} lỗi chặn và rà soát {warnings} cảnh báo trước khi export.",
+            evidence,
+            evidence_count=len(actionable),
+            rule_sources=_issue_sources(actionable),
+        )
+    table = _table(state)
+    if not table.headers:
+        return _unsupported(
+            "required_actions_before_export",
+            "Không có evidence để xác nhận trạng thái export.",
+            "no_evidence",
+        )
+    return _supported(
+        "required_actions_before_export",
+        "Readiness hiện tại không có blocker hoặc warning, nhưng vẫn cần đối chiếu nghiệp vụ.",
+        [_column_evidence(state, table.headers[0])],
+    )
+
+
+def _answer_concept(question: str, state: dict[str, Any]) -> StudentAnswer:
+    header = _select_header(question, state)
+    if header is None:
+        return _unsupported("concept_explanation", "Không xác định được trường cần giải thích.", "no_evidence")
+    target_spec = (state.get("mapping") or {}).get(header)
+    target = target_spec[0] if isinstance(target_spec, list) and target_spec else target_spec or header
+    definition = field_definition(str(state.get("target_template_id") or ""), str(target))
+    return _supported(
+        "concept_explanation",
+        f"{definition['title']}: {definition['meaning_vi']}",
+        [_column_evidence(state, header, target_field=str(target))],
+        answer_type="deterministic_explanation",
+        rule_sources=[definition["source"]["source_url"]]
+        if definition["source"].get("source_url")
+        else [],
+    )
+
+
+def _answer_unsupported_judgment(question: str, state: dict[str, Any]) -> StudentAnswer:
+    return _unsupported(
+        "unsupported_legal_or_business_judgment",
+        "File hiện tại không đủ căn cứ deterministic để kết luận pháp lý, thuế hoặc lựa chọn tài khoản chắc chắn.",
+        "unsupported_legal_or_business_judgment",
+        needs_professional_review=True,
+    )
+
+
+def _supported(
+    intent: str,
+    answer: str,
+    evidence: list[StudentAnswerEvidence],
+    *,
+    evidence_count: int | None = None,
+    answer_type: str = "deterministic_file_query",
+    rule_sources: list[str] | None = None,
+) -> StudentAnswer:
+    bounded = evidence[:MAX_ANSWER_EVIDENCE]
+    if not bounded:
+        return _unsupported(
+            intent,
+            "Không có evidence hợp lệ để hỗ trợ câu trả lời từ file.",
+            "no_evidence",
+        )
+    return StudentAnswer(
+        answer=answer,
+        intent=intent,
+        answer_type=answer_type,
+        confidence="verified",
+        evidence=bounded,
+        evidence_count=evidence_count if evidence_count is not None else len(evidence),
+        rule_sources=rule_sources or [],
+        needs_professional_review=False,
+        unsupported_reason=None,
+        outcome="supported",
+    )
+
+
+def _unsupported(
+    intent: str,
+    answer: str,
+    reason: str,
+    *,
+    outcome: str = "unsupported",
+    needs_professional_review: bool = False,
+) -> StudentAnswer:
+    return StudentAnswer(
+        answer=answer,
+        intent=intent,
+        answer_type="unsupported",
+        confidence="not_available",
+        evidence=[],
+        evidence_count=0,
+        rule_sources=[],
+        needs_professional_review=needs_professional_review,
+        unsupported_reason=reason,
+        outcome=outcome,
+    )
+
+
+def _table(state: dict[str, Any]) -> InputTable:
+    table = state.get("table")
+    if not isinstance(table, InputTable):
+        raise ValueError("Student question state table không hợp lệ")
+    return table
+
+
+def _select_header(
+    question: str,
+    state: dict[str, Any],
+    *,
+    numeric_only: bool = False,
+) -> str | None:
+    table = _table(state)
+    normalized_headers = {header: _normalize(header) for header in table.headers}
+    direct = sorted(
+        (
+            header
+            for header, normalized in normalized_headers.items()
+            if normalized and normalized in question
+        ),
+        key=lambda header: len(normalized_headers[header]),
+        reverse=True,
+    )
+    if direct:
+        return direct[0]
+
+    mapping = state.get("mapping") or {}
+    for source, target_spec in mapping.items():
+        targets = target_spec if isinstance(target_spec, list) else [target_spec]
+        if any(_normalize(target) in question for target in targets if _normalize(target)):
+            return source if source in table.headers else None
+
+    aliases = (
+        (("tong thanh toan", "tong tien thanh toan"), ("tong thanh toan", "tong tien")),
+        (("tien thue", "thue gtgt", "vat"), ("tien thue",)),
+        (("thue suat",), ("thue suat", "percent thue")),
+        (("thanh tien",), ("thanh tien",)),
+        (("don gia",), ("don gia", "dgvnd")),
+        (("so luong",), ("so luong", "luong")),
+        (("ten khach hang", "khach hang"), ("ten khach hang",)),
+        (("ten nha cung cap", "nha cung cap"), ("ten nha cung cap", "ten ncc")),
+        (("ma hang",), ("ma hang", "mathang")),
+        (("ma hoa don", "so hoa don", "hoa don", "chung tu"), _DOCUMENT_TERMS),
+        (("ngay hoa don",), ("ngay hoa don",)),
+    )
+    for question_terms, header_terms in aliases:
+        if not any(term in question for term in question_terms):
+            continue
+        for header, normalized in normalized_headers.items():
+            if any(term in normalized for term in header_terms):
+                return header
+
+    if numeric_only:
+        return None
+    return None
+
+
+def _document_header(state: dict[str, Any]) -> str | None:
+    table = _table(state)
+    for header in table.headers:
+        normalized = _normalize(header)
+        if any(term == normalized or term in normalized for term in _DOCUMENT_TERMS):
+            return header
+    return None
+
+
+def _cell_evidence(
+    state: dict[str, Any],
+    data_row_number: int,
+    field: str,
+    *,
+    target_field: str | None = None,
+) -> StudentAnswerEvidence:
+    table = _table(state)
+    worksheet_row = table.header_row_index + 1 + data_row_number
+    actual = _json_value(table.rows[data_row_number - 1].get(field))
+    return StudentAnswerEvidence(
+        id=_evidence_id(
+            state,
+            "source_cell",
+            table.sheet_name or "",
+            worksheet_row,
+            field,
+            target_field,
+            None,
+        ),
+        kind="source_cell",
+        sheet=table.sheet_name or "",
+        row=worksheet_row,
+        field=field,
+        target_field=target_field,
+        actual=actual,
+    )
+
+
+def _column_evidence(
+    state: dict[str, Any],
+    field: str,
+    *,
+    target_field: str | None = None,
+) -> StudentAnswerEvidence:
+    table = _table(state)
+    return StudentAnswerEvidence(
+        id=_evidence_id(
+            state,
+            "source_column",
+            table.sheet_name or "",
+            None,
+            field,
+            target_field,
+            None,
+        ),
+        kind="source_column",
+        sheet=table.sheet_name or "",
+        field=field,
+        target_field=target_field,
+    )
+
+
+def _issue_evidence(
+    state: dict[str, Any], issue: dict[str, Any]
+) -> StudentAnswerEvidence | None:
+    data_row_number = int(issue.get("row") or 0)
+    table = _table(state)
+    if not 1 <= data_row_number <= len(table.rows):
+        return None
+    source_field = _source_field_for_issue(state, issue)
+    if source_field is None:
+        return None
+    worksheet_row = table.header_row_index + 1 + data_row_number
+    target_field = str(issue.get("field") or "")
+    issue_code = str(issue.get("code") or "")
+    return StudentAnswerEvidence(
+        id=_evidence_id(
+            state,
+            "issue",
+            table.sheet_name or "",
+            worksheet_row,
+            source_field,
+            target_field,
+            issue_code,
+        ),
+        kind="issue",
+        sheet=table.sheet_name or "",
+        row=worksheet_row,
+        field=source_field,
+        target_field=target_field,
+        actual=_json_value(issue.get("actual")),
+        expected=_json_value(issue.get("expected")),
+        issue_code=issue_code,
+    )
+
+
+def _source_field_for_issue(state: dict[str, Any], issue: dict[str, Any]) -> str | None:
+    table = _table(state)
+    target = str(issue.get("field") or "")
+    if target in table.headers:
+        return target
+    for source, target_spec in (state.get("mapping") or {}).items():
+        targets = target_spec if isinstance(target_spec, list) else [target_spec]
+        if target in [str(item) for item in targets] and source in table.headers:
+            return source
+    code = str(issue.get("code") or "")
+    if code == "duplicate_document_key":
+        return _document_header(state)
+    if code == "vat_amount_mismatch":
+        return _select_header("tien thue gtgt", state)
+    return table.headers[0] if table.headers else None
+
+
+def _issues_by_code(state: dict[str, Any], code: str) -> list[dict[str, Any]]:
+    return [
+        issue
+        for issue in (state.get("readiness") or {}).get("issues") or []
+        if issue.get("code") == code
+    ]
+
+
+def _issue_sources(issues: list[dict[str, Any]]) -> list[str]:
+    return sorted({str(issue["source_url"]) for issue in issues if issue.get("source_url")})
+
+
+def _requested_row(question: str) -> int | None:
+    match = re.search(r"\bdong\s+(\d+)\b", question)
+    return int(match.group(1)) if match else None
+
+
+def _worksheet_data_row(state: dict[str, Any], worksheet_row: int) -> int | None:
+    table = _table(state)
+    header_worksheet_row = table.header_row_index + 1
+    first_data_row = header_worksheet_row + 1
+    last_data_row = header_worksheet_row + len(table.rows)
+    if not first_data_row <= worksheet_row <= last_data_row:
+        return None
+    return worksheet_row - header_worksheet_row
+
+
+def _evidence_id(
+    state: dict[str, Any],
+    kind: str,
+    sheet: str | None,
+    row: int | None,
+    field: str | None,
+    target_field: str | None,
+    issue_code: str | None,
+) -> str:
+    identity = "|".join(
+        (
+            str(state.get("state_hash") or ""),
+            kind,
+            str(sheet or ""),
+            str(row or ""),
+            str(field or ""),
+            str(target_field or ""),
+            str(issue_code or ""),
+        )
+    )
+    return "question-evidence-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
+
+
+def _normalize(value: Any) -> str:
+    text = str(value or "").replace("đ", "d").replace("Đ", "D")
+    decomposed = unicodedata.normalize("NFKD", text)
+    ascii_text = "".join(char for char in decomposed if not unicodedata.combining(char))
+    return re.sub(r"[^a-z0-9]+", " ", ascii_text.casefold()).strip()
+
+
+def _json_value(value: Any) -> Any:
+    if isinstance(value, (datetime, date, Decimal)):
+        return str(value)
+    if isinstance(value, float) and value.is_integer():
+        return int(value)
+    return value
+
+
+def _format_decimal(value: Decimal) -> str:
+    normalized = format(value, "f")
+    if "." in normalized:
+        normalized = normalized.rstrip("0").rstrip(".")
+    return normalized or "0"
diff --git a/converter/app/student_workflow.py b/converter/app/student_workflow.py
new file mode 100755
index 0000000..77069a9
--- /dev/null
+++ b/converter/app/student_workflow.py
@@ -0,0 +1,511 @@
+from __future__ import annotations
+
+import json
+import os
+from pathlib import Path
+from typing import Any
+
+from fastapi.encoders import jsonable_encoder
+
+from app.misa_templates import get_misa_template
+from app.misa_workflow import (
+    _read_metadata,
+    _read_upload_table,
+    analyze_upload,
+    preview_mapping,
+    readiness_mapping,
+)
+from app.student_context import StudentContextClaims, verify_student_context
+from app.student_explanations import (
+    build_student_explanations,
+    build_student_summary,
+    explanation_state_hash,
+)
+from app.student_queries import answer_question
+from app.student_session_client import (
+    StudentSessionClientError,
+    assert_student_session_active,
+    record_analysis_completed,
+    record_question_event,
+)
+from app.student_store import (
+    StudentUploadConflictError,
+    assert_no_student_upload_for_session,
+    assert_upload_owner,
+    claim_student_analysis,
+    find_student_upload_id,
+)
+
+
+OVERVIEW_FILENAME = "student-overview.json"
+MAX_STUDENT_PREVIEW_ROWS = 25
+
+
+class StudentWorkflowError(ValueError):
+    def __init__(self, status_code: int, message: str) -> None:
+        self.status_code = status_code
+        super().__init__(message)
+
+
+def analyze_student_file(
+    *,
+    filename: str,
+    content: bytes,
+    context_token: str,
+    target_template_id: str | None = None,
+) -> dict[str, Any]:
+    claims = _student_claims(context_token, "analyze")
+    _student_claims(context_token, "explain")
+    try:
+        with claim_student_analysis(claims):
+            assert_no_student_upload_for_session(claims)
+            try:
+                analyzed = analyze_upload(
+                    filename=filename,
+                    content=content,
+                    requested_target_template_id=target_template_id,
+                    student_context_token=context_token,
+                )
+            except ValueError as exc:
+                raise StudentWorkflowError(400, str(exc)) from exc
+
+            overview = _build_current_overview(
+                upload_id=str(analyzed["upload_id"]),
+                token=context_token,
+                claims=claims,
+            )
+            sync_payload = _analysis_completed_payload(overview)
+            try:
+                record_analysis_completed(context_token, sync_payload)
+                overview["session_sync"] = {"status": "synced", "message": None}
+            except StudentSessionClientError as exc:
+                overview["session_sync"] = {
+                    "status": "unavailable",
+                    "message": str(exc),
+                }
+            return overview
+    except StudentUploadConflictError as exc:
+        raise StudentWorkflowError(409, str(exc)) from exc
+
+
+def get_student_overview(*, session_id: str, context_token: str) -> dict[str, Any]:
+    claims = _student_claims(context_token, "explain")
+    normalized_session_id = str(session_id or "").strip()
+    if claims.session_id != normalized_session_id:
+        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
+    try:
+        upload_id = find_student_upload_id(claims)
+    except StudentUploadConflictError as exc:
+        raise StudentWorkflowError(409, str(exc)) from exc
+    except KeyError as exc:
+        raise StudentWorkflowError(404, "Không tìm thấy upload của phiên học") from exc
+    except ValueError as exc:
+        status_code = 410 if "hết hạn" in str(exc).lower() else 403
+        raise StudentWorkflowError(status_code, str(exc)) from exc
+
+    try:
+        metadata = _read_metadata(upload_id)
+        (
+            target_template_id,
+            mapping_source,
+            mapping_identity,
+            mapping,
+            defaults,
+            formulas,
+        ) = _effective_mapping(metadata)
+    except KeyError as exc:
+        raise StudentWorkflowError(404, str(exc)) from exc
+    except ValueError as exc:
+        raise StudentWorkflowError(400, str(exc)) from exc
+    current_state_hash = explanation_state_hash(
+        session_id=claims.session_id,
+        upload_id=upload_id,
+        target_template_id=target_template_id,
+        source_signature_hash=str((metadata.get("signature") or {}).get("hash") or ""),
+        mapping_source=mapping_source,
+        mapping_identity=mapping_identity,
+        mapping=mapping,
+        defaults=defaults,
+        formulas=formulas,
+    )
+    cached = _read_overview_cache(upload_id)
+    if cached and cached.get("student_state_hash") == current_state_hash:
+        return cached
+    return _build_current_overview(upload_id=upload_id, token=context_token, claims=claims)
+
+
+def ask_student_question(
+    *,
+    session_id: str,
+    context_token: str,
+    question: str,
+) -> dict[str, Any]:
+    claims, normalized_session_id, active_upload_id = _active_question_session(
+        session_id=session_id,
+        context_token=context_token,
+    )
+
+    overview = get_student_overview(
+        session_id=normalized_session_id,
+        context_token=context_token,
+    )
+    upload_id = str(overview["upload_id"])
+    if upload_id != active_upload_id:
+        raise StudentWorkflowError(409, "Student upload đã thay đổi trong khi kiểm tra phiên")
+    try:
+        table = _read_upload_table(upload_id)
+    except KeyError as exc:
+        raise StudentWorkflowError(404, str(exc)) from exc
+    except ValueError as exc:
+        raise StudentWorkflowError(400, str(exc)) from exc
+
+    state = {
+        "session_id": claims.session_id,
+        "upload_id": upload_id,
+        "state_hash": overview["student_state_hash"],
+        "target_template_id": overview["target_template_id"],
+        "target_headers": overview["target_headers"],
+        "table": table,
+        "mapping": overview["mapping_suggestion"].get("mapping") or {},
+        "defaults": overview["mapping_suggestion"].get("defaults") or {},
+        "formulas": overview["mapping_suggestion"].get("formulas") or {},
+        "summary": overview["student_summary"],
+        "readiness": overview["readiness"],
+        "ai_available": _student_ai_available(),
+    }
+    normalized_question = str(question or "").strip()
+    answer = answer_question(normalized_question, state)
+    payload = answer.model_dump(mode="json")
+    event = {
+        "event": "question_answered",
+        "sessionId": claims.session_id,
+        "question": normalized_question,
+        "answerType": answer.answer_type,
+        "evidenceIds": [item.id for item in answer.evidence],
+        "evidenceCount": answer.evidence_count,
+        "outcome": answer.outcome,
+    }
+    try:
+        record_question_event(context_token, event)
+        payload["event_sync"] = {"status": "synced", "message": None}
+    except StudentSessionClientError as exc:
+        payload["event_sync"] = {"status": "unavailable", "message": str(exc)}
+    return payload
+
+
+def get_student_source_row(
+    *,
+    session_id: str,
+    worksheet_row: int,
+    context_token: str,
+) -> dict[str, Any]:
+    claims, normalized_session_id, active_upload_id = _active_question_session(
+        session_id=session_id,
+        context_token=context_token,
+    )
+    overview = get_student_overview(
+        session_id=normalized_session_id,
+        context_token=context_token,
+    )
+    upload_id = str(overview["upload_id"])
+    if upload_id != active_upload_id:
+        raise StudentWorkflowError(409, "Student upload đã thay đổi trong khi kiểm tra phiên")
+    try:
+        table = _read_upload_table(upload_id)
+    except KeyError as exc:
+        raise StudentWorkflowError(404, str(exc)) from exc
+    except ValueError as exc:
+        raise StudentWorkflowError(400, str(exc)) from exc
+
+    header_worksheet_row = table.header_row_index + 1
+    data_row_number = int(worksheet_row) - header_worksheet_row
+    if not 1 <= data_row_number <= len(table.rows):
+        raise StudentWorkflowError(404, "Dòng nguồn nằm ngoài vùng dữ liệu đang hoạt động")
+    source_row = table.rows[data_row_number - 1]
+    return {
+        "session_id": claims.session_id,
+        "upload_id": upload_id,
+        "state_hash": overview["student_state_hash"],
+        "sheet": str(table.sheet_name or ""),
+        "header_row": header_worksheet_row,
+        "worksheet_row": int(worksheet_row),
+        "fields": [
+            {"field": header, "value": source_row.get(header)}
+            for header in table.headers
+        ],
+    }
+
+
+def _active_question_session(
+    *,
+    session_id: str,
+    context_token: str,
+) -> tuple[StudentContextClaims, str, str]:
+    if not _student_question_enabled():
+        raise StudentWorkflowError(404, "Student file Q&A chưa được bật")
+    claims = _student_claims(context_token, "ask")
+    normalized_session_id = str(session_id or "").strip()
+    if claims.session_id != normalized_session_id:
+        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
+    try:
+        upload_id = find_student_upload_id(claims)
+    except StudentUploadConflictError as exc:
+        raise StudentWorkflowError(409, str(exc)) from exc
+    except KeyError as exc:
+        raise StudentWorkflowError(404, "Không tìm thấy upload của phiên học") from exc
+    except ValueError as exc:
+        status_code = 410 if "hết hạn" in str(exc).lower() else 403
+        raise StudentWorkflowError(status_code, str(exc)) from exc
+    try:
+        assert_student_session_active(context_token, normalized_session_id, upload_id)
+    except StudentSessionClientError as exc:
+        raise StudentWorkflowError(exc.status_code, str(exc)) from exc
+    return claims, normalized_session_id, upload_id
+
+
+def _build_current_overview(
+    *, upload_id: str, token: str, claims: StudentContextClaims
+) -> dict[str, Any]:
+    try:
+        assert_upload_owner(upload_id, claims)
+    except KeyError as exc:
+        raise StudentWorkflowError(404, str(exc)) from exc
+    except ValueError as exc:
+        message = str(exc)
+        status_code = 410 if "hết hạn" in message.lower() else 403
+        raise StudentWorkflowError(status_code, message) from exc
+
+    try:
+        metadata = _read_metadata(upload_id)
+        table = _read_upload_table(upload_id)
+        (
+            target_template_id,
+            mapping_source,
+            mapping_identity,
+            mapping,
+            defaults,
+            formulas,
+        ) = _effective_mapping(metadata)
+        template = get_misa_template(target_template_id)
+        preview = preview_mapping(
+            upload_id=upload_id,
+            target_template_id=target_template_id,
+            mapping=mapping,
+            defaults=defaults,
+            formulas=formulas,
+            student_context_token=token,
+        )
+        readiness = readiness_mapping(
+            upload_id=upload_id,
+            target_template_id=target_template_id,
+            mapping=mapping,
+            defaults=defaults,
+            formulas=formulas,
+            student_context_token=token,
+        )
+    except KeyError as exc:
+        raise StudentWorkflowError(404, str(exc)) from exc
+    except ValueError as exc:
+        raise StudentWorkflowError(400, str(exc)) from exc
+
+    signature = metadata.get("signature") or {}
+    state_hash = explanation_state_hash(
+        session_id=claims.session_id,
+        upload_id=upload_id,
+        target_template_id=target_template_id,
+        source_signature_hash=str(signature.get("hash") or ""),
+        mapping_source=mapping_source,
+        mapping_identity=mapping_identity,
+        mapping=mapping,
+        defaults=defaults,
+        formulas=formulas,
+    )
+    explanations = build_student_explanations(
+        session_id=claims.session_id,
+        upload_id=upload_id,
+        target_template_id=target_template_id,
+        table=table,
+        target_headers=template.headers,
+        mapping_source=mapping_source,
+        mapping=mapping,
+        defaults=defaults,
+        formulas=formulas,
+        readiness=readiness,
+        master_data=preview.get("master_data") or {},
+        state_hash=state_hash,
+    )
+    summary = build_student_summary(
+        session_id=claims.session_id,
+        upload_id=upload_id,
+        file_name=str(metadata.get("filename") or ""),
+        target_template_id=target_template_id,
+        table=table,
+        target_headers=template.headers,
+        mapping=mapping,
+        defaults=defaults,
+        formulas=formulas,
+        preview=preview,
+        readiness=readiness,
+        explanation_count=len(explanations),
+        state_hash=state_hash,
+    )
+    suggestion = {
+        "source": mapping_source,
+        "confidence": 1.0
+        if mapping_source == "confirmed"
+        else float((metadata.get("suggestion") or {}).get("confidence") or 0),
+        "mapping": mapping,
+        "defaults": defaults,
+        "formulas": formulas,
+        "warnings": list((metadata.get("suggestion") or {}).get("warnings") or []),
+    }
+    if (metadata.get("suggestion") or {}).get("profile_id"):
+        suggestion["profile_id"] = metadata["suggestion"]["profile_id"]
+    payload = {
+        "upload_id": upload_id,
+        "detected": {
+            "sheet_name": str(signature.get("sheet_name") or table.sheet_name or ""),
+            "header_row": int(signature.get("header_row") or table.header_row_index + 1),
+            "row_count": int(signature.get("row_count") or len(table.rows)),
+            "source_signature_hash": str(signature.get("hash") or ""),
+            "headers": list(signature.get("headers") or table.headers),
+        },
+        "target_template_id": target_template_id,
+        "target_headers": template.headers,
+        "mapping_suggestion": suggestion,
+        "issues": list(metadata.get("issues") or []),
+        "master_data": preview.get("master_data") or {},
+        "student_preview": {
+            "headers": preview.get("headers") or template.headers,
+            "rows": list(preview.get("rows") or [])[:MAX_STUDENT_PREVIEW_ROWS],
+            "stats": preview.get("stats") or {},
+            "issues": preview.get("issues") or [],
+            "truncated": len(preview.get("rows") or []) > MAX_STUDENT_PREVIEW_ROWS,
+        },
+        "readiness": readiness,
+        "student_summary": summary.model_dump(mode="json"),
+        "explanations": [item.model_dump(mode="json") for item in explanations],
+        "student_state_hash": state_hash,
+    }
+    _write_overview_cache(upload_id, payload)
+    return payload
+
+
+def _effective_mapping(
+    metadata: dict[str, Any],
+) -> tuple[str, str, str, dict[str, Any], dict[str, Any], dict[str, str]]:
+    target_template_id = str(metadata.get("target_template_id") or "").strip()
+    if not target_template_id:
+        raise ValueError("Upload chưa có target template")
+    confirmed = metadata.get("confirmed")
+    if isinstance(confirmed, dict):
+        return (
+            target_template_id,
+            "confirmed",
+            str(metadata.get("profile_id") or "confirmed:inline"),
+            dict(confirmed.get("mapping") or {}),
+            dict(confirmed.get("defaults") or {}),
+            {str(key): str(value) for key, value in (confirmed.get("formulas") or {}).items()},
+        )
+    suggestion = metadata.get("suggestion") or {}
+    return (
+        target_template_id,
+        str(suggestion.get("source") or "heuristic"),
+        str(
+            suggestion.get("profile_id")
+            or suggestion.get("source")
+            or "heuristic"
+        ),
+        dict(suggestion.get("mapping") or {}),
+        dict(suggestion.get("defaults") or {}),
+        {str(key): str(value) for key, value in (suggestion.get("formulas") or {}).items()},
+    )
+
+
+def _analysis_completed_payload(overview: dict[str, Any]) -> dict[str, Any]:
+    summary = overview["student_summary"]
+    return {
+        "event": "analysis_completed",
+        "sessionId": summary["session_id"],
+        "converterUploadId": overview["upload_id"],
+        "targetTemplateId": overview["target_template_id"],
+        "sourceSignatureHash": overview["detected"]["source_signature_hash"],
+        "summary": {
+            "dataRowCount": summary["data_row_count"],
+            "documentCount": summary["document_count"],
+            "recognizedColumns": summary["recognized_columns"],
+            "unresolvedColumns": summary["unresolved_columns"],
+            "mappingCounts": summary["mapping_counts"],
+            "issueCounts": summary["issue_counts"],
+            "masterDataStatus": summary["master_data_status"],
+            "explanationCount": summary["explanation_count"],
+            "stateHash": overview["student_state_hash"],
+            "readinessStatus": overview["readiness"].get("status"),
+            "readinessScore": overview["readiness"].get("score"),
+        },
+        "status": "analyzed",
+    }
+
+
+def _student_claims(token: str, required_scope: str) -> StudentContextClaims:
+    if not _student_assistant_enabled():
+        raise StudentWorkflowError(404, "Student assistant chưa được bật")
+    if not str(token or "").strip():
+        raise StudentWorkflowError(401, "Thiếu student context")
+    try:
+        return verify_student_context(token, required_scope)
+    except ValueError as exc:
+        raise StudentWorkflowError(401, str(exc)) from exc
+
+
+def _student_assistant_enabled() -> bool:
+    return all(
+        os.getenv(name, "false").strip().lower() == "true"
+        for name in ("STUDENT_ASSISTANT_ENABLED", "STUDENT_FILE_EXPLAIN_ENABLED")
+    )
+
+
+def _student_question_enabled() -> bool:
+    return _student_assistant_enabled() and (
+        os.getenv("STUDENT_FILE_QA_ENABLED", "false").strip().lower() == "true"
+    )
+
+
+def _student_ai_available() -> bool:
+    return os.getenv("AI_PROVIDER", "disabled").strip().lower() not in {
+        "",
+        "disabled",
+        "none",
+        "off",
+    }
+
+
+def _overview_path(upload_id: str) -> Path:
+    metadata = _read_metadata(upload_id)
+    input_path = Path(str(metadata.get("input_path") or ""))
+    return input_path.parent / OVERVIEW_FILENAME
+
+
+def _read_overview_cache(upload_id: str) -> dict[str, Any] | None:
+    path = _overview_path(upload_id)
+    if not path.is_file():
+        return None
+    try:
+        payload = json.loads(path.read_text(encoding="utf-8"))
+    except (OSError, json.JSONDecodeError):
+        return None
+    return payload if isinstance(payload, dict) else None
+
+
+def _write_overview_cache(upload_id: str, payload: dict[str, Any]) -> None:
+    path = _overview_path(upload_id)
+    temporary = path.with_suffix(".tmp")
+    temporary.write_text(
+        json.dumps(
+            jsonable_encoder(payload),
+            ensure_ascii=False,
+            separators=(",", ":"),
+        ),
+        encoding="utf-8",
+    )
+    temporary.replace(path)
diff --git a/converter/app/student_store.py b/converter/app/student_store.py
new file mode 100755
index 0000000..11ba044
--- /dev/null
+++ b/converter/app/student_store.py
@@ -0,0 +1,478 @@
+from __future__ import annotations
+
+import json
+import os
+import shutil
+import threading
+import time
+import uuid
+from contextlib import contextmanager
+from datetime import datetime
+from hashlib import sha256
+from pathlib import Path
+from typing import Iterator
+
+from app.conversion_types import BACKEND_ROOT
+from app.student_context import StudentContextClaims
+
+
+UPLOAD_ROOT = BACKEND_ROOT / ".artifacts" / "uploads"
+STUDENT_METADATA_FILENAME = "student.json"
+MAX_STUDENT_UPLOAD_TTL_SECONDS = 24 * 60 * 60
+MAX_STUDENT_ANALYZE_TIMEOUT_SECONDS = 60 * 60
+MAX_STUDENT_ANALYZE_MUTEX_TTL_SECONDS = 5 * 60
+
+
+class StudentUploadConflictError(ValueError):
+    pass
+
+
+@contextmanager
+def claim_student_analysis(claims: StudentContextClaims) -> Iterator[None]:
+    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
+    identity = json.dumps(
+        {
+            "session_id": claims.session_id,
+            "user_id": claims.user_id,
+            "owner_scope": claims.owner_scope,
+            "workspace_id": str(claims.workspace_id or ""),
+        },
+        ensure_ascii=True,
+        separators=(",", ":"),
+        sort_keys=True,
+    )
+    digest = sha256(identity.encode("utf-8")).hexdigest()
+    lock_path = UPLOAD_ROOT / f".student-analyze-{digest}.lock"
+    reclaim_path = lock_path.with_suffix(".reclaim")
+    token = uuid.uuid4().hex
+    timeout_seconds = student_analyze_timeout_seconds()
+    try:
+        _create_analysis_lock(lock_path, reclaim_path, token)
+    except FileExistsError as exc:
+        if not _reclaim_stale_analysis_lock(
+            lock_path,
+            reclaim_path,
+            token,
+            timeout_seconds,
+        ):
+            raise StudentUploadConflictError(
+                "Phiên học đang được phân tích"
+            ) from exc
+
+    stop_heartbeat = threading.Event()
+    heartbeat = threading.Thread(
+        target=_heartbeat_analysis_lock,
+        args=(lock_path, reclaim_path, token, timeout_seconds, stop_heartbeat),
+        daemon=True,
+    )
+    heartbeat.start()
+    try:
+        yield
+    finally:
+        stop_heartbeat.set()
+        heartbeat.join(timeout=1)
+        _remove_analysis_lock_if_owned(lock_path, token)
+
+
+def student_analyze_timeout_seconds() -> int:
+    raw_value = os.getenv("STUDENT_ANALYZE_TIMEOUT_SECONDS", "120")
+    try:
+        timeout_seconds = int(raw_value)
+    except ValueError as exc:
+        raise ValueError("STUDENT_ANALYZE_TIMEOUT_SECONDS không hợp lệ") from exc
+    if not 0 < timeout_seconds <= MAX_STUDENT_ANALYZE_TIMEOUT_SECONDS:
+        raise ValueError("Student analyze timeout phải từ 1 giây đến 1 giờ")
+    return timeout_seconds
+
+
+def student_analyze_mutex_ttl_seconds() -> int:
+    raw_value = os.getenv("STUDENT_ANALYZE_MUTEX_TTL_SECONDS", "30")
+    try:
+        ttl_seconds = int(raw_value)
+    except ValueError as exc:
+        raise ValueError("STUDENT_ANALYZE_MUTEX_TTL_SECONDS không hợp lệ") from exc
+    if not 0 < ttl_seconds <= MAX_STUDENT_ANALYZE_MUTEX_TTL_SECONDS:
+        raise ValueError("Student analyze mutex TTL phải từ 1 đến 300 giây")
+    return ttl_seconds
+
+
+def _create_analysis_lock(
+    lock_path: Path,
+    reclaim_path: Path,
+    token: str,
+    *,
+    ignore_reclaim_guard: bool = False,
+) -> None:
+    if not ignore_reclaim_guard and reclaim_path.exists():
+        raise FileExistsError(str(lock_path))
+    descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
+    try:
+        now = time.time()
+        _write_lock_descriptor(
+            descriptor,
+            {"token": token, "created_at": now, "heartbeat_at": now},
+        )
+    finally:
+        os.close(descriptor)
+    if not ignore_reclaim_guard and reclaim_path.exists():
+        _remove_analysis_lock_if_owned(lock_path, token)
+        raise FileExistsError(str(lock_path))
+
+
+def _reclaim_stale_analysis_lock(
+    lock_path: Path,
+    reclaim_path: Path,
+    token: str,
+    timeout_seconds: int,
+) -> bool:
+    with _claim_analysis_reclaim_mutex(reclaim_path, token) as acquired:
+        if not acquired:
+            return False
+        if not _analysis_lock_is_stale(lock_path, timeout_seconds):
+            return False
+        lock_path.unlink(missing_ok=True)
+        try:
+            _create_analysis_lock(
+                lock_path,
+                reclaim_path,
+                token,
+                ignore_reclaim_guard=True,
+            )
+        except FileExistsError:
+            return False
+        return True
+
+
+def _analysis_lock_is_stale(lock_path: Path, timeout_seconds: int) -> bool:
+    try:
+        stat = lock_path.stat()
+    except FileNotFoundError:
+        return True
+    timestamp = stat.st_mtime
+    try:
+        payload = json.loads(lock_path.read_text(encoding="utf-8"))
+        timestamp = float(payload.get("heartbeat_at") or payload.get("created_at") or timestamp)
+    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
+        pass
+    return time.time() - timestamp > timeout_seconds
+
+
+def _heartbeat_analysis_lock(
+    lock_path: Path,
+    reclaim_path: Path,
+    token: str,
+    timeout_seconds: int,
+    stop_event: threading.Event,
+) -> None:
+    interval = max(0.1, min(5.0, timeout_seconds / 3))
+    while not stop_event.wait(interval):
+        if not _refresh_analysis_lock(lock_path, reclaim_path, token):
+            if not lock_path.exists():
+                return
+            continue
+
+
+def _refresh_analysis_lock(lock_path: Path, reclaim_path: Path, token: str) -> bool:
+    with _claim_analysis_reclaim_mutex(reclaim_path, token) as acquired:
+        if not acquired:
+            return False
+        try:
+            descriptor = os.open(lock_path, os.O_RDWR)
+        except FileNotFoundError:
+            return False
+        try:
+            payload = _read_lock_descriptor(descriptor)
+            if payload.get("token") != token:
+                return False
+            payload["heartbeat_at"] = time.time()
+            _write_lock_descriptor(descriptor, payload)
+            return True
+        finally:
+            os.close(descriptor)
+
+
+@contextmanager
+def _claim_analysis_reclaim_mutex(
+    reclaim_path: Path,
+    token: str,
+) -> Iterator[bool]:
+    try:
+        descriptor = _create_analysis_reclaim_mutex(reclaim_path, token)
+    except FileExistsError:
+        if not _reclaim_orphaned_analysis_mutex(
+            reclaim_path,
+            student_analyze_mutex_ttl_seconds(),
+        ):
+            yield False
+            return
+        try:
+            descriptor = _create_analysis_reclaim_mutex(reclaim_path, token)
+        except FileExistsError:
+            yield False
+            return
+    os.close(descriptor)
+    try:
+        yield True
+    finally:
+        try:
+            payload = json.loads(reclaim_path.read_text(encoding="utf-8"))
+        except (OSError, json.JSONDecodeError):
+            payload = {}
+        if payload.get("token") == token:
+            reclaim_path.unlink(missing_ok=True)
+
+
+def _create_analysis_reclaim_mutex(reclaim_path: Path, token: str) -> int:
+    descriptor = os.open(
+        reclaim_path,
+        os.O_CREAT | os.O_EXCL | os.O_WRONLY,
+        0o600,
+    )
+    try:
+        _write_lock_descriptor(
+            descriptor,
+            {"token": token, "created_at": time.time()},
+        )
+    except Exception:
+        os.close(descriptor)
+        reclaim_path.unlink(missing_ok=True)
+        raise
+    return descriptor
+
+
+def _reclaim_orphaned_analysis_mutex(reclaim_path: Path, ttl_seconds: int) -> bool:
+    try:
+        stat = reclaim_path.stat()
+        payload = json.loads(reclaim_path.read_text(encoding="utf-8"))
+    except (OSError, json.JSONDecodeError):
+        return False
+    if not isinstance(payload, dict):
+        return False
+    token = str(payload.get("token") or "")
+    try:
+        created_at = float(payload.get("created_at") or stat.st_mtime)
+    except (TypeError, ValueError):
+        return False
+    if not token or time.time() - created_at <= ttl_seconds:
+        return False
+    try:
+        current = json.loads(reclaim_path.read_text(encoding="utf-8"))
+    except (OSError, json.JSONDecodeError):
+        return False
+    if current.get("token") != token or current.get("created_at") != payload.get("created_at"):
+        return False
+    reclaim_path.unlink(missing_ok=True)
+    return True
+
+
+def _read_lock_descriptor(descriptor: int) -> dict:
+    os.lseek(descriptor, 0, os.SEEK_SET)
+    raw = os.read(descriptor, 4096)
+    try:
+        payload = json.loads(raw.decode("utf-8"))
+    except (UnicodeDecodeError, json.JSONDecodeError):
+        return {}
+    return payload if isinstance(payload, dict) else {}
+
+
+def _write_lock_descriptor(descriptor: int, payload: dict) -> None:
+    raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")
+    os.lseek(descriptor, 0, os.SEEK_SET)
+    os.ftruncate(descriptor, 0)
+    os.write(descriptor, raw)
+    os.fsync(descriptor)
+
+
+def _remove_analysis_lock_if_owned(lock_path: Path, token: str) -> None:
+    try:
+        payload = json.loads(lock_path.read_text(encoding="utf-8"))
+    except (OSError, json.JSONDecodeError):
+        return
+    if isinstance(payload, dict) and payload.get("token") == token:
+        lock_path.unlink(missing_ok=True)
+
+
+def student_upload_retention_seconds() -> int:
+    raw_value = os.getenv(
+        "STUDENT_UPLOAD_RETENTION_SECONDS",
+        str(MAX_STUDENT_UPLOAD_TTL_SECONDS),
+    )
+    try:
+        ttl_seconds = int(raw_value)
+    except ValueError as exc:
+        raise ValueError("STUDENT_UPLOAD_RETENTION_SECONDS không hợp lệ") from exc
+    if not 0 < ttl_seconds <= MAX_STUDENT_UPLOAD_TTL_SECONDS:
+        raise ValueError("Student upload retention phải từ 1 giây đến 24 giờ")
+    return ttl_seconds
+
+
+def bind_upload_to_student(
+    upload_id: str,
+    claims: StudentContextClaims,
+    ttl_seconds: int,
+) -> None:
+    normalized_upload_id = _normalized_upload_id(upload_id)
+    if not 0 < int(ttl_seconds) <= MAX_STUDENT_UPLOAD_TTL_SECONDS:
+        raise ValueError("Student upload TTL phải từ 1 giây đến 24 giờ")
+    now = int(time.time())
+    expires_at = min(claims.exp, now + int(ttl_seconds))
+    if expires_at <= now:
+        raise ValueError("Student upload context đã hết hạn")
+
+    upload_dir = UPLOAD_ROOT / normalized_upload_id
+    if not upload_dir.is_dir():
+        raise KeyError(f"Upload not found: {normalized_upload_id}")
+    metadata = {
+        "session_id": claims.session_id,
+        "user_id": claims.user_id,
+        "owner_scope": claims.owner_scope,
+        "workspace_id": claims.workspace_id,
+        "expires_at": expires_at,
+    }
+    metadata_path = upload_dir / STUDENT_METADATA_FILENAME
+    temporary_path = metadata_path.with_suffix(".tmp")
+    temporary_path.write_text(
+        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
+        encoding="utf-8",
+    )
+    temporary_path.replace(metadata_path)
+
+
+def assert_upload_owner(upload_id: str, claims: StudentContextClaims) -> None:
+    metadata = _read_student_metadata(upload_id)
+    if int(metadata.get("expires_at") or 0) <= int(time.time()):
+        raise ValueError("Student upload đã hết hạn")
+    expected = (
+        str(metadata.get("session_id") or ""),
+        str(metadata.get("user_id") or ""),
+        str(metadata.get("owner_scope") or ""),
+        str(metadata.get("workspace_id") or ""),
+    )
+    actual = (
+        claims.session_id,
+        claims.user_id,
+        claims.owner_scope,
+        str(claims.workspace_id or ""),
+    )
+    if not all(expected[:3]):
+        raise ValueError("Student upload metadata không hợp lệ")
+    if expected != actual:
+        raise ValueError("Student upload không thuộc owner hoặc session này")
+
+
+def student_upload_is_bound(upload_id: str) -> bool:
+    return (_student_metadata_path(upload_id)).is_file()
+
+
+def find_student_upload_id(claims: StudentContextClaims) -> str:
+    matches, expired_match = _matching_student_upload_ids(claims)
+    if len(matches) > 1:
+        raise StudentUploadConflictError("Phiên học có nhiều upload đang hoạt động")
+    if matches:
+        return matches[0]
+    if expired_match:
+        raise ValueError("Student upload đã hết hạn")
+    raise KeyError(claims.session_id)
+
+
+def assert_no_student_upload_for_session(claims: StudentContextClaims) -> None:
+    matches, _ = _matching_student_upload_ids(claims)
+    if matches:
+        raise StudentUploadConflictError("Phiên học đã có upload đang hoạt động")
+
+
+def _matching_student_upload_ids(
+    claims: StudentContextClaims,
+) -> tuple[list[str], bool]:
+    if not UPLOAD_ROOT.is_dir():
+        return [], False
+    matches: list[str] = []
+    expired_match = False
+    for upload_dir in sorted(UPLOAD_ROOT.iterdir(), key=lambda path: path.name):
+        if not upload_dir.is_dir():
+            continue
+        try:
+            metadata = _read_student_metadata(upload_dir.name)
+        except ValueError:
+            continue
+        if str(metadata.get("session_id") or "") != claims.session_id:
+            continue
+        expected = (
+            str(metadata.get("user_id") or ""),
+            str(metadata.get("owner_scope") or ""),
+            str(metadata.get("workspace_id") or ""),
+        )
+        actual = (
+            claims.user_id,
+            claims.owner_scope,
+            str(claims.workspace_id or ""),
+        )
+        if expected != actual:
+            continue
+        if int(metadata.get("expires_at") or 0) <= int(time.time()):
+            expired_match = True
+            continue
+        matches.append(upload_dir.name)
+    return matches, expired_match
+
+
+def cleanup_expired_student_uploads(now=None) -> list[str]:
+    current_time = _timestamp(now)
+    if not UPLOAD_ROOT.is_dir():
+        return []
+    deleted: list[str] = []
+    for upload_dir in sorted(UPLOAD_ROOT.iterdir(), key=lambda path: path.name):
+        if not upload_dir.is_dir():
+            continue
+        metadata_path = upload_dir / STUDENT_METADATA_FILENAME
+        if not metadata_path.is_file():
+            continue
+        try:
+            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
+            expires_at = int(metadata.get("expires_at") or 0)
+        except (OSError, ValueError, json.JSONDecodeError, AttributeError):
+            expires_at = 0
+        if expires_at > current_time:
+            continue
+        shutil.rmtree(upload_dir, ignore_errors=True)
+        if not upload_dir.exists():
+            deleted.append(upload_dir.name)
+    return deleted
+
+
+def _read_student_metadata(upload_id: str) -> dict:
+    path = _student_metadata_path(upload_id)
+    if not path.is_file():
+        raise ValueError("Upload chưa được bind với student context")
+    try:
+        metadata = json.loads(path.read_text(encoding="utf-8"))
+    except (OSError, json.JSONDecodeError) as exc:
+        raise ValueError("Student upload metadata không hợp lệ") from exc
+    if not isinstance(metadata, dict):
+        raise ValueError("Student upload metadata không hợp lệ")
+    return metadata
+
+
+def _student_metadata_path(upload_id: str) -> Path:
+    return UPLOAD_ROOT / _normalized_upload_id(upload_id) / STUDENT_METADATA_FILENAME
+
+
+def _normalized_upload_id(upload_id: str) -> str:
+    normalized = str(upload_id or "").strip()
+    if (
+        not normalized
+        or normalized in {".", ".."}
+        or "/" in normalized
+        or "\\" in normalized
+        or Path(normalized).name != normalized
+    ):
+        raise ValueError("Upload id không hợp lệ")
+    return normalized
+
+
+def _timestamp(value) -> int:
+    if value is None:
+        return int(time.time())
+    if isinstance(value, datetime):
+        return int(value.timestamp())
+    return int(value)
diff --git a/converter/app/student_session_client.py b/converter/app/student_session_client.py
new file mode 100755
index 0000000..889b336
--- /dev/null
+++ b/converter/app/student_session_client.py
@@ -0,0 +1,135 @@
+from __future__ import annotations
+
+import os
+from typing import Any
+
+import httpx
+
+
+class StudentSessionClientError(ValueError):
+    def __init__(self, message: str, *, status_code: int = 503) -> None:
+        self.status_code = status_code
+        super().__init__(message)
+
+
+def assert_student_session_active(token: str, session_id: str, upload_id: str) -> None:
+    normalized_session_id = str(session_id or "").strip()
+    normalized_upload_id = str(upload_id or "").strip()
+    if not normalized_session_id:
+        raise StudentSessionClientError("Thiếu student session id để kiểm tra")
+    if not normalized_upload_id:
+        raise StudentSessionClientError(
+            "Thiếu converter upload id để kiểm tra phiên học",
+            status_code=409,
+        )
+    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
+    if not service_token:
+        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
+    base_url = str(
+        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
+    ).rstrip("/")
+    try:
+        response = httpx.get(
+            f"{base_url}/student/sessions/{normalized_session_id}/active",
+            headers={
+                "x-converter-service-token": service_token,
+                "x-student-context": token,
+            },
+            params={"uploadId": normalized_upload_id},
+            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
+        )
+    except httpx.HTTPError as exc:
+        raise StudentSessionClientError(
+            f"Không kiểm tra được trạng thái phiên học: {exc}",
+            status_code=503,
+        ) from exc
+    try:
+        payload = response.json()
+    except ValueError:
+        payload = {}
+    if response.status_code >= 400:
+        mapped_status = (
+            response.status_code
+            if response.status_code in {403, 409, 410}
+            else 503
+        )
+        detail = payload.get("message") or payload.get("detail")
+        raise StudentSessionClientError(
+            detail or f"Backend từ chối kiểm tra phiên học: HTTP {response.status_code}",
+            status_code=mapped_status,
+        )
+    if payload.get("active") is not True:
+        raise StudentSessionClientError(
+            "Backend không xác nhận phiên học đang hoạt động",
+            status_code=503,
+        )
+
+
+def record_analysis_completed(token: str, payload: dict[str, Any]) -> None:
+    session_id = str(payload.get("sessionId") or "").strip()
+    if not session_id:
+        raise StudentSessionClientError("Thiếu student session id để đồng bộ")
+    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
+    if not service_token:
+        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
+    base_url = str(
+        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
+    ).rstrip("/")
+    try:
+        response = httpx.post(
+            f"{base_url}/student/sessions/{session_id}/events",
+            headers={
+                "x-converter-service-token": service_token,
+                "x-student-context": token,
+            },
+            json=payload,
+            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
+        )
+    except httpx.HTTPError as exc:
+        raise StudentSessionClientError(
+            f"Không đồng bộ được metadata phiên học: {exc}"
+        ) from exc
+    if response.status_code >= 400:
+        try:
+            body = response.json()
+            detail = body.get("message") or body.get("detail")
+        except ValueError:
+            detail = None
+        raise StudentSessionClientError(
+            f"Backend từ chối metadata phiên học: {detail or f'HTTP {response.status_code}'}"
+        )
+
+
+def record_question_event(token: str, payload: dict[str, Any]) -> None:
+    session_id = str(payload.get("sessionId") or "").strip()
+    if not session_id:
+        raise StudentSessionClientError("Thiếu student session id để ghi nhận câu hỏi")
+    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
+    if not service_token:
+        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
+    base_url = str(
+        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
+    ).rstrip("/")
+    try:
+        response = httpx.post(
+            f"{base_url}/student/sessions/{session_id}/questions",
+            headers={
+                "x-converter-service-token": service_token,
+                "x-student-context": token,
+            },
+            json=payload,
+            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
+        )
+    except httpx.HTTPError as exc:
+        raise StudentSessionClientError(
+            f"Không ghi nhận được student question event: {exc}"
+        ) from exc
+    if response.status_code >= 400:
+        try:
+            body = response.json()
+            detail = body.get("message") or body.get("detail")
+        except ValueError:
+            detail = None
+        raise StudentSessionClientError(
+            f"Backend từ chối student question event: {detail or f'HTTP {response.status_code}'}"
+        )
diff --git a/converter/tests/test_student_queries.py b/converter/tests/test_student_queries.py
new file mode 100755
index 0000000..22013ff
--- /dev/null
+++ b/converter/tests/test_student_queries.py
@@ -0,0 +1,474 @@
+from __future__ import annotations
+
+import json
+from copy import deepcopy
+from pathlib import Path
+
+import pytest
+
+from app.excel_io import InputTable
+from app.student_queries import answer_question, validate_answer_evidence
+
+
+BENCHMARK_PATH = Path(__file__).parent / "fixtures" / "student_question_benchmark.json"
+SUPPORTED_INTENTS = {
+    "file_summary",
+    "locate_column",
+    "locate_rows",
+    "explain_mapping",
+    "explain_issue",
+    "aggregate_amount",
+    "count_documents",
+    "find_duplicates",
+    "find_vat_mismatches",
+    "required_actions_before_export",
+    "concept_explanation",
+    "unsupported_legal_or_business_judgment",
+}
+
+
+def _sales_state() -> dict:
+    table = InputTable(
+        headers=[
+            "Mã hóa đơn",
+            "Ngày hóa đơn",
+            "Tên khách hàng",
+            "Số lượng",
+            "Đơn giá",
+            "Thành tiền",
+            "Thuế suất",
+            "Tiền thuế GTGT",
+            "Tổng thanh toán",
+        ],
+        rows=[
+            {
+                "Mã hóa đơn": "HD001",
+                "Ngày hóa đơn": "01/01/2026",
+                "Tên khách hàng": "Khách A",
+                "Số lượng": 2,
+                "Đơn giá": 100000,
+                "Thành tiền": 200000,
+                "Thuế suất": "10%",
+                "Tiền thuế GTGT": 20000,
+                "Tổng thanh toán": 220000,
+            },
+            {
+                "Mã hóa đơn": "HD001",
+                "Ngày hóa đơn": "01/01/2026",
+                "Tên khách hàng": "Khách A",
+                "Số lượng": 1,
+                "Đơn giá": 50000,
+                "Thành tiền": 50000,
+                "Thuế suất": "10%",
+                "Tiền thuế GTGT": 5000,
+                "Tổng thanh toán": 55000,
+            },
+            {
+                "Mã hóa đơn": "HD002",
+                "Ngày hóa đơn": "02/01/2026",
+                "Tên khách hàng": "Khách B",
+                "Số lượng": 3,
+                "Đơn giá": 40000,
+                "Thành tiền": 120000,
+                "Thuế suất": "8%",
+                "Tiền thuế GTGT": 8000,
+                "Tổng thanh toán": 128000,
+            },
+            {
+                "Mã hóa đơn": "HD003",
+                "Ngày hóa đơn": "03/01/2026",
+                "Tên khách hàng": "Khách C",
+                "Số lượng": 1,
+                "Đơn giá": 300000,
+                "Thành tiền": 300000,
+                "Thuế suất": "10%",
+                "Tiền thuế GTGT": 30000,
+                "Tổng thanh toán": 330000,
+            },
+            {
+                "Mã hóa đơn": "HD003",
+                "Ngày hóa đơn": "04/01/2026",
+                "Tên khách hàng": "Khách D",
+                "Số lượng": 1,
+                "Đơn giá": 25000,
+                "Thành tiền": 25000,
+                "Thuế suất": "10%",
+                "Tiền thuế GTGT": 2500,
+                "Tổng thanh toán": 27500,
+            },
+        ],
+        sheet_name="Sales",
+        header_row_index=0,
+    )
+    mapping = {
+        "Mã hóa đơn": "Số chứng từ (*)",
+        "Ngày hóa đơn": "Ngày chứng từ (*)",
+        "Tên khách hàng": "Tên khách hàng",
+        "Số lượng": "Số lượng",
+        "Đơn giá": "Đơn giá",
+        "Thành tiền": "Thành tiền",
+        "Thuế suất": "% thuế GTGT",
+        "Tiền thuế GTGT": "Tiền thuế GTGT",
+        "Tổng thanh toán": "Tổng tiền thanh toán",
+    }
+    return {
+        "session_id": "session-sales",
+        "upload_id": "upload-sales",
+        "state_hash": "state-sales",
+        "target_template_id": "bsn_sales",
+        "target_headers": list(mapping.values()),
+        "table": table,
+        "mapping": mapping,
+        "defaults": {},
+        "formulas": {},
+        "summary": {
+            "data_row_count": 5,
+            "document_count": 3,
+            "recognized_columns": 9,
+            "unresolved_columns": 0,
+            "issue_counts": {"blocker": 3, "warning": 1, "info": 0},
+        },
+        "readiness": {
+            "status": "blocked",
+            "summary": {"blocker": 3, "warning": 1, "info": 0},
+            "issues": [
+                {
+                    "severity": "blocker",
+                    "category": "tax",
+                    "code": "vat_amount_mismatch",
+                    "row": 3,
+                    "field": "Tiền thuế GTGT",
+                    "actual": "8000",
+                    "expected": "9600",
+                    "delta": "-1600",
+                    "message": "Tiền thuế GTGT không khớp.",
+                    "fix_hint": "Kiểm tra thành tiền, thuế suất hoặc tiền thuế.",
+                },
+                {
+                    "severity": "blocker",
+                    "category": "document",
+                    "code": "duplicate_document_key",
+                    "row": 5,
+                    "field": "Số chứng từ/Số hóa đơn",
+                    "invoice": "HD003",
+                    "actual": "Dòng 5 khác thông tin",
+                    "expected": "Khớp với dòng 4",
+                    "message": "Chứng từ HD003 bị trùng nhưng thông tin không thống nhất.",
+                    "fix_hint": "Kiểm tra số hóa đơn hoặc tách chứng từ.",
+                },
+                {
+                    "severity": "blocker",
+                    "category": "template",
+                    "code": "required_value_blank",
+                    "row": 4,
+                    "field": "Tên khách hàng",
+                    "actual": "",
+                    "expected": "Có giá trị",
+                    "message": "Tên khách hàng cần được rà soát.",
+                    "fix_hint": "Bổ sung giá trị theo chứng từ nguồn.",
+                },
+                {
+                    "severity": "warning",
+                    "category": "review",
+                    "code": "master_data_unverified",
+                    "row": 2,
+                    "field": "Tên khách hàng",
+                    "actual": "Khách A",
+                    "expected": "Đã đối chiếu danh mục",
+                    "message": "Khách hàng chưa được đối chiếu danh mục.",
+                    "fix_hint": "Đối chiếu hồ sơ doanh nghiệp trước khi import.",
+                },
+            ],
+        },
+        "ai_available": False,
+    }
+
+
+def _purchase_state() -> dict:
+    table = InputTable(
+        headers=[
+            "Số hóa đơn",
+            "Ngày hóa đơn",
+            "Tên nhà cung cấp",
+            "Mã hàng",
+            "Số lượng",
+            "Đơn giá",
+            "Thành tiền",
+            "Thuế suất GTGT",
+            "Tiền thuế GTGT",
+        ],
+        rows=[
+            {
+                "Số hóa đơn": "MH001",
+                "Ngày hóa đơn": "05/01/2026",
+                "Tên nhà cung cấp": "NCC A",
+                "Mã hàng": "VT001",
+                "Số lượng": 10,
+                "Đơn giá": 20000,
+                "Thành tiền": 200000,
+                "Thuế suất GTGT": "10%",
+                "Tiền thuế GTGT": 20000,
+            },
+            {
+                "Số hóa đơn": "MH002",
+                "Ngày hóa đơn": "06/01/2026",
+                "Tên nhà cung cấp": "NCC B",
+                "Mã hàng": "VT002",
+                "Số lượng": 5,
+                "Đơn giá": 30000,
+                "Thành tiền": 150000,
+                "Thuế suất GTGT": "8%",
+                "Tiền thuế GTGT": 10000,
+            },
+            {
+                "Số hóa đơn": "MH003",
+                "Ngày hóa đơn": "07/01/2026",
+                "Tên nhà cung cấp": "NCC C",
+                "Mã hàng": "VT003",
+                "Số lượng": 2,
+                "Đơn giá": 50000,
+                "Thành tiền": 100000,
+                "Thuế suất GTGT": "10%",
+                "Tiền thuế GTGT": 10000,
+            },
+            {
+                "Số hóa đơn": "MH003",
+                "Ngày hóa đơn": "08/01/2026",
+                "Tên nhà cung cấp": "NCC D",
+                "Mã hàng": "VT003",
+                "Số lượng": 1,
+                "Đơn giá": 50000,
+                "Thành tiền": 50000,
+                "Thuế suất GTGT": "10%",
+                "Tiền thuế GTGT": 5000,
+            },
+        ],
+        sheet_name="Purchase",
+        header_row_index=1,
+    )
+    mapping = {
+        "Số hóa đơn": "Số hóa đơn",
+        "Ngày hóa đơn": "Ngày hóa đơn",
+        "Tên nhà cung cấp": "Tên nhà cung cấp",
+        "Mã hàng": "Mã hàng (*)",
+        "Số lượng": "Số lượng",
+        "Đơn giá": "Đơn giá",
+        "Thành tiền": "Thành tiền",
+        "Thuế suất GTGT": "% thuế GTGT",
+        "Tiền thuế GTGT": "Tiền thuế GTGT",
+    }
+    return {
+        "session_id": "session-purchase",
+        "upload_id": "upload-purchase",
+        "state_hash": "state-purchase",
+        "target_template_id": "bsn_purchase",
+        "target_headers": list(mapping.values()),
+        "table": table,
+        "mapping": mapping,
+        "defaults": {},
+        "formulas": {},
+        "summary": {
+            "data_row_count": 4,
+            "document_count": 3,
+            "recognized_columns": 9,
+            "unresolved_columns": 0,
+            "issue_counts": {"blocker": 2, "warning": 0, "info": 0},
+        },
+        "readiness": {
+            "status": "blocked",
+            "summary": {"blocker": 2, "warning": 0, "info": 0},
+            "issues": [
+                {
+                    "severity": "blocker",
+                    "category": "tax",
+                    "code": "vat_amount_mismatch",
+                    "row": 2,
+                    "field": "Tiền thuế GTGT",
+                    "actual": "10000",
+                    "expected": "12000",
+                    "delta": "-2000",
+                    "message": "Tiền thuế GTGT không khớp.",
+                    "fix_hint": "Kiểm tra thuế suất hoặc tiền thuế.",
+                },
+                {
+                    "severity": "blocker",
+                    "category": "document",
+                    "code": "duplicate_document_key",
+                    "row": 4,
+                    "field": "Số chứng từ/Số hóa đơn",
+                    "invoice": "MH003",
+                    "actual": "Dòng 4 khác thông tin",
+                    "expected": "Khớp với dòng 3",
+                    "message": "Chứng từ MH003 bị trùng nhưng thông tin không thống nhất.",
+                    "fix_hint": "Kiểm tra lại hóa đơn mua hàng.",
+                },
+            ],
+        },
+        "ai_available": False,
+    }
+
+
+@pytest.fixture
+def states() -> dict[str, dict]:
+    return {"sales": _sales_state(), "purchase": _purchase_state()}
+
+
+def test_question_benchmark_has_at_least_fifty_cases_and_all_intent_families(states):
+    cases = json.loads(BENCHMARK_PATH.read_text(encoding="utf-8"))
+
+    assert len(cases) >= 50
+    assert {case["expected_intent"] for case in cases} == SUPPORTED_INTENTS
+
+    for case in cases:
+        answer = answer_question(case["question"], states[case["state"]])
+        assert answer.intent == case["expected_intent"], case
+        assert answer.outcome == case["expected_outcome"], case
+        if case["expected_outcome"] == "supported":
+            assert answer.evidence, case
+            validate_answer_evidence(answer, states[case["state"]])
+        else:
+            assert answer.evidence == [], case
+            assert answer.unsupported_reason, case
+        if case.get("answer_contains"):
+            assert case["answer_contains"].casefold() in answer.answer.casefold(), case
+
+
+def test_answer_evidence_is_bounded_and_uses_stable_unique_ids(states):
+    answer = answer_question("Những dòng nào có hóa đơn HD001?", states["sales"])
+
+    assert answer.intent == "locate_rows"
+    assert 1 <= len(answer.evidence) <= 20
+    assert len({item.id for item in answer.evidence}) == len(answer.evidence)
+    validate_answer_evidence(answer, states["sales"])
+
+
+@pytest.mark.parametrize(
+    "mutation",
+    [
+        lambda evidence: setattr(evidence, "row", 999),
+        lambda evidence: setattr(evidence, "field", "Cột không tồn tại"),
+        lambda evidence: setattr(evidence, "actual", "giá trị bịa"),
+    ],
+)
+def test_evidence_validator_rejects_invented_rows_fields_and_values(states, mutation):
+    answer = answer_question("Những dòng nào có hóa đơn HD001?", states["sales"])
+    tampered = answer.model_copy(deep=True)
+    mutation(tampered.evidence[0])
+
+    with pytest.raises(ValueError, match="evidence"):
+        validate_answer_evidence(tampered, states["sales"])
+
+
+def test_no_evidence_produces_unsupported_instead_of_file_specific_claim(states):
+    state = deepcopy(states["sales"])
+    state["table"] = InputTable(
+        headers=state["table"].headers,
+        rows=[],
+        sheet_name="Sales",
+        header_row_index=0,
+    )
+    state["summary"] = {**state["summary"], "data_row_count": 0, "document_count": 0}
+
+    answer = answer_question("File này có bao nhiêu dòng?", state)
+
+    assert answer.outcome == "unsupported"
+    assert answer.evidence == []
+    assert answer.unsupported_reason == "no_evidence"
+
+
+def test_unknown_question_reports_ai_unavailable_without_inventing_values(states):
+    answer = answer_question("Hãy suy luận tự do điều gì đáng chú ý nhất", states["sales"])
+
+    assert answer.outcome == "ai_unavailable"
+    assert answer.answer_type == "unsupported"
+    assert answer.evidence == []
+    assert answer.unsupported_reason == "ai_unavailable"
+
+
+@pytest.mark.parametrize(
+    ("question", "issue_code", "expected_intent"),
+    [
+        ("Có hóa đơn trùng không?", "duplicate_document_key", "find_duplicates"),
+        ("Dòng nào lệch tiền thuế GTGT?", "vat_amount_mismatch", "find_vat_mismatches"),
+    ],
+)
+def test_duplicate_and_vat_handlers_return_unsupported_when_issue_evidence_is_invalid(
+    states,
+    question,
+    issue_code,
+    expected_intent,
+):
+    state = deepcopy(states["sales"])
+    state["readiness"]["issues"] = [
+        {
+            **next(
+                issue
+                for issue in state["readiness"]["issues"]
+                if issue["code"] == issue_code
+            ),
+            "row": 999,
+        }
+    ]
+
+    answer = answer_question(question, state)
+
+    assert answer.intent == expected_intent
+    assert answer.outcome == "unsupported"
+    assert answer.unsupported_reason == "no_evidence"
+    assert answer.evidence == []
+
+
+@pytest.mark.parametrize(
+    ("question", "issue_code"),
+    [
+        ("Có hóa đơn trùng không?", "duplicate_document_key"),
+        ("Dòng nào lệch tiền thuế GTGT?", "vat_amount_mismatch"),
+    ],
+)
+def test_duplicate_and_vat_handlers_do_not_call_supported_without_evidence(
+    states,
+    monkeypatch,
+    question,
+    issue_code,
+):
+    state = deepcopy(states["sales"])
+    state["readiness"]["issues"] = [
+        {
+            **next(
+                issue
+                for issue in state["readiness"]["issues"]
+                if issue["code"] == issue_code
+            ),
+            "row": 999,
+        }
+    ]
+
+    def forbidden_supported(*args, **kwargs):
+        raise AssertionError("handler must branch to unsupported before _supported")
+
+    monkeypatch.setattr("app.student_queries._supported", forbidden_supported)
+
+    answer = answer_question(question, state)
+
+    assert answer.outcome == "unsupported"
+    assert answer.unsupported_reason == "no_evidence"
+
+
+def test_requested_row_is_one_based_worksheet_row_with_non_first_header(states):
+    answer = answer_question("Vì sao dòng 4 bị lỗi thuế?", states["purchase"])
+
+    assert answer.intent == "explain_issue"
+    assert answer.outcome == "supported"
+    assert len(answer.evidence) == 1
+    assert answer.evidence[0].row == 4
+    assert answer.evidence[0].issue_code == "vat_amount_mismatch"
+
+
+@pytest.mark.parametrize("question", ["Giải thích lỗi ở dòng 2", "Giải thích lỗi ở dòng 99"])
+def test_requested_header_or_out_of_range_worksheet_row_is_unsupported(states, question):
+    answer = answer_question(question, states["purchase"])
+
+    assert answer.intent == "explain_issue"
+    assert answer.outcome == "unsupported"
+    assert answer.unsupported_reason == "row_out_of_range"
+    assert answer.evidence == []
diff --git a/converter/tests/test_student_api.py b/converter/tests/test_student_api.py
new file mode 100755
index 0000000..10c0d0c
--- /dev/null
+++ b/converter/tests/test_student_api.py
@@ -0,0 +1,689 @@
+from __future__ import annotations
+
+import base64
+import hashlib
+import hmac
+import json
+import time
+from concurrent.futures import ThreadPoolExecutor
+from io import BytesIO
+from threading import Event, Lock
+
+import openpyxl
+import pytest
+from fastapi.testclient import TestClient
+
+from app import student_store, student_workflow
+from app.main import app
+from app.misa_workflow import _read_metadata, _write_metadata
+from app.student_context import verify_student_context
+from app.student_session_client import (
+    StudentSessionClientError,
+    assert_student_session_active,
+    record_analysis_completed,
+    record_question_event,
+)
+from app.student_store import find_student_upload_id
+
+
+def _encode_part(payload):
+    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
+    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
+
+
+def _student_token(secret="student-secret", **overrides):
+    payload = {
+        "purpose": "student_file_session",
+        "session_id": "507f1f77bcf86cd799439011",
+        "user_id": "507f1f77bcf86cd799439012",
+        "owner_scope": "user:507f1f77bcf86cd799439012",
+        "workspace_id": None,
+        "snapshot_set_hash": None,
+        "allowed_scopes": ["analyze", "explain", "ask", "attempt", "export"],
+        "iat": int(time.time()),
+        "exp": int(time.time()) + 600,
+    }
+    payload.update(overrides)
+    header_part = _encode_part({"alg": "HS256", "typ": "JWT"})
+    payload_part = _encode_part(payload)
+    signed = f"{header_part}.{payload_part}".encode("ascii")
+    signature = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
+    signature_part = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
+    return f"{header_part}.{payload_part}.{signature_part}"
+
+
+def _workbook_bytes():
+    workbook = openpyxl.Workbook()
+    sheet = workbook.active
+    sheet.title = "Data"
+    sheet.append(
+        [
+            "Mã hóa đơn",
+            "Thời gian",
+            "Tên khách hàng",
+            "Mã hàng",
+            "Số lượng",
+            "Đơn giá",
+        ]
+    )
+    sheet.append(["HD001", "01/01/2026", "Khách A", "SP001", 2, 100000])
+    sheet.append(["HD001", "01/01/2026", "Khách A", "SP002", 1, 50000])
+    output = BytesIO()
+    workbook.save(output)
+    return output.getvalue()
+
+
+@pytest.fixture
+def student_api(tmp_path, monkeypatch):
+    upload_root = tmp_path / "uploads"
+    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
+    monkeypatch.setenv("STUDENT_FILE_EXPLAIN_ENABLED", "true")
+    monkeypatch.setenv("STUDENT_FILE_QA_ENABLED", "true")
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
+    monkeypatch.setenv("AI_PROVIDER", "disabled")
+    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.misa_workflow.find_mapping_profile", lambda *args, **kwargs: None)
+    sync_events = []
+    monkeypatch.setattr(
+        "app.student_workflow.record_analysis_completed",
+        lambda token, payload: sync_events.append(payload),
+    )
+    monkeypatch.setattr(
+        "app.student_workflow.assert_student_session_active",
+        lambda token, session_id, upload_id: None,
+    )
+    return TestClient(app), sync_events
+
+
+def _analyze(client, token=None):
+    data = {"target_template_id": "bsn_sales"}
+    if token is not None:
+        data["context_token"] = token
+    return client.post(
+        "/api/v1/student/sessions/analyze",
+        data=data,
+        files={
+            "file": (
+                "sales.xlsx",
+                _workbook_bytes(),
+                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
+            )
+        },
+    )
+
+
+def _ask(client, session_id, token, question):
+    return client.post(
+        f"/api/v1/student/sessions/{session_id}/questions",
+        headers={"X-Student-Context": token},
+        json={"question": question},
+    )
+
+
+def _source_row(client, session_id, token, worksheet_row):
+    return client.get(
+        f"/api/v1/student/sessions/{session_id}/source-rows/{worksheet_row}",
+        headers={"X-Student-Context": token},
+    )
+
+
+def test_student_analyze_requires_valid_signed_context(student_api):
+    client, _ = student_api
+
+    assert _analyze(client).status_code == 422
+    invalid = _analyze(client, "not-a-token")
+    assert invalid.status_code == 401
+    assert "context" in invalid.json()["detail"].lower()
+
+
+def test_student_analyze_is_hidden_when_phase_flag_is_disabled(student_api, monkeypatch):
+    client, _ = student_api
+    monkeypatch.setenv("STUDENT_FILE_EXPLAIN_ENABLED", "false")
+
+    response = _analyze(client, _student_token())
+
+    assert response.status_code == 404
+    assert "chưa được bật" in response.json()["detail"]
+
+
+def test_student_analyze_returns_summary_preview_and_evidence_backed_explanations(
+    student_api,
+):
+    client, sync_events = student_api
+    response = _analyze(client, _student_token())
+
+    assert response.status_code == 200
+    payload = response.json()
+    assert payload["target_template_id"] == "bsn_sales"
+    assert payload["student_summary"]["session_id"] == "507f1f77bcf86cd799439011"
+    assert payload["student_summary"]["data_row_count"] == 2
+    assert payload["student_summary"]["document_count"] == 1
+    assert payload["student_summary"]["recognized_columns"] == 6
+    assert payload["student_summary"]["mapping_counts"]["mapped"] >= 6
+    assert payload["student_summary"]["mapping_counts"]["default"] >= 1
+    assert payload["student_summary"]["mapping_counts"]["formula"] >= 1
+    assert len(payload["student_preview"]["rows"]) == 2
+
+    explanations = payload["explanations"]
+    assert explanations
+    assert all(item["evidence"] for item in explanations)
+    assert all(item["state_hash"] == payload["student_state_hash"] for item in explanations)
+    assert any(item["kind"] == "mapping" for item in explanations)
+    assert any(item["kind"] == "field" for item in explanations)
+    assert any(item["kind"] == "calculation" for item in explanations)
+    assert any(item["kind"] == "issue" for item in explanations)
+    assert any(
+        item["kind"] == "field" and item["target_field"] == "Ngày hạch toán (*)"
+        for item in explanations
+    )
+    assert any(
+        item["kind"] == "calculation" and item["target_field"] == "Thành tiền"
+        for item in explanations
+    )
+    date_normalizations = [
+        item
+        for item in explanations
+        if item["kind"] == "normalization"
+        and item["target_field"] == "Ngày hạch toán (*)"
+    ]
+    assert {item["preview_row"] for item in date_normalizations} == {1, 2}
+    for item in [entry for entry in explanations if entry["kind"] == "mapping"]:
+        evidence_sources = sorted(
+            {
+                evidence["column"]
+                for evidence in item["evidence"]
+                if evidence["kind"] in {"source_column", "source_cell"}
+                and evidence.get("column")
+            }
+        )
+        assert sorted(item["claim_sources"]) == evidence_sources
+
+    assert len(sync_events) == 1
+    sync_payload = sync_events[0]
+    assert sync_payload["event"] == "analysis_completed"
+    assert sync_payload["converterUploadId"] == payload["upload_id"]
+    assert sync_payload["targetTemplateId"] == "bsn_sales"
+    assert sync_payload["status"] == "analyzed"
+    assert "rows" not in json.dumps(sync_payload).lower()
+
+
+def test_student_analyze_rejects_retry_when_session_already_has_upload(student_api):
+    client, _ = student_api
+    token = _student_token()
+
+    first = _analyze(client, token)
+    retry = _analyze(client, token)
+
+    assert first.status_code == 200
+    assert retry.status_code == 409
+    assert "đã có upload" in retry.json()["detail"].lower()
+
+
+def test_concurrent_student_analyze_allows_exactly_one_active_upload(
+    student_api, monkeypatch
+):
+    _, _ = student_api
+    token = _student_token()
+    original_analyze_upload = student_workflow.analyze_upload
+    first_entered = Event()
+    release_first = Event()
+    call_lock = Lock()
+    call_count = 0
+
+    def controlled_analyze_upload(**kwargs):
+        nonlocal call_count
+        with call_lock:
+            call_count += 1
+            current_call = call_count
+        if current_call == 1:
+            first_entered.set()
+            assert release_first.wait(timeout=5)
+        return original_analyze_upload(**kwargs)
+
+    monkeypatch.setattr(
+        student_workflow,
+        "analyze_upload",
+        controlled_analyze_upload,
+    )
+
+    with TestClient(app) as first_client, TestClient(app) as second_client:
+        with ThreadPoolExecutor(max_workers=2) as executor:
+            first_future = executor.submit(_analyze, first_client, token)
+            assert first_entered.wait(timeout=5)
+            second_future = executor.submit(_analyze, second_client, token)
+            try:
+                second_response = second_future.result(timeout=5)
+            finally:
+                release_first.set()
+            first_response = first_future.result(timeout=5)
+
+    assert sorted(
+        [first_response.status_code, second_response.status_code]
+    ) == [200, 409]
+    assert call_count == 1
+    claims = verify_student_context(token, "analyze")
+    active_upload_id = find_student_upload_id(claims)
+    upload_root = student_store.UPLOAD_ROOT
+    active_uploads = [
+        path.name
+        for path in upload_root.iterdir()
+        if path.is_dir() and (path / "student.json").is_file()
+    ]
+    assert active_uploads == [active_upload_id]
+
+
+def test_student_overview_enforces_session_owner_binding(student_api):
+    client, _ = student_api
+    token = _student_token()
+    analyzed = _analyze(client, token).json()
+
+    missing = client.get(
+        "/api/v1/student/sessions/507f1f77bcf86cd799439011/overview"
+    )
+    assert missing.status_code == 401
+
+    other_token = _student_token(
+        session_id="507f1f77bcf86cd799439099",
+        user_id="507f1f77bcf86cd799439098",
+        owner_scope="user:507f1f77bcf86cd799439098",
+    )
+    denied = client.get(
+        "/api/v1/student/sessions/507f1f77bcf86cd799439011/overview",
+        headers={"X-Student-Context": other_token},
+    )
+    assert denied.status_code == 403
+
+    allowed = client.get(
+        "/api/v1/student/sessions/507f1f77bcf86cd799439011/overview",
+        headers={"X-Student-Context": token},
+    )
+    assert allowed.status_code == 200
+    assert allowed.json()["upload_id"] == analyzed["upload_id"]
+
+
+def test_student_overview_rebuilds_when_mapping_state_changes(student_api):
+    client, _ = student_api
+    token = _student_token()
+    analyzed = _analyze(client, token).json()
+    first_state_hash = analyzed["student_state_hash"]
+
+    metadata = _read_metadata(analyzed["upload_id"])
+    suggestion = metadata["suggestion"]
+    changed_defaults = dict(suggestion["defaults"])
+    changed_defaults["Loại tiền"] = "USD"
+    metadata["confirmed"] = {
+        "mapping": suggestion["mapping"],
+        "defaults": changed_defaults,
+        "formulas": suggestion["formulas"],
+    }
+    _write_metadata(analyzed["upload_id"], metadata)
+
+    refreshed = client.get(
+        "/api/v1/student/sessions/507f1f77bcf86cd799439011/overview",
+        headers={"X-Student-Context": token},
+    )
+    assert refreshed.status_code == 200
+    payload = refreshed.json()
+    assert payload["student_state_hash"] != first_state_hash
+    assert payload["mapping_suggestion"]["source"] == "confirmed"
+    assert all(item["state_hash"] == payload["student_state_hash"] for item in payload["explanations"])
+    assert all(item["stale"] is False for item in payload["explanations"])
+    assert any(
+        item["kind"] == "field"
+        and item["target_field"] == "Loại tiền"
+        and item["reason_vi"].startswith("Giá trị mặc định")
+        for item in payload["explanations"]
+    )
+
+
+def test_unchanged_confirmed_mapping_invalidates_heuristic_overview_cache(student_api):
+    client, _ = student_api
+    token = _student_token()
+    analyzed = _analyze(client, token).json()
+    first_state_hash = analyzed["student_state_hash"]
+
+    metadata = _read_metadata(analyzed["upload_id"])
+    suggestion = metadata["suggestion"]
+    metadata["profile_id"] = "507f1f77bcf86cd799439055"
+    metadata["confirmed"] = {
+        "mapping": suggestion["mapping"],
+        "defaults": suggestion["defaults"],
+        "formulas": suggestion["formulas"],
+    }
+    _write_metadata(analyzed["upload_id"], metadata)
+
+    refreshed = client.get(
+        "/api/v1/student/sessions/507f1f77bcf86cd799439011/overview",
+        headers={"X-Student-Context": token},
+    ).json()
+
+    assert refreshed["mapping_suggestion"]["source"] == "confirmed"
+    assert refreshed["student_state_hash"] != first_state_hash
+
+
+def test_analysis_completed_client_sends_service_and_student_context_headers(
+    monkeypatch,
+):
+    captured = {}
+
+    class Response:
+        status_code = 200
+
+    def fake_post(url, **kwargs):
+        captured["url"] = url
+        captured.update(kwargs)
+        return Response()
+
+    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
+    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node.test/api/internal")
+    monkeypatch.setattr("app.student_session_client.httpx.post", fake_post)
+    token = _student_token()
+    payload = {
+        "event": "analysis_completed",
+        "sessionId": "507f1f77bcf86cd799439011",
+        "converterUploadId": "upload-1",
+    }
+
+    record_analysis_completed(token, payload)
+
+    assert captured["url"].endswith(
+        "/student/sessions/507f1f77bcf86cd799439011/events"
+    )
+    assert captured["headers"] == {
+        "x-converter-service-token": "service-secret",
+        "x-student-context": token,
+    }
+    assert captured["json"] == payload
+
+
+def test_student_question_requires_phase_flag_ask_scope_and_matching_session(
+    student_api,
+    monkeypatch,
+):
+    client, _ = student_api
+    session_id = "507f1f77bcf86cd799439011"
+    token = _student_token()
+    assert _analyze(client, token).status_code == 200
+
+    monkeypatch.setenv("STUDENT_FILE_QA_ENABLED", "false")
+    disabled = _ask(client, session_id, token, "File này có bao nhiêu dòng?")
+    assert disabled.status_code == 404
+
+    monkeypatch.setenv("STUDENT_FILE_QA_ENABLED", "true")
+    missing_scope = _ask(
+        client,
+        session_id,
+        _student_token(allowed_scopes=["analyze", "explain"]),
+        "File này có bao nhiêu dòng?",
+    )
+    assert missing_scope.status_code == 401
+    assert "ask" in missing_scope.json()["detail"]
+
+    other_session = _ask(
+        client,
+        "507f1f77bcf86cd799439099",
+        token,
+        "File này có bao nhiêu dòng?",
+    )
+    assert other_session.status_code == 403
+
+
+def test_student_question_returns_valid_evidence_and_sanitized_best_effort_event(
+    student_api,
+    monkeypatch,
+):
+    client, _ = student_api
+    token = _student_token()
+    analyzed = _analyze(client, token).json()
+    captured = []
+    active_checks = []
+    monkeypatch.setattr(
+        "app.student_workflow.assert_student_session_active",
+        lambda context_token, session_id, upload_id: active_checks.append(
+            (context_token, session_id, upload_id)
+        ),
+    )
+    monkeypatch.setattr(
+        "app.student_workflow.record_question_event",
+        lambda context_token, payload: captured.append((context_token, payload)),
+    )
+
+    response = _ask(
+        client,
+        "507f1f77bcf86cd799439011",
+        token,
+        "Những dòng nào có hóa đơn HD001?",
+    )
+
+    assert response.status_code == 200
+    payload = response.json()
+    assert payload["intent"] == "locate_rows"
+    assert payload["outcome"] == "supported"
+    assert payload["evidence"]
+    active_headers = set(analyzed["detected"]["headers"])
+    first_data_row = analyzed["detected"]["header_row"] + 1
+    last_data_row = first_data_row + analyzed["detected"]["row_count"] - 1
+    assert all(item["field"] in active_headers for item in payload["evidence"])
+    assert all(first_data_row <= item["row"] <= last_data_row for item in payload["evidence"])
+    assert payload["event_sync"]["status"] == "synced"
+    assert active_checks == [
+        (token, "507f1f77bcf86cd799439011", analyzed["upload_id"])
+    ]
+
+    assert len(captured) == 1
+    context_token, event = captured[0]
+    assert context_token == token
+    assert event == {
+        "event": "question_answered",
+        "sessionId": "507f1f77bcf86cd799439011",
+        "question": "Những dòng nào có hóa đơn HD001?",
+        "answerType": "deterministic_file_query",
+        "evidenceIds": [item["id"] for item in payload["evidence"]],
+        "evidenceCount": payload["evidence_count"],
+        "outcome": "supported",
+    }
+    serialized = json.dumps(event, ensure_ascii=False).lower()
+    assert "rows" not in serialized
+    assert "actual" not in serialized
+    assert "expected" not in serialized
+
+
+def test_student_question_event_failure_does_not_hide_deterministic_answer(
+    student_api,
+    monkeypatch,
+):
+    client, _ = student_api
+    token = _student_token()
+    assert _analyze(client, token).status_code == 200
+
+    def unavailable(*args, **kwargs):
+        raise student_workflow.StudentSessionClientError("node offline")
+
+    monkeypatch.setattr("app.student_workflow.record_question_event", unavailable)
+    response = _ask(
+        client,
+        "507f1f77bcf86cd799439011",
+        token,
+        "Tổng đơn giá là bao nhiêu?",
+    )
+
+    assert response.status_code == 200
+    assert response.json()["outcome"] == "supported"
+    assert response.json()["event_sync"]["status"] == "unavailable"
+
+
+def test_question_event_client_sends_only_sanitized_metadata(monkeypatch):
+    captured = {}
+
+    class Response:
+        status_code = 202
+
+    def fake_post(url, **kwargs):
+        captured["url"] = url
+        captured.update(kwargs)
+        return Response()
+
+    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
+    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node.test/api/internal")
+    monkeypatch.setattr("app.student_session_client.httpx.post", fake_post)
+    token = _student_token()
+    payload = {
+        "event": "question_answered",
+        "sessionId": "507f1f77bcf86cd799439011",
+        "question": "Có bao nhiêu hóa đơn?",
+        "answerType": "deterministic_file_query",
+        "evidenceIds": ["question-evidence-1"],
+        "evidenceCount": 1,
+        "outcome": "supported",
+    }
+
+    record_question_event(token, payload)
+
+    assert captured["url"].endswith(
+        "/student/sessions/507f1f77bcf86cd799439011/questions"
+    )
+    assert captured["headers"] == {
+        "x-converter-service-token": "service-secret",
+        "x-student-context": token,
+    }
+    assert captured["json"] == payload
+
+
+@pytest.mark.parametrize(
+    ("node_status", "expected_status"),
+    [(503, 503), (410, 410), (403, 403), (409, 409)],
+)
+def test_student_question_fails_closed_when_node_session_is_unavailable_or_inactive(
+    student_api,
+    monkeypatch,
+    node_status,
+    expected_status,
+):
+    client, _ = student_api
+    token = _student_token()
+    assert _analyze(client, token).status_code == 200
+    query_called = False
+
+    def fail_active_check(context_token, session_id, upload_id):
+        raise StudentSessionClientError("node session inactive", status_code=node_status)
+
+    def should_not_query(*args, **kwargs):
+        nonlocal query_called
+        query_called = True
+        raise AssertionError("query must not run before active Node session check")
+
+    monkeypatch.setattr(
+        "app.student_workflow.assert_student_session_active",
+        fail_active_check,
+    )
+    monkeypatch.setattr("app.student_workflow.answer_question", should_not_query)
+
+    response = _ask(
+        client,
+        "507f1f77bcf86cd799439011",
+        token,
+        "Có bao nhiêu hóa đơn?",
+    )
+
+    assert response.status_code == expected_status
+    assert query_called is False
+
+
+def test_active_session_client_authenticates_with_service_and_signed_context(monkeypatch):
+    captured = {}
+
+    class Response:
+        status_code = 200
+
+        @staticmethod
+        def json():
+            return {"success": True, "active": True}
+
+    def fake_get(url, **kwargs):
+        captured["url"] = url
+        captured.update(kwargs)
+        return Response()
+
+    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
+    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node.test/api/internal")
+    monkeypatch.setattr("app.student_session_client.httpx.get", fake_get)
+    token = _student_token()
+
+    assert_student_session_active(token, "507f1f77bcf86cd799439011", "upload-1")
+
+    assert captured["url"].endswith(
+        "/student/sessions/507f1f77bcf86cd799439011/active"
+    )
+    assert captured["headers"] == {
+        "x-converter-service-token": "service-secret",
+        "x-student-context": token,
+    }
+    assert captured["params"] == {"uploadId": "upload-1"}
+
+
+def test_source_row_endpoint_returns_exact_owner_bound_worksheet_row(student_api):
+    client, _ = student_api
+    session_id = "507f1f77bcf86cd799439011"
+    token = _student_token()
+    analyzed = _analyze(client, token).json()
+
+    response = _source_row(client, session_id, token, 3)
+
+    assert response.status_code == 200
+    payload = response.json()
+    assert payload["session_id"] == session_id
+    assert payload["upload_id"] == analyzed["upload_id"]
+    assert payload["sheet"] == "Data"
+    assert payload["worksheet_row"] == 3
+    assert payload["header_row"] == 1
+    assert payload["fields"] == [
+        {"field": "Mã hóa đơn", "value": "HD001"},
+        {"field": "Thời gian", "value": "01/01/2026"},
+        {"field": "Tên khách hàng", "value": "Khách A"},
+        {"field": "Mã hàng", "value": "SP002"},
+        {"field": "Số lượng", "value": 1},
+        {"field": "Đơn giá", "value": 50000},
+    ]
+
+
+@pytest.mark.parametrize("worksheet_row", [1, 99])
+def test_source_row_endpoint_rejects_header_and_out_of_range_rows(
+    student_api,
+    worksheet_row,
+):
+    client, _ = student_api
+    token = _student_token()
+    assert _analyze(client, token).status_code == 200
+
+    response = _source_row(
+        client,
+        "507f1f77bcf86cd799439011",
+        token,
+        worksheet_row,
+    )
+
+    assert response.status_code == 404
+
+
+def test_source_row_endpoint_is_ask_scope_and_session_bounded(student_api):
+    client, _ = student_api
+    token = _student_token()
+    assert _analyze(client, token).status_code == 200
+
+    missing_scope = _source_row(
+        client,
+        "507f1f77bcf86cd799439011",
+        _student_token(allowed_scopes=["analyze", "explain"]),
+        2,
+    )
+    wrong_session = _source_row(
+        client,
+        "507f1f77bcf86cd799439099",
+        token,
+        2,
+    )
+
+    assert missing_scope.status_code == 401
+    assert wrong_session.status_code == 403
diff --git a/converter/tests/test_student_context.py b/converter/tests/test_student_context.py
new file mode 100755
index 0000000..efaed65
--- /dev/null
+++ b/converter/tests/test_student_context.py
@@ -0,0 +1,490 @@
+import base64
+import hashlib
+import hmac
+import json
+import time
+from io import BytesIO
+from pathlib import Path
+from threading import Event, Thread
+
+import openpyxl
+import pytest
+
+from app import student_store as student_store_module
+from app.misa_workflow import (
+    analyze_upload,
+    confirm_mapping,
+    export_confirmed_profile,
+    preview_mapping,
+)
+from app.student_context import verify_student_context
+from app.student_store import (
+    StudentUploadConflictError,
+    assert_upload_owner,
+    bind_upload_to_student,
+    claim_student_analysis,
+    cleanup_expired_student_uploads,
+    find_student_upload_id,
+)
+
+
+def _encode_part(payload):
+    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
+    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
+
+
+def _student_token(secret="student-secret", **overrides):
+    payload = {
+        "purpose": "student_file_session",
+        "session_id": "session-1",
+        "user_id": "user-1",
+        "owner_scope": "user:user-1",
+        "workspace_id": None,
+        "snapshot_set_hash": None,
+        "allowed_scopes": ["analyze", "explain", "attempt", "export"],
+        "iat": int(time.time()),
+        "exp": int(time.time()) + 600,
+    }
+    payload.update(overrides)
+    header_part = _encode_part({"alg": "HS256", "typ": "JWT"})
+    payload_part = _encode_part(payload)
+    signed = f"{header_part}.{payload_part}".encode("ascii")
+    signature = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
+    signature_part = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
+    return f"{header_part}.{payload_part}.{signature_part}"
+
+
+def _workbook_bytes():
+    workbook = openpyxl.Workbook()
+    sheet = workbook.active
+    sheet.append(["Mã hóa đơn", "Thời gian", "Mã hàng"])
+    sheet.append(["HD001", "01/01/2026", "SP001"])
+    output = BytesIO()
+    workbook.save(output)
+    return output.getvalue()
+
+
+def test_verify_student_context_accepts_node_compatible_hs256_claims(monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+
+    claims = verify_student_context(_student_token(), "analyze")
+
+    assert claims.session_id == "session-1"
+    assert claims.user_id == "user-1"
+    assert claims.owner_scope == "user:user-1"
+    assert claims.allowed_scopes == ("analyze", "explain", "attempt", "export")
+
+
+@pytest.mark.parametrize(
+    ("overrides", "required_scope", "message"),
+    [
+        ({"exp": int(time.time()) - 1}, "analyze", "hết hạn"),
+        ({"purpose": "misa_conversion"}, "analyze", "mục đích"),
+        ({"allowed_scopes": ["export"]}, "analyze", "thiếu quyền"),
+        ({"session_id": ""}, "analyze", "session"),
+        ({"user_id": ""}, "analyze", "user"),
+        ({"owner_scope": "user:another-user"}, "analyze", "owner scope"),
+    ],
+)
+def test_verify_student_context_rejects_invalid_claims(
+    monkeypatch, overrides, required_scope, message
+):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+
+    with pytest.raises(ValueError, match=message):
+        verify_student_context(_student_token(**overrides), required_scope)
+
+
+def test_student_upload_binding_rejects_cross_owner_and_session(tmp_path, monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    upload_dir = tmp_path / "upload-1"
+    upload_dir.mkdir()
+    (upload_dir / "input.xlsx").write_bytes(b"raw-workbook")
+    claims = verify_student_context(_student_token(), "analyze")
+
+    bind_upload_to_student("upload-1", claims, ttl_seconds=600)
+
+    metadata = json.loads((upload_dir / "student.json").read_text(encoding="utf-8"))
+    assert set(metadata) == {
+        "session_id",
+        "user_id",
+        "owner_scope",
+        "workspace_id",
+        "expires_at",
+    }
+    assert_upload_owner("upload-1", claims)
+
+    other_owner = verify_student_context(
+        _student_token(
+            session_id="session-2",
+            user_id="user-2",
+            owner_scope="user:user-2",
+        ),
+        "analyze",
+    )
+    with pytest.raises(ValueError, match="không thuộc"):
+        assert_upload_owner("upload-1", other_owner)
+
+    with pytest.raises(ValueError, match="Upload id không hợp lệ"):
+        assert_upload_owner("..", claims)
+
+
+def test_cleanup_expired_student_uploads_deletes_only_expired_bound_directories(
+    tmp_path, monkeypatch
+):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    claims = verify_student_context(_student_token(exp=int(time.time()) + 3600), "analyze")
+    for upload_id in ("expired", "active"):
+        upload_dir = tmp_path / upload_id
+        upload_dir.mkdir()
+        (upload_dir / "input.xlsx").write_bytes(b"raw-workbook")
+        bind_upload_to_student(upload_id, claims, ttl_seconds=600)
+
+    expired_metadata = json.loads(
+        (tmp_path / "expired" / "student.json").read_text(encoding="utf-8")
+    )
+    expired_metadata["expires_at"] = 100
+    (tmp_path / "expired" / "student.json").write_text(
+        json.dumps(expired_metadata), encoding="utf-8"
+    )
+
+    deleted = cleanup_expired_student_uploads(now=200)
+
+    assert deleted == ["expired"]
+    assert not (tmp_path / "expired").exists()
+    assert (tmp_path / "active").exists()
+
+
+def test_find_student_upload_rejects_multiple_active_matches(tmp_path, monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    claims = verify_student_context(_student_token(), "analyze")
+    for upload_id in ("upload-a", "upload-b"):
+        upload_dir = tmp_path / upload_id
+        upload_dir.mkdir()
+        bind_upload_to_student(upload_id, claims, ttl_seconds=600)
+
+    with pytest.raises(StudentUploadConflictError, match="nhiều upload"):
+        find_student_upload_id(claims)
+
+
+def test_student_analysis_claim_is_hashed_atomic_and_released(tmp_path, monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    claims = verify_student_context(
+        _student_token(
+            session_id="../session-1",
+            user_id="owner-1",
+            owner_scope="user:owner-1",
+        ),
+        "analyze",
+    )
+
+    with claim_student_analysis(claims):
+        lock_files = list(tmp_path.glob(".student-analyze-*.lock"))
+        assert len(lock_files) == 1
+        assert claims.session_id not in lock_files[0].name
+        assert claims.owner_scope not in lock_files[0].name
+        with pytest.raises(StudentUploadConflictError, match="đang được phân tích"):
+            with claim_student_analysis(claims):
+                pass
+
+    assert not list(tmp_path.glob(".student-analyze-*.lock"))
+    with pytest.raises(RuntimeError, match="simulated failure"):
+        with claim_student_analysis(claims):
+            raise RuntimeError("simulated failure")
+    assert not list(tmp_path.glob(".student-analyze-*.lock"))
+
+
+def test_student_analysis_reclaims_stale_timestamped_lock(tmp_path, monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("STUDENT_ANALYZE_TIMEOUT_SECONDS", "5")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    claims = verify_student_context(_student_token(), "analyze")
+
+    with claim_student_analysis(claims):
+        lock_path = next(tmp_path.glob(".student-analyze-*.lock"))
+
+    stale_timestamp = time.time() - 30
+    lock_path.write_text(
+        json.dumps(
+            {
+                "token": "abandoned-analysis",
+                "created_at": stale_timestamp,
+                "heartbeat_at": stale_timestamp,
+            }
+        ),
+        encoding="utf-8",
+    )
+
+    with claim_student_analysis(claims):
+        current = json.loads(lock_path.read_text(encoding="utf-8"))
+        assert current["token"] != "abandoned-analysis"
+        assert current["heartbeat_at"] > stale_timestamp
+
+    assert not lock_path.exists()
+
+
+def test_student_analysis_heartbeat_prevents_stealing_active_lock(tmp_path, monkeypatch):
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("STUDENT_ANALYZE_TIMEOUT_SECONDS", "1")
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", tmp_path)
+    claims = verify_student_context(_student_token(), "analyze")
+
+    with claim_student_analysis(claims):
+        lock_path = next(tmp_path.glob(".student-analyze-*.lock"))
+        initial = json.loads(lock_path.read_text(encoding="utf-8"))
+        time.sleep(1.2)
+        current = json.loads(lock_path.read_text(encoding="utf-8"))
+        assert current["token"] == initial["token"]
+        assert current["heartbeat_at"] > initial["heartbeat_at"]
+        with pytest.raises(StudentUploadConflictError, match="đang được phân tích"):
+            with claim_student_analysis(claims):
+                pass
+
+
+def test_reclaimer_mutex_prevents_heartbeat_update_between_stale_check_and_unlink(
+    tmp_path,
+    monkeypatch,
+):
+    lock_path = tmp_path / ".student-analyze-race.lock"
+    reclaim_path = lock_path.with_suffix(".reclaim")
+    stale_timestamp = time.time() - 30
+    lock_path.write_text(
+        json.dumps(
+            {
+                "token": "active-owner",
+                "created_at": stale_timestamp,
+                "heartbeat_at": stale_timestamp,
+            }
+        ),
+        encoding="utf-8",
+    )
+    stale_checked = Event()
+    allow_unlink = Event()
+    original_stale_check = student_store_module._analysis_lock_is_stale
+
+    def controlled_stale_check(path, timeout_seconds):
+        result = original_stale_check(path, timeout_seconds)
+        stale_checked.set()
+        assert allow_unlink.wait(timeout=2)
+        return result
+
+    monkeypatch.setattr(
+        student_store_module,
+        "_analysis_lock_is_stale",
+        controlled_stale_check,
+    )
+    result = {}
+
+    def reclaim():
+        result["reclaimed"] = student_store_module._reclaim_stale_analysis_lock(
+            lock_path,
+            reclaim_path,
+            "new-owner",
+            timeout_seconds=5,
+        )
+
+    reclaimer = Thread(target=reclaim)
+    reclaimer.start()
+    assert stale_checked.wait(timeout=2)
+
+    refreshed = student_store_module._refresh_analysis_lock(
+        lock_path,
+        reclaim_path,
+        "active-owner",
+    )
+    during_reclaim = json.loads(lock_path.read_text(encoding="utf-8"))
+    assert refreshed is False
+    assert during_reclaim["heartbeat_at"] == stale_timestamp
+
+    allow_unlink.set()
+    reclaimer.join(timeout=2)
+    assert result["reclaimed"] is True
+    current = json.loads(lock_path.read_text(encoding="utf-8"))
+    assert current["token"] == "new-owner"
+
+
+def test_orphaned_reclaim_mutex_is_recovered_after_configured_ttl(tmp_path, monkeypatch):
+    monkeypatch.setenv("STUDENT_ANALYZE_MUTEX_TTL_SECONDS", "30")
+    reclaim_path = tmp_path / ".student-analyze-race.reclaim"
+    reclaim_path.write_text(
+        json.dumps({"token": "orphan", "created_at": time.time() - 31}),
+        encoding="utf-8",
+    )
+
+    with student_store_module._claim_analysis_reclaim_mutex(
+        reclaim_path,
+        "new-owner",
+    ) as acquired:
+        assert acquired is True
+        payload = json.loads(reclaim_path.read_text(encoding="utf-8"))
+        assert payload["token"] == "new-owner"
+        assert payload["created_at"] > time.time() - 2
+
+    assert not reclaim_path.exists()
+
+
+def test_recent_reclaim_mutex_cannot_be_stolen(tmp_path, monkeypatch):
+    monkeypatch.setenv("STUDENT_ANALYZE_MUTEX_TTL_SECONDS", "30")
+    reclaim_path = tmp_path / ".student-analyze-race.reclaim"
+    created_at = time.time()
+    reclaim_path.write_text(
+        json.dumps({"token": "active-owner", "created_at": created_at}),
+        encoding="utf-8",
+    )
+
+    with student_store_module._claim_analysis_reclaim_mutex(
+        reclaim_path,
+        "new-owner",
+    ) as acquired:
+        assert acquired is False
+
+    payload = json.loads(reclaim_path.read_text(encoding="utf-8"))
+    assert payload == {"token": "active-owner", "created_at": created_at}
+
+
+def test_student_upload_is_bound_before_workbook_write_failure_and_later_cleaned(
+    tmp_path, monkeypatch
+):
+    upload_root = tmp_path / "uploads"
+    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("STUDENT_UPLOAD_RETENTION_SECONDS", "1")
+    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
+    original_write_bytes = Path.write_bytes
+
+    def fail_input_write(path, data):
+        if path.name.startswith("input"):
+            raise OSError("simulated workbook write failure")
+        return original_write_bytes(path, data)
+
+    monkeypatch.setattr(Path, "write_bytes", fail_input_write)
+
+    with pytest.raises(OSError, match="simulated workbook write failure"):
+        analyze_upload(
+            filename="student.xlsx",
+            content=_workbook_bytes(),
+            requested_target_template_id="bsn_sales",
+            student_context_token=_student_token(),
+        )
+
+    upload_dirs = [path for path in upload_root.iterdir() if path.is_dir()]
+    assert len(upload_dirs) == 1
+    metadata = json.loads(
+        (upload_dirs[0] / "student.json").read_text(encoding="utf-8")
+    )
+    assert not (upload_dirs[0] / "input.xlsx").exists()
+
+    deleted = cleanup_expired_student_uploads(now=metadata["expires_at"])
+
+    assert deleted == [upload_dirs[0].name]
+    assert not upload_dirs[0].exists()
+
+
+def test_analyze_binds_student_owner_and_preview_rejects_cross_owner(
+    tmp_path, monkeypatch
+):
+    upload_root = tmp_path / "uploads"
+    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
+    monkeypatch.setenv("AI_PROVIDER", "disabled")
+    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.misa_workflow.find_mapping_profile", lambda *args, **kwargs: None)
+    token = _student_token()
+
+    analyzed = analyze_upload(
+        filename="student.xlsx",
+        content=_workbook_bytes(),
+        requested_target_template_id="bsn_sales",
+        student_context_token=token,
+    )
+    claims = verify_student_context(token, "analyze")
+    assert_upload_owner(analyzed["upload_id"], claims)
+
+    other_token = _student_token(
+        session_id="session-2",
+        user_id="user-2",
+        owner_scope="user:user-2",
+    )
+    suggestion = analyzed["mapping_suggestion"]
+    with pytest.raises(ValueError, match="không thuộc"):
+        preview_mapping(
+            upload_id=analyzed["upload_id"],
+            target_template_id="bsn_sales",
+            mapping=suggestion["mapping"],
+            defaults=suggestion["defaults"],
+            formulas=suggestion["formulas"],
+            student_context_token=other_token,
+        )
+
+
+def test_analyze_rejects_combining_student_and_conversion_contexts(
+    tmp_path, monkeypatch
+):
+    upload_root = tmp_path / "uploads"
+    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
+
+    with pytest.raises(ValueError, match="đồng thời"):
+        analyze_upload(
+            filename="student.xlsx",
+            content=_workbook_bytes(),
+            requested_target_template_id="bsn_sales",
+            conversion_context_token="conversion-token",
+            student_context_token=_student_token(),
+        )
+
+
+def test_student_mapping_operations_require_operation_specific_scopes(
+    tmp_path, monkeypatch
+):
+    upload_root = tmp_path / "uploads"
+    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
+    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "student-secret")
+    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
+    monkeypatch.setenv("AI_PROVIDER", "disabled")
+    monkeypatch.setattr("app.misa_workflow.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.student_store.UPLOAD_ROOT", upload_root)
+    monkeypatch.setattr("app.misa_workflow.find_mapping_profile", lambda *args, **kwargs: None)
+    phase_one = _student_token(allowed_scopes=["analyze", "explain"])
+    analyzed = analyze_upload(
+        filename="student.xlsx",
+        content=_workbook_bytes(),
+        requested_target_template_id="bsn_sales",
+        student_context_token=phase_one,
+    )
+    suggestion = analyzed["mapping_suggestion"]
+
+    preview_mapping(
+        upload_id=analyzed["upload_id"],
+        target_template_id="bsn_sales",
+        mapping=suggestion["mapping"],
+        defaults=suggestion["defaults"],
+        formulas=suggestion["formulas"],
+        student_context_token=phase_one,
+    )
+
+    with pytest.raises(ValueError, match="attempt"):
+        confirm_mapping(
+            upload_id=analyzed["upload_id"],
+            target_template_id="bsn_sales",
+            mapping=suggestion["mapping"],
+            defaults=suggestion["defaults"],
+            formulas=suggestion["formulas"],
+            student_context_token=phase_one,
+        )
+
+    with pytest.raises(ValueError, match="export"):
+        export_confirmed_profile(
+            upload_id=analyzed["upload_id"],
+            profile_id="profile-1",
+            student_context_token=phase_one,
+        )
diff --git a/converter/tests/fixtures/student_question_benchmark.json b/converter/tests/fixtures/student_question_benchmark.json
new file mode 100755
index 0000000..8fbe93c
--- /dev/null
+++ b/converter/tests/fixtures/student_question_benchmark.json
@@ -0,0 +1,404 @@
+[
+  {
+    "state": "sales",
+    "question": "Tóm tắt file này giúp tôi",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "File bán hàng này có gì?",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cho tôi tổng quan file",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "File này có bao nhiêu dòng?",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tình trạng file hiện tại thế nào?",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tóm tắt dữ liệu mua hàng",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Cho biết tổng quan file mua vào",
+    "expected_intent": "file_summary",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cột mã hóa đơn nằm ở đâu?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "File có cột tên khách hàng không?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tìm cột tiền thuế GTGT",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cột tổng thanh toán là cột nào?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Cột tên nhà cung cấp nằm ở đâu?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tìm cột mã hàng",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "File mua hàng có cột thuế suất GTGT không?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Cột số hóa đơn là cột nào?",
+    "expected_intent": "locate_column",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Những dòng nào có hóa đơn HD001?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tìm các dòng của HD002",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Khách B xuất hiện ở dòng nào?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Dòng nào có tổng thanh toán 330000?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Hóa đơn MH003 nằm ở những dòng nào?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tìm dòng có nhà cung cấp NCC B",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Mã hàng VT001 ở dòng nào?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Dòng nào có thành tiền 150000?",
+    "expected_intent": "locate_rows",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cột Mã hóa đơn map vào trường nào?",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Giải thích mapping của Ngày hóa đơn",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tên khách hàng được ghép sang đâu?",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Mã hàng map vào trường MISA nào?",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Giải thích mapping cột Số hóa đơn",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Cột Thuế suất GTGT được đưa vào đâu?",
+    "expected_intent": "explain_mapping",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Giải thích lỗi tiền thuế ở dòng 4",
+    "expected_intent": "explain_issue",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Vì sao file đang có blocker?",
+    "expected_intent": "explain_issue",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Giải thích lỗi ở file mua hàng",
+    "expected_intent": "explain_issue",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Vì sao dòng 4 bị lỗi thuế?",
+    "expected_intent": "explain_issue",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tổng thành tiền là bao nhiêu?",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cộng cột tiền thuế GTGT",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tổng thanh toán của file là bao nhiêu?",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tính tổng đơn giá",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tổng thành tiền mua hàng là bao nhiêu?",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Cộng tiền thuế GTGT đầu vào",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tổng số lượng mua là bao nhiêu?",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tính tổng đơn giá trong file mua",
+    "expected_intent": "aggregate_amount",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Có bao nhiêu hóa đơn?",
+    "expected_intent": "count_documents",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Đếm số chứng từ bán hàng",
+    "expected_intent": "count_documents",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "File mua có bao nhiêu hóa đơn?",
+    "expected_intent": "count_documents",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Đếm số chứng từ mua hàng",
+    "expected_intent": "count_documents",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Có hóa đơn trùng không?",
+    "expected_intent": "find_duplicates",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Tìm chứng từ bị trùng thông tin",
+    "expected_intent": "find_duplicates",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Hóa đơn mua nào bị trùng?",
+    "expected_intent": "find_duplicates",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Kiểm tra trùng số hóa đơn mua hàng",
+    "expected_intent": "find_duplicates",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Dòng nào lệch tiền thuế GTGT?",
+    "expected_intent": "find_vat_mismatches",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Có bao nhiêu lỗi VAT?",
+    "expected_intent": "find_vat_mismatches",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tìm chênh lệch thuế GTGT đầu vào",
+    "expected_intent": "find_vat_mismatches",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tiền thuế mua hàng có dòng nào không khớp?",
+    "expected_intent": "find_vat_mismatches",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Cần sửa gì trước khi export?",
+    "expected_intent": "required_actions_before_export",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Việc nào bắt buộc làm trước khi import MISA?",
+    "expected_intent": "required_actions_before_export",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "File mua hàng cần xử lý gì trước khi xuất?",
+    "expected_intent": "required_actions_before_export",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Các bước cần làm trước import là gì?",
+    "expected_intent": "required_actions_before_export",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Thành tiền có ý nghĩa gì?",
+    "expected_intent": "concept_explanation",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Giải thích khái niệm tiền thuế GTGT",
+    "expected_intent": "concept_explanation",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Mã hàng dùng để làm gì?",
+    "expected_intent": "concept_explanation",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tên nhà cung cấp có ý nghĩa gì?",
+    "expected_intent": "concept_explanation",
+    "expected_outcome": "supported"
+  },
+  {
+    "state": "sales",
+    "question": "Hóa đơn này có chắc chắn hợp lệ không?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  },
+  {
+    "state": "sales",
+    "question": "Thuế GTGT này có được khấu trừ không?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  },
+  {
+    "state": "sales",
+    "question": "Nên hạch toán tài khoản nào?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  },
+  {
+    "state": "sales",
+    "question": "Thuế suất 10% có đúng luật không?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  },
+  {
+    "state": "purchase",
+    "question": "Chi phí này có được trừ khi tính thuế không?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  },
+  {
+    "state": "purchase",
+    "question": "Tôi chắc chắn dùng tài khoản 156 được chứ?",
+    "expected_intent": "unsupported_legal_or_business_judgment",
+    "expected_outcome": "unsupported"
+  }
+]
diff --git a/frontend/src/components/student/FileQuestionPanel.jsx b/frontend/src/components/student/FileQuestionPanel.jsx
new file mode 100755
index 0000000..65b8d81
--- /dev/null
+++ b/frontend/src/components/student/FileQuestionPanel.jsx
@@ -0,0 +1,188 @@
+import { useMemo, useState } from "react";
+import {
+  AlertTriangle,
+  BotOff,
+  CheckCircle2,
+  Loader2,
+  MessageSquareText,
+  RotateCcw,
+  Send,
+} from "lucide-react";
+import {
+  formatStudentQuestionEvidenceLabel,
+  getStudentQuestionAnswerState,
+  getStudentQuestionSuggestions,
+} from "../../utils/studentAssistant";
+
+const stateTone = {
+  supported: "bg-emerald-50 text-emerald-800",
+  unsupported: "bg-amber-50 text-amber-800",
+  ai_unavailable: "bg-slate-100 text-slate-700",
+};
+
+export default function FileQuestionPanel({
+  targetTemplateId,
+  aiStatus,
+  history,
+  loading,
+  error,
+  onAsk,
+  onRetry,
+  onEvidenceNavigate,
+}) {
+  const [question, setQuestion] = useState("");
+  const suggestions = useMemo(
+    () => getStudentQuestionSuggestions(targetTemplateId),
+    [targetTemplateId],
+  );
+
+  const submit = (value) => {
+    const normalized = String(value || "").trim();
+    if (!normalized || loading) return;
+    setQuestion("");
+    onAsk(normalized);
+  };
+
+  return (
+    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card xl:col-span-3">
+      <div className="grid lg:grid-cols-[360px_minmax(0,1fr)]">
+        <div className="border-b border-slate-100 bg-slate-950 p-5 text-white lg:border-b-0 lg:border-r lg:border-slate-800">
+          <div className="flex items-center gap-3">
+            <span className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-200">
+              <MessageSquareText size={22} />
+            </span>
+            <div>
+              <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-300">
+                Phase 2 · Ask About This File
+              </p>
+              <h2 className="mt-1 text-xl font-black">Hỏi từ dữ liệu đang mở</h2>
+            </div>
+          </div>
+          <p className="mt-4 text-sm leading-6 text-slate-300">
+            Hệ thống chạy truy vấn deterministic trước. Mỗi câu trả lời theo file phải có
+            evidence hợp lệ; nếu thiếu căn cứ, hệ thống nói rõ là chưa hỗ trợ.
+          </p>
+          {!["online", "enabled"].includes(String(aiStatus || "").toLowerCase()) && (
+            <div className="mt-4 flex gap-2 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-300">
+              <BotOff className="mt-0.5 shrink-0 text-slate-400" size={16} />
+              AI bổ sung không khả dụng; các truy vấn deterministic vẫn hoạt động.
+            </div>
+          )}
+          <div className="mt-5 flex flex-wrap gap-2">
+            {suggestions.map((suggestion) => (
+              <button
+                key={suggestion}
+                type="button"
+                onClick={() => submit(suggestion)}
+                disabled={loading}
+                className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-left text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50"
+              >
+                {suggestion}
+              </button>
+            ))}
+          </div>
+        </div>
+
+        <div className="p-5 sm:p-6">
+          <form
+            className="flex flex-col gap-3 sm:flex-row"
+            onSubmit={(event) => {
+              event.preventDefault();
+              submit(question);
+            }}
+          >
+            <label className="min-w-0 flex-1">
+              <span className="sr-only">Câu hỏi về file đang mở</span>
+              <input
+                value={question}
+                onChange={(event) => setQuestion(event.target.value)}
+                maxLength={2000}
+                placeholder="Ví dụ: Dòng nào lệch tiền thuế GTGT?"
+                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-primary-500 focus:bg-white"
+              />
+            </label>
+            <button
+              type="submit"
+              disabled={loading || !question.trim()}
+              className="btn-primary justify-center px-5 disabled:cursor-not-allowed disabled:opacity-50"
+            >
+              {loading ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
+              {loading ? "Đang truy vấn" : "Hỏi file"}
+            </button>
+          </form>
+
+          {error && (
+            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-800">
+              <span className="flex items-center gap-2">
+                <AlertTriangle size={17} /> {error}
+              </span>
+              <button type="button" onClick={onRetry} className="btn-secondary py-2">
+                <RotateCcw size={15} /> Thử lại
+              </button>
+            </div>
+          )}
+
+          <div className="mt-5 space-y-4" aria-live="polite">
+            {!history.length && !loading && (
+              <div className="rounded-2xl border border-dashed border-slate-200 p-7 text-center">
+                <MessageSquareText className="mx-auto text-slate-300" size={30} />
+                <p className="mt-2 text-sm font-bold text-gray-800">Chưa có câu hỏi trong phiên</p>
+                <p className="mt-1 text-xs text-gray-500">
+                  Chọn gợi ý hoặc nhập câu hỏi có thể kiểm tra từ file.
+                </p>
+              </div>
+            )}
+            {[...history].reverse().map((entry, index) => {
+              const answerState = getStudentQuestionAnswerState(entry.answer);
+              return (
+                <article
+                  key={`${entry.question}-${history.length - index}`}
+                  className="rounded-2xl border border-slate-200 p-4"
+                >
+                  <p className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+                    Câu hỏi
+                  </p>
+                  <p className="mt-1 text-sm font-bold text-gray-900">{entry.question}</p>
+                  <div className="mt-3 flex flex-wrap items-center gap-2">
+                    <span
+                      className={`rounded-full px-2.5 py-1 text-[11px] font-black ${stateTone[answerState.kind]}`}
+                    >
+                      {answerState.label}
+                    </span>
+                    {answerState.kind === "supported" && (
+                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
+                        <CheckCircle2 size={13} /> {entry.answer.evidence_count} evidence
+                      </span>
+                    )}
+                  </div>
+                  <p className="mt-3 text-sm leading-6 text-gray-700">{entry.answer.answer}</p>
+                  {!!entry.answer.evidence?.length && (
+                    <div className="mt-3 flex flex-wrap gap-2">
+                      {entry.answer.evidence.map((evidence) => (
+                        <button
+                          key={evidence.id}
+                          type="button"
+                          onClick={() => onEvidenceNavigate(evidence)}
+                          className="rounded-xl border border-cyan-100 bg-cyan-50 px-3 py-2 text-left text-xs font-bold text-cyan-900 hover:border-cyan-300"
+                        >
+                          <span className="block">
+                            {formatStudentQuestionEvidenceLabel(evidence)}
+                          </span>
+                          {evidence.actual !== null && evidence.actual !== undefined && (
+                            <span className="mt-1 block max-w-64 truncate font-mono text-[10px] font-normal text-cyan-700">
+                              {String(evidence.actual)}
+                            </span>
+                          )}
+                        </button>
+                      ))}
+                    </div>
+                  )}
+                </article>
+              );
+            })}
+          </div>
+        </div>
+      </div>
+    </section>
+  );
+}
diff --git a/frontend/src/components/student/StudentMappingTable.jsx b/frontend/src/components/student/StudentMappingTable.jsx
new file mode 100755
index 0000000..3c7c8b9
--- /dev/null
+++ b/frontend/src/components/student/StudentMappingTable.jsx
@@ -0,0 +1,365 @@
+import { useEffect, useMemo, useRef, useState } from "react";
+import { AlertTriangle, Columns3, Grid3X3, Search } from "lucide-react";
+import {
+  buildStudentMappingRows,
+  findStudentExplanation,
+  getNextStudentTabId,
+} from "../../utils/studentAssistant";
+
+const MODE_LABELS = {
+  mapping: "Cột nguồn",
+  default: "Mặc định",
+  formula: "Công thức",
+  mixed: "Nhiều nguồn",
+  unresolved: "Chưa ghép",
+};
+
+const MODE_TONES = {
+  mapping: "bg-emerald-50 text-emerald-700",
+  default: "bg-blue-50 text-blue-700",
+  formula: "bg-cyan-50 text-cyan-700",
+  mixed: "bg-rose-50 text-rose-700",
+  unresolved: "bg-amber-50 text-amber-700",
+};
+const STUDENT_TABS = [
+  ["mapping", "Mapping", Columns3],
+  ["preview", "Xem trước", Grid3X3],
+  ["issues", "Lỗi và cảnh báo", AlertTriangle],
+];
+const STUDENT_TAB_IDS = STUDENT_TABS.map(([id]) => id);
+
+export default function StudentMappingTable({
+  analysis,
+  selectedId,
+  onSelectExplanation,
+  evidenceNavigation,
+}) {
+  const [view, setView] = useState("mapping");
+  const [query, setQuery] = useState("");
+  const tabRefs = useRef({});
+  const mappingRows = useMemo(() => buildStudentMappingRows(analysis), [analysis]);
+  const explanations = analysis?.explanations || [];
+  const normalizedQuery = query.trim().toLocaleLowerCase("vi");
+  const visibleMappings = mappingRows.filter((item) => {
+    if (!normalizedQuery) return true;
+    return [item.target, ...item.sources, item.defaultValue, item.formula]
+      .filter(Boolean)
+      .some((value) => String(value).toLocaleLowerCase("vi").includes(normalizedQuery));
+  });
+
+  useEffect(() => {
+    if (!evidenceNavigation) return;
+    setView(evidenceNavigation.view || "mapping");
+    if (evidenceNavigation.view === "mapping" && evidenceNavigation.sourceField) {
+      setQuery(evidenceNavigation.sourceField);
+    }
+  }, [evidenceNavigation]);
+
+  const selectTarget = (target, options) => {
+    const explanation = findStudentExplanation(explanations, target, options);
+    if (explanation) onSelectExplanation(explanation);
+  };
+
+  const handleTabKeyDown = (event, currentId) => {
+    const nextId = getNextStudentTabId(STUDENT_TAB_IDS, currentId, event.key);
+    if (nextId === currentId && !["Home", "End"].includes(event.key)) return;
+    event.preventDefault();
+    setView(nextId);
+    requestAnimationFrame(() => tabRefs.current[nextId]?.focus());
+  };
+
+  return (
+    <section className="min-w-0 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card">
+      <div className="border-b border-slate-100 px-4 pt-4 sm:px-5">
+        <div className="flex flex-wrap items-center justify-between gap-3">
+          <div>
+            <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary-600">
+              Mapping và dữ liệu
+            </p>
+            <h2 className="mt-1 text-xl font-black text-gray-950">
+              Chọn một mục để xem bằng chứng
+            </h2>
+          </div>
+          <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-gray-600">
+            {analysis?.mapping_suggestion?.source || "heuristic"}
+          </div>
+        </div>
+        <div
+          className="mt-4 flex gap-1 overflow-x-auto"
+          role="tablist"
+          aria-label="Dữ liệu phiên học"
+          aria-orientation="horizontal"
+        >
+          {STUDENT_TABS.map(([id, label, Icon]) => (
+            <button
+              key={id}
+              ref={(node) => {
+                if (node) tabRefs.current[id] = node;
+                else delete tabRefs.current[id];
+              }}
+              type="button"
+              role="tab"
+              id={`student-tab-${id}`}
+              aria-controls={`student-panel-${id}`}
+              aria-selected={view === id}
+              tabIndex={view === id ? 0 : -1}
+              onClick={() => setView(id)}
+              onKeyDown={(event) => handleTabKeyDown(event, id)}
+              className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-bold transition-colors ${
+                view === id
+                  ? "border-primary-600 text-primary-700"
+                  : "border-transparent text-gray-500 hover:text-gray-800"
+              }`}
+            >
+              <Icon size={16} /> {label}
+            </button>
+          ))}
+        </div>
+      </div>
+
+      {evidenceNavigation && (
+        <div className="border-b border-cyan-100 bg-cyan-50 px-4 py-3 text-xs font-bold text-cyan-900 sm:px-5">
+          Evidence: dòng nguồn {evidenceNavigation.sourceRow || "-"} · trường {" "}
+          {evidenceNavigation.sourceField || "-"}
+          {evidenceNavigation.targetField
+            ? ` → ${evidenceNavigation.targetField}`
+            : ""}
+          {!evidenceNavigation.visibleInPreview && evidenceNavigation.sourceRow
+            ? " · dòng chính xác được tải trong bảng Source row bên dưới"
+            : ""}
+        </div>
+      )}
+
+      {view === "mapping" && (
+        <div
+          id="student-panel-mapping"
+          role="tabpanel"
+          aria-labelledby="student-tab-mapping"
+          tabIndex={0}
+        >
+          <div className="border-b border-slate-100 p-4 sm:px-5">
+            <label className="relative block">
+              <Search
+                size={17}
+                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
+              />
+              <span className="sr-only">Tìm trường mapping</span>
+              <input
+                type="search"
+                value={query}
+                onChange={(event) => setQuery(event.target.value)}
+                placeholder="Tìm trường đích hoặc cột nguồn"
+                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary-400 focus:bg-white"
+              />
+            </label>
+          </div>
+          <div className="max-h-[610px] divide-y divide-slate-100 overflow-y-auto">
+            {visibleMappings.map((item) => {
+              const explanation = findStudentExplanation(
+                explanations,
+                item.target,
+                {
+                  preferredKinds:
+                    item.mode === "formula"
+                      ? ["calculation", "field"]
+                      : ["mapping", "field"],
+                },
+              );
+              const selected = explanation?.id === selectedId;
+              const detail =
+                item.mode === "formula"
+                  ? item.formula
+                  : item.mode === "default"
+                    ? String(item.defaultValue)
+                    : item.sources.join(", ") || "Chưa có nguồn";
+              return (
+                <button
+                  key={item.target}
+                  type="button"
+                  onClick={() =>
+                    selectTarget(
+                      item.target,
+                      {
+                        preferredKinds:
+                          item.mode === "formula"
+                            ? ["calculation", "field"]
+                            : ["mapping", "field"],
+                      },
+                    )
+                  }
+                  className={`grid w-full gap-2 px-4 py-3 text-left transition-colors sm:grid-cols-[minmax(0,1fr)_160px] sm:px-5 ${
+                    evidenceNavigation?.targetField === item.target ||
+                    item.sources.includes(evidenceNavigation?.sourceField)
+                      ? "bg-cyan-50 ring-1 ring-inset ring-cyan-200"
+                      : selected
+                        ? "bg-primary-50"
+                        : "hover:bg-slate-50"
+                  }`}
+                  aria-pressed={selected}
+                >
+                  <span className="min-w-0">
+                    <span className="flex flex-wrap items-center gap-2">
+                      <span className="font-bold text-gray-900">{item.target}</span>
+                      {item.required && (
+                        <span className="text-[10px] font-black uppercase text-red-600">
+                          Bắt buộc
+                        </span>
+                      )}
+                    </span>
+                    <span className="mt-1 block truncate text-xs text-gray-500" title={detail}>
+                      {detail}
+                    </span>
+                  </span>
+                  <span
+                    className={`w-fit rounded-full px-2.5 py-1 text-[11px] font-bold ${MODE_TONES[item.mode]}`}
+                  >
+                    {MODE_LABELS[item.mode]}
+                  </span>
+                </button>
+              );
+            })}
+            {!visibleMappings.length && (
+              <p className="p-8 text-center text-sm text-gray-500">
+                Không có trường phù hợp bộ lọc.
+              </p>
+            )}
+          </div>
+        </div>
+      )}
+
+      {view === "preview" && (
+        <div
+          id="student-panel-preview"
+          className="table-scroll max-h-[610px] overflow-auto"
+          role="tabpanel"
+          aria-labelledby="student-tab-preview"
+          tabIndex={0}
+        >
+          <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
+            <thead className="sticky top-0 z-10 bg-slate-50">
+              <tr>
+                <th className="border-b border-slate-200 px-3 py-3 font-black text-gray-500">
+                  #
+                </th>
+                {(analysis?.student_preview?.headers || []).map((header) => (
+                  <th
+                    key={header}
+                    className="min-w-36 border-b border-slate-200 px-3 py-3 font-black text-gray-700"
+                  >
+                    {header}
+                  </th>
+                ))}
+              </tr>
+            </thead>
+            <tbody>
+              {(analysis?.student_preview?.rows || []).map((row, rowIndex) => (
+                <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/50">
+                  <td className="border-b border-slate-100 px-3 py-2 font-bold text-gray-400">
+                    {rowIndex + 1}
+                  </td>
+                  {(analysis?.student_preview?.headers || []).map((header) => (
+                    <td
+                      key={header}
+                      className={`border-b border-slate-100 p-1.5 ${
+                        evidenceNavigation?.visibleInPreview &&
+                        evidenceNavigation.previewRow === rowIndex + 1 &&
+                        evidenceNavigation.targetField === header
+                          ? "bg-cyan-100 ring-2 ring-inset ring-cyan-400"
+                          : ""
+                      }`}
+                    >
+                      <button
+                        type="button"
+                        onClick={() =>
+                          selectTarget(header, {
+                            preferredKinds: [
+                              "issue",
+                              "normalization",
+                              "mapping",
+                              "field",
+                            ],
+                            previewRow: rowIndex + 1,
+                            sourceRow:
+                              Number(analysis?.detected?.header_row || 1) + rowIndex + 1,
+                          })
+                        }
+                        className="block w-full rounded-lg px-2 py-1.5 text-left text-gray-700 hover:bg-primary-50 hover:text-primary-800"
+                      >
+                        {row[header] === null || row[header] === undefined || row[header] === ""
+                          ? "—"
+                          : String(row[header])}
+                      </button>
+                    </td>
+                  ))}
+                </tr>
+              ))}
+            </tbody>
+          </table>
+          {analysis?.student_preview?.truncated && (
+            <p className="border-t border-slate-100 p-3 text-center text-xs text-gray-500">
+              Chỉ hiển thị 25 dòng đầu; summary và readiness vẫn chạy trên toàn bộ file.
+            </p>
+          )}
+        </div>
+      )}
+
+      {view === "issues" && (
+        <div
+          id="student-panel-issues"
+          className="max-h-[610px] divide-y divide-slate-100 overflow-y-auto"
+          role="tabpanel"
+          aria-labelledby="student-tab-issues"
+          tabIndex={0}
+        >
+          {(analysis?.readiness?.issues || []).map((issue, index) => {
+            const explanation = findStudentExplanation(
+              explanations,
+              issue.field || null,
+              {
+                preferredKinds: ["issue"],
+                issueCode: issue.code,
+                issueRow: issue.row || null,
+              },
+            );
+            return (
+              <button
+                key={`${issue.code}-${issue.row || "all"}-${index}`}
+                type="button"
+                onClick={() => explanation && onSelectExplanation(explanation)}
+                className={`w-full px-4 py-4 text-left transition-colors hover:bg-slate-50 sm:px-5 ${
+                  explanation?.id === selectedId ? "bg-primary-50" : ""
+                }`}
+              >
+                <div className="flex flex-wrap items-center gap-2">
+                  <span
+                    className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
+                      issue.severity === "blocker"
+                        ? "bg-red-100 text-red-700"
+                        : "bg-amber-100 text-amber-700"
+                    }`}
+                  >
+                    {issue.severity}
+                  </span>
+                  <span className="text-xs font-bold text-gray-500">
+                    {issue.field || issue.category} {issue.row ? `· dòng ${issue.row}` : ""}
+                  </span>
+                </div>
+                <p className="mt-2 text-sm font-semibold leading-6 text-gray-800">
+                  {issue.message}
+                </p>
+              </button>
+            );
+          })}
+          {!analysis?.readiness?.issues?.length && (
+            <div className="p-10 text-center">
+              <p className="font-bold text-emerald-700">Không có lỗi readiness.</p>
+              <p className="mt-1 text-sm text-gray-500">
+                Vẫn cần đối chiếu nghiệp vụ trước khi dùng dữ liệu.
+              </p>
+            </div>
+          )}
+        </div>
+      )}
+    </section>
+  );
+}
diff --git a/frontend/src/components/student/SourceRowPanel.jsx b/frontend/src/components/student/SourceRowPanel.jsx
new file mode 100755
index 0000000..449a52a
--- /dev/null
+++ b/frontend/src/components/student/SourceRowPanel.jsx
@@ -0,0 +1,78 @@
+import { AlertTriangle, Loader2, TableProperties, X } from "lucide-react";
+import { buildStudentSourceRowItems } from "../../utils/studentAssistant";
+
+export default function SourceRowPanel({ state, onClose }) {
+  if (!state || state.status === "idle") return null;
+  const items = buildStudentSourceRowItems(state.data, state.selectedField);
+
+  return (
+    <section
+      className="overflow-hidden rounded-3xl border border-cyan-200 bg-white shadow-card xl:col-span-3"
+      aria-label="Dòng nguồn được chọn"
+    >
+      <div className="flex items-start justify-between gap-4 border-b border-cyan-100 bg-cyan-50 px-5 py-4">
+        <div className="flex min-w-0 items-start gap-3">
+          <span className="rounded-2xl bg-white p-2.5 text-cyan-700 shadow-sm">
+            <TableProperties size={20} />
+          </span>
+          <div className="min-w-0">
+            <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-700">
+              Exact source row
+            </p>
+            <h2 className="mt-1 text-lg font-black text-gray-950">
+              {state.data
+                ? `${state.data.sheet || "Sheet"} · dòng ${state.data.worksheet_row}`
+                : `Dòng ${state.worksheetRow || "-"}`}
+            </h2>
+            <p className="mt-1 text-xs text-cyan-900/70">
+              Trường evidence: {state.selectedField || "-"}
+            </p>
+          </div>
+        </div>
+        <button
+          type="button"
+          onClick={onClose}
+          aria-label="Đóng dòng nguồn"
+          className="rounded-full p-2 text-cyan-800 hover:bg-cyan-100"
+        >
+          <X size={18} />
+        </button>
+      </div>
+
+      {state.status === "loading" && (
+        <div className="flex items-center justify-center gap-2 p-8 text-sm font-bold text-cyan-800">
+          <Loader2 className="animate-spin" size={18} /> Đang tải đúng dòng nguồn…
+        </div>
+      )}
+      {state.status === "error" && (
+        <div className="flex items-center gap-2 p-5 text-sm font-bold text-red-700">
+          <AlertTriangle size={18} /> {state.error}
+        </div>
+      )}
+      {state.status === "ready" && (
+        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
+          {items.map((item) => (
+            <div
+              key={item.field}
+              className={`min-w-0 rounded-2xl border p-3 ${
+                item.selected
+                  ? "border-cyan-400 bg-cyan-50 ring-2 ring-cyan-200"
+                  : "border-slate-200 bg-slate-50"
+              }`}
+              aria-current={item.selected ? "true" : undefined}
+            >
+              <p className="truncate text-[11px] font-black uppercase tracking-wide text-gray-500">
+                {item.field}
+              </p>
+              <p className="mt-1 break-words font-mono text-xs text-gray-900">
+                {item.value === null || item.value === undefined || item.value === ""
+                  ? "—"
+                  : String(item.value)}
+              </p>
+            </div>
+          ))}
+        </div>
+      )}
+    </section>
+  );
+}
diff --git a/frontend/src/hooks/useStudentAssistantApi.js b/frontend/src/hooks/useStudentAssistantApi.js
new file mode 100755
index 0000000..e748ee2
--- /dev/null
+++ b/frontend/src/hooks/useStudentAssistantApi.js
@@ -0,0 +1,135 @@
+import { useCallback } from "react";
+import api from "../services/api";
+
+const viteEnv = import.meta.env || {};
+const pythonBaseURL = viteEnv.VITE_PYTHON_API_URL
+  ? `${viteEnv.VITE_PYTHON_API_URL}`.replace(/\/+$/, "")
+  : "/python-api";
+
+export const studentAssistantEnabled =
+  String(viteEnv.VITE_STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() ===
+    "true" &&
+  String(viteEnv.VITE_STUDENT_FILE_EXPLAIN_ENABLED || "false").toLowerCase() ===
+    "true";
+export const studentFileQaEnabled =
+  studentAssistantEnabled &&
+  String(viteEnv.VITE_STUDENT_FILE_QA_ENABLED || "false").toLowerCase() === "true";
+
+export const STUDENT_TEMPLATE_OPTIONS = [
+  { id: "bsn_sales", label: "BSN - Bán hàng" },
+  { id: "bsn_purchase", label: "BSN - Mua hàng" },
+  { id: "misa_purchase_domestic", label: "MISA - Mua hàng trong nước" },
+  { id: "sales_goods", label: "Bán hàng hóa" },
+  { id: "sales_service", label: "Bán dịch vụ" },
+  { id: "purchase_goods", label: "Mua hàng hóa" },
+  { id: "purchase_service", label: "Mua dịch vụ" },
+];
+
+async function readJsonResponse(response, fallback) {
+  const payload = await response.json().catch(() => ({}));
+  if (!response.ok) {
+    const error = new Error(payload.detail || payload.message || fallback);
+    error.status = response.status;
+    error.payload = payload;
+    throw error;
+  }
+  return payload;
+}
+
+function extensionFromFile(file) {
+  const match = String(file?.name || "").match(/(\.[^.]+)$/);
+  return match ? match[1].toLowerCase() : "";
+}
+
+export async function fetchStudentAssistantStatus(fetchImpl = fetch) {
+  try {
+    const response = await fetchImpl(`${pythonBaseURL}/healthz`, {
+      cache: "no-store",
+    });
+    if (!response.ok) return { serviceOnline: false, aiStatus: null };
+    const payload = await response.json();
+    return {
+      serviceOnline: payload?.status === "ok",
+      aiStatus: payload?.ai || "disabled",
+      capabilityEnabled: Boolean(
+        payload?.capabilities?.studentAssistant &&
+          payload?.capabilities?.studentFileExplain,
+      ),
+      questionCapabilityEnabled: Boolean(payload?.capabilities?.studentFileQa),
+    };
+  } catch {
+    return { serviceOnline: false, aiStatus: null, capabilityEnabled: false };
+  }
+}
+
+export function useStudentAssistantApi() {
+  const createSession = useCallback(async (file, workspaceId = null) => {
+    try {
+      const response = await api.post("/student/sessions", {
+        workspaceId: workspaceId || undefined,
+        file: {
+          originalName: file.name,
+          sizeBytes: file.size,
+          extension: extensionFromFile(file),
+          contentHash: "",
+        },
+      });
+      return response.data;
+    } catch (error) {
+      const wrapped = new Error(
+        error.response?.data?.message || "Không thể tạo phiên giải thích file.",
+      );
+      wrapped.status = error.response?.status;
+      wrapped.payload = error.response?.data;
+      throw wrapped;
+    }
+  }, []);
+
+  const analyzeSession = useCallback(async (file, contextToken, targetTemplateId) => {
+    const formData = new FormData();
+    formData.append("file", file);
+    formData.append("context_token", contextToken);
+    if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
+    const response = await fetch(`${pythonBaseURL}/api/v1/student/sessions/analyze`, {
+      method: "POST",
+      body: formData,
+    });
+    return readJsonResponse(response, "Không thể phân tích file cho chế độ sinh viên.");
+  }, []);
+
+  const getOverview = useCallback(async (sessionId, contextToken) => {
+    const response = await fetch(
+      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/overview`,
+      { headers: { "X-Student-Context": contextToken }, cache: "no-store" },
+    );
+    return readJsonResponse(response, "Không thể tải lại phần giải thích file.");
+  }, []);
+
+  const askQuestion = useCallback(async (sessionId, contextToken, question) => {
+    const response = await fetch(
+      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/questions`,
+      {
+        method: "POST",
+        headers: {
+          "Content-Type": "application/json",
+          "X-Student-Context": contextToken,
+        },
+        body: JSON.stringify({ question }),
+      },
+    );
+    return readJsonResponse(response, "Không thể trả lời câu hỏi về file này.");
+  }, []);
+
+  const getSourceRow = useCallback(async (sessionId, contextToken, worksheetRow) => {
+    const response = await fetch(
+      `${pythonBaseURL}/api/v1/student/sessions/${encodeURIComponent(sessionId)}/source-rows/${encodeURIComponent(worksheetRow)}`,
+      {
+        headers: { "X-Student-Context": contextToken },
+        cache: "no-store",
+      },
+    );
+    return readJsonResponse(response, "Không thể tải dòng nguồn được chọn.");
+  }, []);
+
+  return { createSession, analyzeSession, getOverview, askQuestion, getSourceRow };
+}
diff --git a/frontend/src/pages/StudentAssistantPage.jsx b/frontend/src/pages/StudentAssistantPage.jsx
new file mode 100755
index 0000000..f0d7be3
--- /dev/null
+++ b/frontend/src/pages/StudentAssistantPage.jsx
@@ -0,0 +1,483 @@
+import { useEffect, useMemo, useRef, useState } from "react";
+import {
+  AlertTriangle,
+  BookOpenCheck,
+  FileQuestion,
+  FileSpreadsheet,
+  Loader2,
+  LockKeyhole,
+  UploadCloud,
+  WifiOff,
+} from "lucide-react";
+import Navbar from "../components/Navbar";
+import Footer from "../components/Footer";
+import ExplanationInspector from "../components/student/ExplanationInspector";
+import FileQuestionPanel from "../components/student/FileQuestionPanel";
+import StudentMappingTable from "../components/student/StudentMappingTable";
+import StudentSessionSummary from "../components/student/StudentSessionSummary";
+import SourceRowPanel from "../components/student/SourceRowPanel";
+import {
+  fetchStudentAssistantStatus,
+  studentFileQaEnabled,
+  STUDENT_TEMPLATE_OPTIONS,
+  useStudentAssistantApi,
+} from "../hooks/useStudentAssistantApi";
+import {
+  classifyStudentAssistantError,
+  clearStudentSessionResume,
+  findStudentExplanation,
+  keepCurrentExplanationSelection,
+  loadStudentSessionResume,
+  resolveStudentEvidenceNavigation,
+  saveStudentSessionResume,
+} from "../utils/studentAssistant";
+
+function StudentErrorState({ kind, message, onRetry }) {
+  const config = {
+    expired: {
+      icon: FileQuestion,
+      title: "Phiên giải thích đã hết hạn",
+      copy: "Tạo phiên mới và tải lại file để tiếp tục. File tạm đã được quản lý theo retention.",
+    },
+    permission: {
+      icon: LockKeyhole,
+      title: "Không có quyền mở phiên này",
+      copy: "Phiên và upload chỉ được mở bằng đúng tài khoản, owner scope và signed context.",
+    },
+    offline: {
+      icon: WifiOff,
+      title: "Converter đang ngoại tuyến",
+      copy: "Không thể phân tích file lúc này. Phiên Node và dữ liệu của người dùng khác không bị truy cập.",
+    },
+    request: {
+      icon: AlertTriangle,
+      title: "Chưa thể phân tích file",
+      copy: message || "Kiểm tra file và thử lại.",
+    },
+  }[kind || "request"];
+  const Icon = config.icon;
+  return (
+    <section className="rounded-3xl border border-amber-200 bg-white p-8 text-center shadow-card">
+      <Icon className="mx-auto text-amber-600" size={40} />
+      <h2 className="mt-4 text-xl font-black text-gray-950">{config.title}</h2>
+      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-600">
+        {message || config.copy}
+      </p>
+      <button type="button" onClick={onRetry} className="btn-primary mt-5">
+        Thử lại với file mới
+      </button>
+    </section>
+  );
+}
+
+export default function StudentAssistantPage() {
+  const inputRef = useRef(null);
+  const resumeAttemptedRef = useRef(false);
+  const { createSession, analyzeSession, getOverview, askQuestion, getSourceRow } =
+    useStudentAssistantApi();
+  const [serviceStatus, setServiceStatus] = useState({
+    loading: true,
+    serviceOnline: null,
+    aiStatus: null,
+    capabilityEnabled: null,
+    questionCapabilityEnabled: null,
+  });
+  const [file, setFile] = useState(null);
+  const [targetTemplateId, setTargetTemplateId] = useState("bsn_sales");
+  const [status, setStatus] = useState("empty");
+  const [error, setError] = useState(null);
+  const [session, setSession] = useState(null);
+  const [analysis, setAnalysis] = useState(null);
+  const [selectedExplanationId, setSelectedExplanationId] = useState(null);
+  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
+  const [questionHistory, setQuestionHistory] = useState([]);
+  const [questionLoading, setQuestionLoading] = useState(false);
+  const [questionError, setQuestionError] = useState(null);
+  const [lastQuestion, setLastQuestion] = useState("");
+  const [evidenceNavigation, setEvidenceNavigation] = useState(null);
+  const [sourceRowState, setSourceRowState] = useState({ status: "idle" });
+  const sourceRowRequestRef = useRef(0);
+
+  useEffect(() => {
+    let cancelled = false;
+    fetchStudentAssistantStatus().then((nextStatus) => {
+      if (!cancelled) setServiceStatus({ loading: false, ...nextStatus });
+    });
+    return () => {
+      cancelled = true;
+    };
+  }, []);
+
+  useEffect(() => {
+    if (resumeAttemptedRef.current) return undefined;
+    resumeAttemptedRef.current = true;
+    const resume = loadStudentSessionResume(sessionStorage);
+    if (!resume) return undefined;
+
+    let cancelled = false;
+    setSession(resume);
+    setStatus("loading");
+    getOverview(resume.session.id, resume.contextToken)
+      .then((overview) => {
+        if (cancelled) return;
+        setAnalysis(overview);
+        setStatus("ready");
+      })
+      .catch((requestError) => {
+        if (cancelled) return;
+        const kind = classifyStudentAssistantError(requestError);
+        if (kind === "expired" || kind === "permission") {
+          clearStudentSessionResume(sessionStorage);
+        }
+        setError({ kind, message: requestError.message });
+        setStatus("error");
+      });
+    return () => {
+      cancelled = true;
+    };
+  }, [getOverview]);
+
+  useEffect(() => {
+    if (!analysis) return;
+    setSelectedExplanationId((currentId) => {
+      const current = keepCurrentExplanationSelection(
+        currentId,
+        analysis.explanations,
+        analysis.student_state_hash,
+      );
+      if (current) return current;
+      return (
+        analysis.explanations.find((item) => item.severity === "blocker")?.id ||
+        analysis.explanations.find((item) => item.kind === "mapping")?.id ||
+        analysis.explanations[0]?.id ||
+        null
+      );
+    });
+  }, [analysis]);
+
+  const selectedExplanation = useMemo(
+    () =>
+      analysis?.explanations?.find((item) => item.id === selectedExplanationId) ||
+      null,
+    [analysis?.explanations, selectedExplanationId],
+  );
+
+  const reset = () => {
+    clearStudentSessionResume(sessionStorage);
+    setFile(null);
+    setStatus("empty");
+    setError(null);
+    setSession(null);
+    setAnalysis(null);
+    setSelectedExplanationId(null);
+    setMobileInspectorOpen(false);
+    setQuestionHistory([]);
+    setQuestionLoading(false);
+    setQuestionError(null);
+    setLastQuestion("");
+    setEvidenceNavigation(null);
+    setSourceRowState({ status: "idle" });
+    if (inputRef.current) inputRef.current.value = "";
+  };
+
+  const acceptFile = (nextFile) => {
+    if (!nextFile) return;
+    if (!/\.xlsx?$/i.test(nextFile.name)) {
+      setError({ kind: "request", message: "Chỉ hỗ trợ file .xls hoặc .xlsx." });
+      setStatus("error");
+      return;
+    }
+    setFile(nextFile);
+    setError(null);
+    setStatus("empty");
+  };
+
+  const handleAnalyze = async () => {
+    if (!file) {
+      inputRef.current?.click();
+      return;
+    }
+    if (serviceStatus.serviceOnline === false || serviceStatus.capabilityEnabled === false) {
+      setError({ kind: "offline", message: "Converter Student chưa sẵn sàng." });
+      setStatus("error");
+      return;
+    }
+    setStatus("loading");
+    setError(null);
+    try {
+      const created = await createSession(file);
+      setSession(created);
+      saveStudentSessionResume(sessionStorage, created);
+      const analyzed = await analyzeSession(
+        file,
+        created.contextToken,
+        targetTemplateId,
+      );
+      setAnalysis(analyzed);
+      setStatus("ready");
+    } catch (requestError) {
+      const kind = classifyStudentAssistantError(requestError);
+      if (kind === "expired" || kind === "permission") {
+        clearStudentSessionResume(sessionStorage);
+      }
+      setError({
+        kind,
+        message: requestError.message,
+      });
+      setStatus("error");
+    }
+  };
+
+  const handleSelectExplanation = (explanation) => {
+    setSelectedExplanationId(explanation.id);
+    setMobileInspectorOpen(true);
+  };
+
+  const handleAskQuestion = async (question) => {
+    const sessionId = session?.session?.id;
+    const contextToken = session?.contextToken;
+    if (!sessionId || !contextToken) return;
+    setQuestionLoading(true);
+    setQuestionError(null);
+    setLastQuestion(question);
+    try {
+      const answer = await askQuestion(sessionId, contextToken, question);
+      setQuestionHistory((history) => [...history, { question, answer }]);
+    } catch (requestError) {
+      setQuestionError(requestError.message);
+    } finally {
+      setQuestionLoading(false);
+    }
+  };
+
+  const handleEvidenceNavigate = async (evidence) => {
+    const navigation = resolveStudentEvidenceNavigation(evidence, analysis);
+    setEvidenceNavigation({ ...navigation, key: evidence.id });
+    if (navigation.targetField) {
+      const explanation = findStudentExplanation(
+        analysis?.explanations || [],
+        navigation.targetField,
+        {
+          preferredKinds: ["issue", "normalization", "mapping", "field"],
+          sourceRow: navigation.sourceRow,
+          previewRow: navigation.previewRow,
+          issueCode: evidence.issue_code || null,
+        },
+      );
+      if (explanation) handleSelectExplanation(explanation);
+    }
+    if (!navigation.requiresSourceRowFetch) return;
+    const sessionId = session?.session?.id;
+    const contextToken = session?.contextToken;
+    if (!sessionId || !contextToken) return;
+    const requestId = sourceRowRequestRef.current + 1;
+    sourceRowRequestRef.current = requestId;
+    setSourceRowState({
+      status: "loading",
+      worksheetRow: navigation.sourceRow,
+      selectedField: navigation.sourceField,
+    });
+    try {
+      const data = await getSourceRow(
+        sessionId,
+        contextToken,
+        navigation.sourceRow,
+      );
+      if (sourceRowRequestRef.current !== requestId) return;
+      setSourceRowState({
+        status: "ready",
+        data,
+        selectedField: navigation.sourceField,
+      });
+    } catch (requestError) {
+      if (sourceRowRequestRef.current !== requestId) return;
+      setSourceRowState({
+        status: "error",
+        worksheetRow: navigation.sourceRow,
+        selectedField: navigation.sourceField,
+        error: requestError.message,
+      });
+    }
+  };
+
+  return (
+    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-blue-50/50">
+      <Navbar />
+      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8">
+        <header className="flex flex-col gap-5 border-b border-slate-200 pb-7 lg:flex-row lg:items-end lg:justify-between">
+          <div className="max-w-3xl">
+            <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-sm font-bold text-blue-800">
+              <BookOpenCheck size={16} /> Phase 1 · Explain My File
+            </span>
+            <h1 className="mt-4 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
+              Hiểu file kế toán từ chính dữ liệu nguồn
+            </h1>
+            <p className="mt-3 text-base leading-7 text-gray-600">
+              Xem file thuộc mẫu nào, cột nguồn đi vào trường nào, quy tắc nào tạo lỗi
+              và bằng chứng nằm ở đâu. Chế độ này vẫn đầy đủ khi AI ngoại tuyến.
+            </p>
+          </div>
+          <div className="flex flex-wrap gap-2 text-xs font-bold">
+            <span
+              className={`rounded-full px-3 py-1.5 ${
+                serviceStatus.serviceOnline
+                  ? "bg-emerald-100 text-emerald-800"
+                  : serviceStatus.loading
+                    ? "bg-slate-100 text-slate-600"
+                    : "bg-red-100 text-red-800"
+              }`}
+            >
+              Converter: {serviceStatus.loading ? "đang kiểm tra" : serviceStatus.serviceOnline ? "online" : "offline"}
+            </span>
+            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">
+              AI: {serviceStatus.aiStatus || "không bắt buộc"}
+            </span>
+          </div>
+        </header>
+
+        {status !== "ready" && (
+          <div className="mx-auto mt-8 max-w-4xl">
+            {status === "error" ? (
+              <StudentErrorState kind={error?.kind} message={error?.message} onRetry={reset} />
+            ) : (
+              <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-card">
+                <div className="grid lg:grid-cols-[1.05fr_0.95fr]">
+                  <div className="p-6 sm:p-9">
+                    <p className="text-xs font-black uppercase tracking-[0.15em] text-primary-600">
+                      Bắt đầu một phiên mới
+                    </p>
+                    <h2 className="mt-2 text-2xl font-black text-gray-950">
+                      Tải file bán hàng hoặc mua hàng
+                    </h2>
+                    <p className="mt-2 text-sm leading-6 text-gray-500">
+                      Node tạo signed session trước; trình duyệt sau đó upload trực tiếp
+                      sang converter bằng context của đúng owner.
+                    </p>
+
+                    <label className="mt-6 block text-sm font-bold text-gray-800">
+                      Mẫu đích
+                      <select
+                        value={targetTemplateId}
+                        onChange={(event) => setTargetTemplateId(event.target.value)}
+                        disabled={status === "loading"}
+                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-primary-500"
+                      >
+                        {STUDENT_TEMPLATE_OPTIONS.map((option) => (
+                          <option key={option.id} value={option.id}>
+                            {option.label}
+                          </option>
+                        ))}
+                      </select>
+                    </label>
+
+                    <input
+                      ref={inputRef}
+                      type="file"
+                      accept=".xls,.xlsx"
+                      className="sr-only"
+                      onChange={(event) => acceptFile(event.target.files?.[0])}
+                    />
+                    <button
+                      type="button"
+                      onClick={() => inputRef.current?.click()}
+                      disabled={status === "loading"}
+                      className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-left hover:border-primary-400 hover:bg-primary-50"
+                    >
+                      <span className="rounded-xl bg-white p-2.5 text-primary-600 shadow-sm">
+                        <UploadCloud size={22} />
+                      </span>
+                      <span className="min-w-0">
+                        <span className="block truncate text-sm font-black text-gray-900">
+                          {file?.name || "Chọn file Excel"}
+                        </span>
+                        <span className="mt-0.5 block text-xs text-gray-500">
+                          .xls hoặc .xlsx
+                        </span>
+                      </span>
+                    </button>
+
+                    <button
+                      type="button"
+                      onClick={handleAnalyze}
+                      disabled={status === "loading" || serviceStatus.loading}
+                      className="btn-primary mt-4 w-full py-3"
+                    >
+                      {status === "loading" ? (
+                        <Loader2 size={18} className="animate-spin" />
+                      ) : (
+                        <FileSpreadsheet size={18} />
+                      )}
+                      {status === "loading" ? "Đang phân tích và dựng bằng chứng…" : "Giải thích file này"}
+                    </button>
+                  </div>
+
+                  <div className="relative overflow-hidden bg-slate-950 p-6 text-white sm:p-9">
+                    <div className="absolute -right-20 -top-16 h-56 w-56 rounded-full bg-blue-500/20 blur-3xl" />
+                    <div className="relative">
+                      <p className="text-xs font-black uppercase tracking-[0.15em] text-blue-300">
+                        Kết quả nhận được
+                      </p>
+                      <div className="mt-5 space-y-4">
+                        {[
+                          "Tóm tắt cấu trúc file và mẫu đích",
+                          "Mapping, mặc định và công thức đang dùng",
+                          "Readiness blocker/warning từ pipeline hiện có",
+                          "Inspector dẫn về dòng, cột hoặc rule source",
+                        ].map((item, index) => (
+                          <div key={item} className="flex gap-3">
+                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black text-blue-200">
+                              {index + 1}
+                            </span>
+                            <p className="text-sm leading-6 text-slate-200">{item}</p>
+                          </div>
+                        ))}
+                      </div>
+                      <p className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-5 text-slate-300">
+                        Không kết luận “đúng luật 100%” hoặc tự chọn tài khoản/thuế suất khi
+                        file không có căn cứ.
+                      </p>
+                    </div>
+                  </div>
+                </div>
+              </section>
+            )}
+          </div>
+        )}
+
+        {status === "ready" && analysis && (
+          <div className="mt-7 grid items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
+            <StudentSessionSummary analysis={analysis} session={session} onReset={reset} />
+            <StudentMappingTable
+              analysis={analysis}
+              selectedId={selectedExplanationId}
+              onSelectExplanation={handleSelectExplanation}
+              evidenceNavigation={evidenceNavigation}
+            />
+            <ExplanationInspector
+              explanation={selectedExplanation}
+              mobileOpen={mobileInspectorOpen}
+              onMobileOpenChange={setMobileInspectorOpen}
+            />
+            {studentFileQaEnabled && serviceStatus.questionCapabilityEnabled && (
+              <FileQuestionPanel
+                targetTemplateId={analysis.target_template_id}
+                aiStatus={serviceStatus.aiStatus}
+                history={questionHistory}
+                loading={questionLoading}
+                error={questionError}
+                onAsk={handleAskQuestion}
+                onRetry={() => lastQuestion && handleAskQuestion(lastQuestion)}
+                onEvidenceNavigate={handleEvidenceNavigate}
+              />
+            )}
+            <SourceRowPanel
+              state={sourceRowState}
+              onClose={() => setSourceRowState({ status: "idle" })}
+            />
+          </div>
+        )}
+      </main>
+      <Footer />
+    </div>
+  );
+}
diff --git a/frontend/src/utils/studentAssistant.js b/frontend/src/utils/studentAssistant.js
new file mode 100755
index 0000000..eb35e96
--- /dev/null
+++ b/frontend/src/utils/studentAssistant.js
@@ -0,0 +1,363 @@
+const MASTER_DATA_LABELS = {
+  connected: "Đã kết nối",
+  unavailable: "Tạm thời gián đoạn",
+  not_configured: "Chưa cấu hình",
+};
+export const STUDENT_RESUME_STORAGE_KEY = "ezformat.student.resume.v1";
+const UNSAFE_RESUME_KEYS = new Set([
+  "rawrows",
+  "rows",
+  "rawbytes",
+  "workbook",
+  "workbookbytes",
+  "analysis",
+  "preview",
+  "student_preview",
+]);
+
+function formatCount(value, fallback = "0") {
+  const number = Number(value);
+  return Number.isFinite(number) && number >= 0
+    ? new Intl.NumberFormat("vi-VN").format(number)
+    : fallback;
+}
+
+export function getStudentSummaryItems(summary = {}) {
+  const issues = summary.issue_counts || {};
+  return [
+    { key: "rows", label: "Dòng dữ liệu", value: formatCount(summary.data_row_count) },
+    {
+      key: "documents",
+      label: "Chứng từ ước tính",
+      value:
+        summary.document_count === null || summary.document_count === undefined
+          ? "Chưa đủ dữ liệu"
+          : formatCount(summary.document_count),
+    },
+    {
+      key: "recognized",
+      label: "Cột đã nhận diện",
+      value: formatCount(summary.recognized_columns),
+    },
+    {
+      key: "unresolved",
+      label: "Cột chưa nhận diện",
+      value: formatCount(summary.unresolved_columns),
+    },
+    {
+      key: "blockers",
+      label: "Lỗi chắc chắn",
+      value: formatCount(issues.blocker),
+    },
+    {
+      key: "warnings",
+      label: "Cảnh báo rà soát",
+      value: formatCount(issues.warning),
+    },
+    {
+      key: "master-data",
+      label: "Đối chiếu danh mục",
+      value:
+        MASTER_DATA_LABELS[summary.master_data_status] ||
+        summary.master_data_status ||
+        "Chưa cấu hình",
+    },
+  ];
+}
+
+export function formatStudentEvidenceLabel(evidence = {}) {
+  if (evidence.kind === "source_cell") {
+    return [
+      evidence.sheet || "Sheet",
+      evidence.row ? `dòng ${evidence.row}` : null,
+      evidence.column ? `cột ${evidence.column}` : null,
+    ]
+      .filter(Boolean)
+      .join(" · ");
+  }
+  if (evidence.kind === "source_column") {
+    return [evidence.sheet || "Sheet", evidence.column ? `cột ${evidence.column}` : null]
+      .filter(Boolean)
+      .join(" · ");
+  }
+  if (evidence.kind === "rule") {
+    return `Quy tắc ${evidence.rule_id || evidence.source_ref || "nội bộ"}`;
+  }
+  if (evidence.kind === "template") {
+    const parts = String(evidence.source_ref || "").split(":");
+    if (parts[0] === "template" && parts.length >= 3) {
+      return `Mẫu ${parts[1]} · ${parts.slice(2).join(":")}`;
+    }
+    return `Mẫu ${evidence.source_ref || "đích"}`;
+  }
+  return evidence.source_ref || "Bằng chứng";
+}
+
+export function formatStudentQuestionEvidenceLabel(evidence = {}) {
+  return [
+    evidence.sheet || "Sheet",
+    evidence.row ? `dòng ${evidence.row}` : null,
+    evidence.field ? `trường ${evidence.field}` : null,
+  ]
+    .filter(Boolean)
+    .join(" · ");
+}
+
+export function getStudentQuestionAnswerState(answer = {}) {
+  if (answer.outcome === "supported") {
+    return { kind: "supported", label: "Đã kiểm chứng từ file" };
+  }
+  if (
+    answer.outcome === "ai_unavailable" ||
+    answer.unsupported_reason === "ai_unavailable"
+  ) {
+    return { kind: "ai_unavailable", label: "AI bổ sung không khả dụng" };
+  }
+  return { kind: "unsupported", label: "Chưa đủ căn cứ deterministic" };
+}
+
+export function getStudentQuestionSuggestions(targetTemplateId = "") {
+  const isPurchase = String(targetTemplateId).includes("purchase");
+  return [
+    isPurchase ? "File mua có bao nhiêu hóa đơn?" : "Có bao nhiêu hóa đơn?",
+    "Cần sửa gì trước khi export?",
+    "Dòng nào lệch tiền thuế GTGT?",
+    isPurchase ? "Tổng thành tiền mua hàng là bao nhiêu?" : "Tổng thành tiền là bao nhiêu?",
+    isPurchase ? "Hóa đơn mua nào bị trùng?" : "Có hóa đơn trùng không?",
+    isPurchase ? "Mã hàng dùng để làm gì?" : "Thành tiền có ý nghĩa gì?",
+  ];
+}
+
+export function resolveStudentEvidenceNavigation(evidence = {}, analysis = {}) {
+  const sourceRow = Number(evidence.row || 0) || null;
+  const sourceField = evidence.field || null;
+  const mapping = analysis.mapping_suggestion?.mapping || {};
+  const mappedTarget = mapping[sourceField];
+  const targetField =
+    evidence.target_field ||
+    (Array.isArray(mappedTarget) ? mappedTarget[0] : mappedTarget) ||
+    null;
+  const headerRow = Number(analysis.detected?.header_row || 1);
+  const previewRow = sourceRow ? sourceRow - headerRow : null;
+  const previewRows = analysis.student_preview?.rows || [];
+  const previewHeaders = analysis.student_preview?.headers || [];
+  const visibleInPreview = Boolean(
+    previewRow &&
+      previewRow >= 1 &&
+      previewRow <= previewRows.length &&
+      targetField &&
+      previewHeaders.includes(targetField),
+  );
+  return {
+    sourceRow,
+    sourceField,
+    targetField,
+    previewRow,
+    view: visibleInPreview ? "preview" : "mapping",
+    visibleInPreview,
+    requiresSourceRowFetch: Boolean(sourceRow && sourceField),
+  };
+}
+
+export function buildStudentSourceRowItems(sourceRow = {}, selectedField = null) {
+  return (sourceRow.fields || []).map((item) => ({
+    field: item.field,
+    value: item.value,
+    selected: item.field === selectedField,
+  }));
+}
+
+export function studentSourceRowResponseMatchesContext(
+  response = {},
+  context = {},
+  responseEpoch,
+) {
+  return Boolean(
+    responseEpoch === context.requestEpoch &&
+      response.session_id === context.sessionId &&
+      response.upload_id === context.uploadId &&
+      response.state_hash === context.stateHash,
+  );
+}
+
+export function keepCurrentExplanationSelection(
+  selectedId,
+  explanations = [],
+  currentStateHash = "",
+) {
+  if (!selectedId) return null;
+  const selected = explanations.find((item) => item?.id === selectedId);
+  if (!selected || selected.stale) return null;
+  return selected.state_hash === currentStateHash ? selectedId : null;
+}
+
+export function buildStudentMappingRows(analysis = {}) {
+  const suggestion = analysis.mapping_suggestion || {};
+  const mapping = suggestion.mapping || {};
+  const defaults = suggestion.defaults || {};
+  const formulas = suggestion.formulas || {};
+  const targetToSources = {};
+  for (const [source, targetSpec] of Object.entries(mapping)) {
+    const targets = Array.isArray(targetSpec) ? targetSpec : [targetSpec];
+    for (const target of targets) {
+      if (!target) continue;
+      if (!targetToSources[target]) targetToSources[target] = [];
+      targetToSources[target].push(source);
+    }
+  }
+
+  return (analysis.target_headers || []).map((target) => {
+    const sources = targetToSources[target] || [];
+    const activeModes = [];
+    if (sources.length) activeModes.push("mapping");
+    if (defaults[target] !== undefined && defaults[target] !== "") activeModes.push("default");
+    if (formulas[target]) activeModes.push("formula");
+    return {
+      target,
+      sources,
+      defaultValue: defaults[target],
+      formula: formulas[target],
+      required: String(target).includes("(*)"),
+      mode:
+        activeModes.length === 0
+          ? "unresolved"
+          : activeModes.length > 1
+            ? "mixed"
+            : activeModes[0],
+      activeModes,
+    };
+  });
+}
+
+export function findStudentExplanation(
+  explanations = [],
+  targetField,
+  options = {},
+) {
+  const normalizedOptions = Array.isArray(options)
+    ? { preferredKinds: options }
+    : options || {};
+  const {
+    preferredKinds = [],
+    previewRow = null,
+    sourceRow = null,
+    issueCode = null,
+    issueRow = null,
+  } = normalizedOptions;
+  const matches = explanations.filter((item) => item?.target_field === targetField);
+  const exactMatches = matches.filter((item) => {
+    if (issueCode) {
+      const ruleMatches =
+        item.issue_code === issueCode ||
+        (item.evidence || []).some(
+          (evidence) => evidence.kind === "rule" && evidence.rule_id === issueCode,
+        );
+      if (!ruleMatches) return false;
+    }
+    if (issueRow && item.issue_row !== issueRow) return false;
+    if (previewRow || sourceRow) {
+      const rowMatches =
+        item.preview_row === previewRow ||
+        (item.evidence || []).some(
+          (evidence) => evidence.kind === "source_cell" && evidence.row === sourceRow,
+        );
+      if (!rowMatches) return false;
+    }
+    return !item.stale;
+  });
+
+  for (const kind of preferredKinds) {
+    const preferred = exactMatches.find((item) => item.kind === kind);
+    if (preferred) return preferred;
+  }
+  if (exactMatches.length) return exactMatches[0];
+  if (issueCode || issueRow) return null;
+
+  const fallbackMatches = matches.filter(
+    (item) => !item.stale && !item.preview_row && !item.issue_row,
+  );
+  for (const kind of preferredKinds) {
+    const preferred = fallbackMatches.find((item) => item.kind === kind);
+    if (preferred) return preferred;
+  }
+  return fallbackMatches[0] || null;
+}
+
+export function classifyStudentAssistantError(error) {
+  const status = Number(error?.status || error?.response?.status || 0);
+  if (status === 410) return "expired";
+  if (status === 401 || status === 403) return "permission";
+  if (!status || error?.name === "TypeError") return "offline";
+  return "request";
+}
+
+export function getNextStudentTabId(tabIds = [], currentId, key) {
+  if (!tabIds.length) return currentId;
+  const currentIndex = Math.max(0, tabIds.indexOf(currentId));
+  if (key === "Home") return tabIds[0];
+  if (key === "End") return tabIds[tabIds.length - 1];
+  if (key === "ArrowRight") return tabIds[(currentIndex + 1) % tabIds.length];
+  if (key === "ArrowLeft") {
+    return tabIds[(currentIndex - 1 + tabIds.length) % tabIds.length];
+  }
+  return currentId;
+}
+
+export function saveStudentSessionResume(storage, value = {}) {
+  const targetStorage = storage || globalThis.sessionStorage;
+  if (!targetStorage) return false;
+  const session = sanitizeResumeValue(value.session);
+  const contextToken = String(value.contextToken || "").trim();
+  if (!session?.id || !contextToken) return false;
+  try {
+    targetStorage.setItem(
+      STUDENT_RESUME_STORAGE_KEY,
+      JSON.stringify({ session, contextToken }),
+    );
+    return true;
+  } catch {
+    return false;
+  }
+}
+
+export function loadStudentSessionResume(storage) {
+  const targetStorage = storage || globalThis.sessionStorage;
+  if (!targetStorage) return null;
+  try {
+    const raw = targetStorage.getItem(STUDENT_RESUME_STORAGE_KEY);
+    if (!raw) return null;
+    const parsed = JSON.parse(raw);
+    if (!parsed?.session?.id || !String(parsed.contextToken || "").trim()) {
+      targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
+      return null;
+    }
+    return {
+      session: sanitizeResumeValue(parsed.session),
+      contextToken: String(parsed.contextToken),
+    };
+  } catch {
+    targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
+    return null;
+  }
+}
+
+export function clearStudentSessionResume(storage) {
+  const targetStorage = storage || globalThis.sessionStorage;
+  if (!targetStorage) return;
+  try {
+    targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
+  } catch {
+    // Storage may be disabled by the browser; in-memory state still resets.
+  }
+}
+
+function sanitizeResumeValue(value) {
+  if (value === null || value === undefined) return value;
+  if (Array.isArray(value)) return value.map(sanitizeResumeValue);
+  if (typeof value !== "object") return value;
+  return Object.fromEntries(
+    Object.entries(value)
+      .filter(([key]) => !UNSAFE_RESUME_KEYS.has(key.toLowerCase()))
+      .map(([key, item]) => [key, sanitizeResumeValue(item)]),
+  );
+}
diff --git a/frontend/src/utils/studentAssistant.test.mjs b/frontend/src/utils/studentAssistant.test.mjs
new file mode 100755
index 0000000..02b6bb2
--- /dev/null
+++ b/frontend/src/utils/studentAssistant.test.mjs
@@ -0,0 +1,367 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+import {
+  buildStudentSourceRowItems,
+  formatStudentQuestionEvidenceLabel,
+  formatStudentEvidenceLabel,
+  findStudentExplanation,
+  getStudentQuestionAnswerState,
+  getStudentQuestionSuggestions,
+  getStudentSummaryItems,
+  getNextStudentTabId,
+  keepCurrentExplanationSelection,
+  resolveStudentEvidenceNavigation,
+  studentSourceRowResponseMatchesContext,
+  clearStudentSessionResume,
+  loadStudentSessionResume,
+  saveStudentSessionResume,
+} from "./studentAssistant.js";
+
+test("student summary labels expose the deterministic file overview", () => {
+  const items = getStudentSummaryItems({
+    data_row_count: 1930,
+    document_count: 420,
+    recognized_columns: 8,
+    unresolved_columns: 2,
+    issue_counts: { blocker: 3, warning: 5, info: 1 },
+    master_data_status: "connected",
+  });
+
+  assert.deepEqual(
+    items.map((item) => [item.label, item.value]),
+    [
+      ["Dòng dữ liệu", "1.930"],
+      ["Chứng từ ước tính", "420"],
+      ["Cột đã nhận diện", "8"],
+      ["Cột chưa nhận diện", "2"],
+      ["Lỗi chắc chắn", "3"],
+      ["Cảnh báo rà soát", "5"],
+      ["Đối chiếu danh mục", "Đã kết nối"],
+    ],
+  );
+});
+
+test("student evidence labels distinguish source cells, columns, rules and templates", () => {
+  assert.equal(
+    formatStudentEvidenceLabel({
+      kind: "source_cell",
+      sheet: "Data",
+      row: 25,
+      column: "Thời gian",
+    }),
+    "Data · dòng 25 · cột Thời gian",
+  );
+  assert.equal(
+    formatStudentEvidenceLabel({
+      kind: "source_column",
+      sheet: "Data",
+      column: "Mã hàng",
+    }),
+    "Data · cột Mã hàng",
+  );
+  assert.equal(
+    formatStudentEvidenceLabel({ kind: "rule", rule_id: "required_value_blank" }),
+    "Quy tắc required_value_blank",
+  );
+  assert.equal(
+    formatStudentEvidenceLabel({
+      kind: "template",
+      source_ref: "template:bsn_sales:Ngày hạch toán (*)",
+    }),
+    "Mẫu bsn_sales · Ngày hạch toán (*)",
+  );
+});
+
+test("stale explanation selection is cleared when the state hash changes", () => {
+  const explanations = [
+    { id: "current", state_hash: "state-2", stale: false },
+    { id: "stale-flag", state_hash: "state-2", stale: true },
+    { id: "old", state_hash: "state-1", stale: false },
+  ];
+
+  assert.equal(
+    keepCurrentExplanationSelection("current", explanations, "state-2"),
+    "current",
+  );
+  assert.equal(
+    keepCurrentExplanationSelection("stale-flag", explanations, "state-2"),
+    null,
+  );
+  assert.equal(keepCurrentExplanationSelection("old", explanations, "state-2"), null);
+  assert.equal(
+    keepCurrentExplanationSelection("missing", explanations, "state-2"),
+    null,
+  );
+});
+
+test("preview selection keeps row index and chooses matching source-row evidence", () => {
+  const explanations = [
+    {
+      id: "row-1",
+      kind: "normalization",
+      target_field: "Ngày hạch toán (*)",
+      preview_row: 1,
+      evidence: [{ kind: "source_cell", row: 2, column: "Thời gian" }],
+    },
+    {
+      id: "row-2",
+      kind: "normalization",
+      target_field: "Ngày hạch toán (*)",
+      preview_row: 2,
+      evidence: [{ kind: "source_cell", row: 3, column: "Thời gian" }],
+    },
+  ];
+
+  assert.equal(
+    findStudentExplanation(explanations, "Ngày hạch toán (*)", {
+      preferredKinds: ["normalization"],
+      previewRow: 2,
+      sourceRow: 3,
+    })?.id,
+    "row-2",
+  );
+});
+
+test("issue selection matches repeated code by exact field and issue row", () => {
+  const explanations = [
+    {
+      id: "issue-row-1",
+      kind: "issue",
+      target_field: "Thành tiền",
+      issue_code: "line_amount_mismatch",
+      issue_row: 1,
+      evidence: [{ kind: "rule", rule_id: "line_amount_mismatch" }],
+    },
+    {
+      id: "issue-row-2",
+      kind: "issue",
+      target_field: "Thành tiền",
+      issue_code: "line_amount_mismatch",
+      issue_row: 2,
+      evidence: [{ kind: "rule", rule_id: "line_amount_mismatch" }],
+    },
+  ];
+
+  assert.equal(
+    findStudentExplanation(explanations, "Thành tiền", {
+      preferredKinds: ["issue"],
+      issueCode: "line_amount_mismatch",
+      issueRow: 2,
+    })?.id,
+    "issue-row-2",
+  );
+});
+
+test("session resume storage persists only session metadata and context token", () => {
+  const values = new Map();
+  const storage = {
+    getItem: (key) => values.get(key) || null,
+    setItem: (key, value) => values.set(key, value),
+    removeItem: (key) => values.delete(key),
+  };
+  const resume = {
+    session: {
+      id: "session-1",
+      status: "analyzed",
+      file: { originalName: "sales.xlsx", rawRetained: false },
+    },
+    contextToken: "signed-token",
+    analysis: { student_preview: { rows: [{ confidential: true }] } },
+    file: { rawBytes: "secret" },
+  };
+
+  saveStudentSessionResume(storage, resume);
+
+  assert.deepEqual(loadStudentSessionResume(storage), {
+    session: resume.session,
+    contextToken: "signed-token",
+  });
+  const serialized = [...values.values()][0];
+  assert.equal(serialized.includes("student_preview"), false);
+  assert.equal(serialized.includes("confidential"), false);
+  assert.equal(serialized.includes("rawBytes"), false);
+
+  clearStudentSessionResume(storage);
+  assert.equal(loadStudentSessionResume(storage), null);
+});
+
+test("invalid session resume data is cleared", () => {
+  const values = new Map([["ezformat.student.resume.v1", '{"session":{},"contextToken":""}']]);
+  const storage = {
+    getItem: (key) => values.get(key) || null,
+    setItem: (key, value) => values.set(key, value),
+    removeItem: (key) => values.delete(key),
+  };
+
+  assert.equal(loadStudentSessionResume(storage), null);
+  assert.equal(values.size, 0);
+});
+
+test("student tabs support roving arrow, Home and End navigation", () => {
+  const tabs = ["mapping", "preview", "issues"];
+
+  assert.equal(getNextStudentTabId(tabs, "mapping", "ArrowRight"), "preview");
+  assert.equal(getNextStudentTabId(tabs, "issues", "ArrowRight"), "mapping");
+  assert.equal(getNextStudentTabId(tabs, "mapping", "ArrowLeft"), "issues");
+  assert.equal(getNextStudentTabId(tabs, "preview", "Home"), "mapping");
+  assert.equal(getNextStudentTabId(tabs, "preview", "End"), "issues");
+  assert.equal(getNextStudentTabId(tabs, "preview", "Enter"), "preview");
+});
+
+test("question answer labels distinguish supported, unsupported and AI unavailable", () => {
+  assert.deepEqual(getStudentQuestionAnswerState({ outcome: "supported" }), {
+    kind: "supported",
+    label: "Đã kiểm chứng từ file",
+  });
+  assert.deepEqual(
+    getStudentQuestionAnswerState({
+      outcome: "unsupported",
+      unsupported_reason: "unsupported_legal_or_business_judgment",
+    }),
+    { kind: "unsupported", label: "Chưa đủ căn cứ deterministic" },
+  );
+  assert.deepEqual(
+    getStudentQuestionAnswerState({
+      outcome: "ai_unavailable",
+      unsupported_reason: "ai_unavailable",
+    }),
+    { kind: "ai_unavailable", label: "AI bổ sung không khả dụng" },
+  );
+});
+
+test("question evidence labels and navigation preserve exact source row and field", () => {
+  const evidence = {
+    kind: "source_cell",
+    sheet: "Data",
+    row: 25,
+    field: "Thời gian",
+    target_field: "Ngày chứng từ (*)",
+    actual: "25/12/2025",
+  };
+  const analysis = {
+    detected: { header_row: 3 },
+    mapping_suggestion: {
+      mapping: { "Thời gian": "Ngày chứng từ (*)" },
+    },
+    student_preview: {
+      headers: ["Ngày chứng từ (*)"],
+      rows: Array.from({ length: 25 }, () => ({})),
+    },
+  };
+
+  assert.equal(
+    formatStudentQuestionEvidenceLabel(evidence),
+    "Data · dòng 25 · trường Thời gian",
+  );
+  assert.deepEqual(resolveStudentEvidenceNavigation(evidence, analysis), {
+    sourceRow: 25,
+    sourceField: "Thời gian",
+    targetField: "Ngày chứng từ (*)",
+    previewRow: 22,
+    view: "preview",
+    visibleInPreview: true,
+    requiresSourceRowFetch: true,
+  });
+});
+
+test("outside-preview evidence requires exact source-row fetch instead of field fallback", () => {
+  const navigation = resolveStudentEvidenceNavigation(
+    {
+      sheet: "Data",
+      row: 80,
+      field: "Mã hóa đơn",
+      target_field: "Số chứng từ (*)",
+    },
+    {
+      detected: { header_row: 1 },
+      student_preview: {
+        headers: ["Số chứng từ (*)"],
+        rows: Array.from({ length: 25 }, () => ({})),
+      },
+      mapping_suggestion: { mapping: { "Mã hóa đơn": "Số chứng từ (*)" } },
+    },
+  );
+
+  assert.deepEqual(navigation, {
+    sourceRow: 80,
+    sourceField: "Mã hóa đơn",
+    targetField: "Số chứng từ (*)",
+    previewRow: 79,
+    view: "mapping",
+    visibleInPreview: false,
+    requiresSourceRowFetch: true,
+  });
+});
+
+test("source-row panel items select the exact evidence field", () => {
+  assert.deepEqual(
+    buildStudentSourceRowItems(
+      {
+        worksheet_row: 80,
+        fields: [
+          { field: "Mã hóa đơn", value: "HD080" },
+          { field: "Thành tiền", value: 125000 },
+        ],
+      },
+      "Thành tiền",
+    ),
+    [
+      { field: "Mã hóa đơn", value: "HD080", selected: false },
+      { field: "Thành tiền", value: 125000, selected: true },
+    ],
+  );
+});
+
+test("late or cross-session source-row responses cannot update the current panel", () => {
+  const context = {
+    sessionId: "session-2",
+    uploadId: "upload-2",
+    stateHash: "state-2",
+    requestEpoch: 7,
+  };
+  const valid = {
+    session_id: "session-2",
+    upload_id: "upload-2",
+    state_hash: "state-2",
+  };
+
+  assert.equal(
+    studentSourceRowResponseMatchesContext(valid, context, 7),
+    true,
+  );
+  assert.equal(
+    studentSourceRowResponseMatchesContext(valid, context, 6),
+    false,
+  );
+  assert.equal(
+    studentSourceRowResponseMatchesContext(
+      { ...valid, session_id: "session-1" },
+      context,
+      7,
+    ),
+    false,
+  );
+  assert.equal(
+    studentSourceRowResponseMatchesContext(
+      { ...valid, upload_id: "upload-1" },
+      context,
+      7,
+    ),
+    false,
+  );
+  assert.equal(
+    studentSourceRowResponseMatchesContext(
+      { ...valid, state_hash: "state-1" },
+      context,
+      7,
+    ),
+    false,
+  );
+});
+
+test("question suggestions stay bounded and deterministic", () => {
+  const suggestions = getStudentQuestionSuggestions("bsn_purchase");
+  assert.ok(suggestions.length >= 4);
+  assert.ok(suggestions.length <= 6);
+  assert.ok(suggestions.every((item) => typeof item === "string" && item.length > 0));
+});
