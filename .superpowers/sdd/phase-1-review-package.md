# Phase 1 review package - final
diff --git a/backend/routes/internal.js b/backend/routes/internal.js
index 19ce72b..6e15488 100644
--- a/backend/routes/internal.js
+++ b/backend/routes/internal.js
@@ -14,6 +14,9 @@ const {
   findInternalReconstructionProfile,
   recordInternalReconstructionEvent,
 } = require("../controllers/reconstructionController");
+const {
+  recordStudentAnalysisCompleted,
+} = require("../controllers/studentSessionController");
 router.get("/master-data/context/:snapshotSetHash", (req, res, next) => {
   Promise.resolve(getInternalMasterDataContext(req, res, next)).catch(next);
 });
@@ -47,5 +50,8 @@ router.post("/reconstructions/:id/events", (req, res, next) => {
     next,
   );
 });
+router.post("/student/sessions/:id/events", (req, res, next) => {
+  Promise.resolve(recordStudentAnalysisCompleted(req, res, next)).catch(next);
+});
 
 module.exports = router;
diff --git a/converter/app/main.py b/converter/app/main.py
index d51c5d4..a28520a 100644
--- a/converter/app/main.py
+++ b/converter/app/main.py
@@ -56,15 +56,48 @@ from app.reconstruction_workflow import (
     update_reconstruction_draft,
     validate_reconstruction,
 )
+from app.student_store import cleanup_expired_student_uploads
+from app.student_workflow import (
+    StudentWorkflowError,
+    analyze_student_file,
+    get_student_overview,
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
@@ -156,7 +189,15 @@ def healthz() -> dict[str, object]:
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
         },
     }
 
@@ -208,6 +249,7 @@ async def analyze_raw_upload(
     file: Annotated[UploadFile, File()],
     target_template_id: Annotated[str | None, Form()] = None,
     conversion_context_token: Annotated[str | None, Form()] = None,
+    student_context_token: Annotated[str | None, Form()] = None,
 ) -> JSONResponse:
     try:
         content = await file.read()
@@ -217,12 +259,48 @@ async def analyze_raw_upload(
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
 @app.post("/api/v1/reconstructions/analyze")
 async def analyze_voucher_reconstruction(
     file: Annotated[UploadFile, File()],
@@ -474,6 +552,7 @@ async def preview_misa_mapping(body: dict) -> JSONResponse:
             defaults=body.get("defaults") or {},
             formulas=body.get("formulas") or {},
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -495,6 +574,7 @@ async def readiness_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             edited_rows=edited_rows if isinstance(edited_rows, list) else None,
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -515,6 +595,7 @@ async def confirm_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             profile_name=body.get("profile_name"),
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -579,6 +660,7 @@ async def export_conversion_rows(body: dict) -> Response:
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
diff --git a/frontend/src/App.jsx b/frontend/src/App.jsx
index 2f9b012..5cd426b 100644
--- a/frontend/src/App.jsx
+++ b/frontend/src/App.jsx
@@ -16,6 +16,7 @@ import ContactPage from "./pages/ContactPage";
 import PaymentPage from "./pages/PaymentPage";
 import PaymentResultPage from "./pages/PaymentResultPage";
 import AccountingWorkspacePage from "./pages/AccountingWorkspacePage";
+import { studentAssistantEnabled } from "./hooks/useStudentAssistantApi";
 
 const AdminDashboard = lazy(() => import("./pages/admin/DashboardPage"));
 const UsersPage = lazy(() => import("./pages/admin/UsersPage"));
@@ -23,6 +24,7 @@ const FilesPage = lazy(() => import("./pages/admin/FilesPage"));
 const PlansPage = lazy(() => import("./pages/admin/PlansPage"));
 const RevenuePage = lazy(() => import("./pages/admin/RevenuePage"));
 const LogsPage = lazy(() => import("./pages/admin/LogsPage"));
+const StudentAssistantPage = lazy(() => import("./pages/StudentAssistantPage"));
 
 function PageLoader() {
   return (
@@ -54,6 +56,20 @@ function App() {
               </ProtectedRoute>
             }
           />
+          <Route
+            path="/student"
+            element={
+              studentAssistantEnabled ? (
+                <ProtectedRoute>
+                  <Suspense fallback={<PageLoader />}>
+                    <StudentAssistantPage />
+                  </Suspense>
+                </ProtectedRoute>
+              ) : (
+                <Navigate to="/" replace />
+              )
+            }
+          />
           <Route path="/login" element={<LoginPage />} />
           <Route path="/register" element={<RegisterPage />} />
           <Route path="/forgot-password" element={<ForgotPasswordPage />} />
diff --git a/frontend/src/components/Navbar.jsx b/frontend/src/components/Navbar.jsx
index cfd0af1..7919b71 100644
--- a/frontend/src/components/Navbar.jsx
+++ b/frontend/src/components/Navbar.jsx
@@ -6,6 +6,7 @@ import ezFormatLogo from "../assets/ezformat-logo-64.webp";
 import UserPlanBadge from "./UserPlanBadge";
 import FeedbackModal from "./FeedbackModal";
 import ChangePasswordModal from "./ChangePasswordModal";
+import { studentAssistantEnabled } from "../hooks/useStudentAssistantApi";
 
 const workspacesEnabled =
   String(
@@ -126,6 +127,11 @@ const Navbar = () => {
             <NavLink to="/convert" className={navLinkClass}>
               Chuyển đổi
             </NavLink>
+            {studentAssistantEnabled && (
+              <NavLink to="/student" className={navLinkClass}>
+                Sinh viên
+              </NavLink>
+            )}
             <NavLink to="/pricing" className={navLinkClass}>
               Bảng giá
             </NavLink>
@@ -242,6 +248,11 @@ const Navbar = () => {
           <NavLink to="/convert" className={navLinkClass} onClick={closeMobile}>
             Chuyển đổi
           </NavLink>
+          {studentAssistantEnabled && (
+            <NavLink to="/student" className={navLinkClass} onClick={closeMobile}>
+              Sinh viên
+            </NavLink>
+          )}
           <NavLink to="/pricing" className={navLinkClass} onClick={closeMobile}>
             Bảng giá
           </NavLink>
diff --git a/backend/controllers/studentSessionController.js b/backend/controllers/studentSessionController.js
new file mode 100755
index 0000000..b887841
--- /dev/null
+++ b/backend/controllers/studentSessionController.js
@@ -0,0 +1,468 @@
+const crypto = require("crypto");
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
+module.exports = {
+  cleanAnalysisCompletedPayload,
+  cleanStudentSessionPayload,
+  createContextToken,
+  createStudentSession,
+  deleteStudentSession,
+  getStudentSession,
+  recordStudentAnalysisCompleted,
+  refreshStudentContext,
+  serializeStudentSession,
+  sessionIsExpired,
+  sessionIsOwnedByUser,
+  studentContextMatchesSession,
+  studentContextScopesFromFlags,
+};
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
index 0000000..c6df55e
--- /dev/null
+++ b/backend/tests/studentSessions.test.js
@@ -0,0 +1,653 @@
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
+  cleanAnalysisCompletedPayload,
+  cleanStudentSessionPayload,
+  createContextToken,
+  getStudentSession,
+  recordStudentAnalysisCompleted,
+  sessionIsExpired,
+  serializeStudentSession,
+  sessionIsOwnedByUser,
+  studentContextMatchesSession,
+  studentContextScopesFromFlags,
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
+test("student context requires a numeric future exp claim", () => {
+  const noExpiry = jwt.sign(
+    {
+      purpose: "student_file_session",
+      session_id: "session-1",
+      user_id: "user-1",
+      owner_scope: "user:user-1",
+      allowed_scopes: ["analyze"],
+    },
+    process.env.CONVERSION_CONTEXT_SECRET,
+    { algorithm: "HS256", noTimestamp: true },
+  );
+
+  assert.throws(
+    () => verifyStudentContextToken(noExpiry, "analyze"),
+    /exp/i,
+  );
+});
+
+test("student context rejects scalar scopes", () => {
+  const token = jwt.sign(
+    {
+      purpose: "student_file_session",
+      session_id: "session-1",
+      user_id: "user-1",
+      owner_scope: "user:user-1",
+      allowed_scopes: "analyze",
+    },
+    process.env.CONVERSION_CONTEXT_SECRET,
+    { algorithm: "HS256", expiresIn: "10m" },
+  );
+
+  assert.throws(
+    () => verifyStudentContextToken(token, "analyze"),
+    /scopes/i,
+  );
+});
+
+test("student context rejects non-HS256 tokens", () => {
+  const token = jwt.sign(
+    {
+      purpose: "student_file_session",
+      session_id: "session-1",
+      user_id: "user-1",
+      owner_scope: "user:user-1",
+      allowed_scopes: ["analyze"],
+    },
+    process.env.CONVERSION_CONTEXT_SECRET,
+    { algorithm: "HS512", expiresIn: "10m" },
+  );
+
+  assert.throws(
+    () => verifyStudentContextToken(token, "analyze"),
+    /algorithm/i,
+  );
+});
+
+test("student context scopes are minted only from enabled phase flags", () => {
+  const flags = {
+    STUDENT_ASSISTANT_ENABLED: "true",
+    STUDENT_FILE_EXPLAIN_ENABLED: "true",
+    STUDENT_FILE_QA_ENABLED: "false",
+    STUDENT_CHECK_WORK_ENABLED: "false",
+    STUDENT_ACCOUNTING_MAP_ENABLED: "false",
+    STUDENT_RECONCILIATION_ENABLED: "false",
+    STUDENT_INTERNSHIP_ENABLED: "false",
+  };
+
+  assert.deepEqual(studentContextScopesFromFlags(flags), ["analyze", "explain"]);
+  assert.deepEqual(
+    studentContextScopesFromFlags({ ...flags, STUDENT_FILE_QA_ENABLED: "true" }),
+    ["analyze", "explain", "ask"],
+  );
+  assert.deepEqual(
+    studentContextScopesFromFlags({
+      ...flags,
+      STUDENT_FILE_QA_ENABLED: "true",
+      STUDENT_CHECK_WORK_ENABLED: "true",
+      STUDENT_ACCOUNTING_MAP_ENABLED: "true",
+      STUDENT_RECONCILIATION_ENABLED: "true",
+    }),
+    ["analyze", "explain", "ask", "attempt", "accounting_map", "reconcile"],
+  );
+  assert.deepEqual(
+    studentContextScopesFromFlags({ ...flags, STUDENT_INTERNSHIP_ENABLED: "true" }),
+    ["analyze", "explain", "export"],
+  );
+  assert.deepEqual(
+    studentContextScopesFromFlags({ ...flags, STUDENT_ASSISTANT_ENABLED: "false" }),
+    [],
+  );
+});
+
+test("Phase 1 context token cannot confirm or export", () => {
+  const flagNames = [
+    "STUDENT_ASSISTANT_ENABLED",
+    "STUDENT_FILE_EXPLAIN_ENABLED",
+    "STUDENT_FILE_QA_ENABLED",
+    "STUDENT_CHECK_WORK_ENABLED",
+    "STUDENT_ACCOUNTING_MAP_ENABLED",
+    "STUDENT_RECONCILIATION_ENABLED",
+    "STUDENT_INTERNSHIP_ENABLED",
+  ];
+  const previous = Object.fromEntries(flagNames.map((name) => [name, process.env[name]]));
+  Object.assign(process.env, {
+    STUDENT_ASSISTANT_ENABLED: "true",
+    STUDENT_FILE_EXPLAIN_ENABLED: "true",
+    STUDENT_FILE_QA_ENABLED: "false",
+    STUDENT_CHECK_WORK_ENABLED: "false",
+    STUDENT_ACCOUNTING_MAP_ENABLED: "false",
+    STUDENT_RECONCILIATION_ENABLED: "false",
+    STUDENT_INTERNSHIP_ENABLED: "false",
+  });
+  try {
+    const token = createContextToken({
+      _id: "session-1",
+      userId: "user-1",
+      ownerScope: "user:user-1",
+      workspaceId: null,
+    });
+    assert.deepEqual(verifyStudentContextToken(token, "analyze").allowed_scopes, [
+      "analyze",
+      "explain",
+    ]);
+    assert.throws(() => verifyStudentContextToken(token, "attempt"), /thiếu quyền attempt/i);
+    assert.throws(() => verifyStudentContextToken(token, "export"), /thiếu quyền export/i);
+  } finally {
+    for (const name of flagNames) {
+      if (previous[name] === undefined) delete process.env[name];
+      else process.env[name] = previous[name];
+    }
+  }
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
+
+test("analysis_completed payload keeps only safe converter metadata", () => {
+  assert.deepEqual(
+    cleanAnalysisCompletedPayload({
+      event: "analysis_completed",
+      converterUploadId: " upload-1 ",
+      targetTemplateId: " bsn_sales ",
+      sourceSignatureHash: " source-hash ",
+      status: "exported",
+      summary: {
+        dataRowCount: 2,
+        documentCount: 1,
+        recognizedColumns: 6,
+        unresolvedColumns: 0,
+        mappingCounts: { mapped: 6, default: 1, formula: 4, rawRows: 99 },
+        issueCounts: { blocker: 2, warning: 1, info: 0 },
+        masterDataStatus: "not_configured",
+        explanationCount: 77,
+        stateHash: " state-1 ",
+        rawRows: [{ customer: "confidential" }],
+        preview: { rows: [{ customer: "confidential" }] },
+      },
+      rows: [{ customer: "confidential" }],
+    }),
+    {
+      event: "analysis_completed",
+      converterUploadId: "upload-1",
+      targetTemplateId: "bsn_sales",
+      sourceSignatureHash: "source-hash",
+      summary: {
+        dataRowCount: 2,
+        documentCount: 1,
+        recognizedColumns: 6,
+        unresolvedColumns: 0,
+        mappingCounts: { mapped: 6, default: 1, formula: 4 },
+        issueCounts: { blocker: 2, warning: 1, info: 0 },
+        masterDataStatus: "not_configured",
+        explanationCount: 77,
+        stateHash: "state-1",
+      },
+      status: "analyzed",
+    },
+  );
+});
+
+test("internal analysis_completed uses an atomic conditional update and remains idempotent", async () => {
+  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
+  const session = {
+    _id: "507f1f77bcf86cd799439011",
+    userId: "507f1f77bcf86cd799439012",
+    workspaceId: null,
+    ownerScope: "user:507f1f77bcf86cd799439012",
+    status: "created",
+    retentionExpiresAt: new Date(Date.now() + 60_000),
+    file: { originalName: "sales.xlsx", sizeBytes: 100, rawRetained: false },
+  };
+  const token = createStudentContextToken({
+    sessionId: session._id,
+    userId: session.userId,
+    ownerScope: session.ownerScope,
+    allowedScopes: ["analyze", "explain"],
+  });
+  const originalFindOne = StudentFileSession.findOne;
+  const originalFindOneAndUpdate = StudentFileSession.findOneAndUpdate;
+  const updateCalls = [];
+  let fallbackReads = 0;
+  StudentFileSession.findOne = async () => {
+    fallbackReads += 1;
+    return session;
+  };
+  StudentFileSession.findOneAndUpdate = async (filter, update, options) => {
+    updateCalls.push({ filter, update, options });
+    const incomingUploadId = update.$set.converterUploadId;
+    if (session.converterUploadId && session.converterUploadId !== incomingUploadId) {
+      return null;
+    }
+    Object.assign(session, update.$set);
+    return session;
+  };
+
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
+  try {
+    await recordStudentAnalysisCompleted(
+      {
+        params: { id: session._id },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": token,
+        },
+        body: {
+          event: "analysis_completed",
+          converterUploadId: "upload-1",
+          targetTemplateId: "bsn_sales",
+          sourceSignatureHash: "source-hash",
+          summary: { dataRowCount: 2, rawRows: [{ secret: true }] },
+        },
+      },
+      response,
+    );
+    assert.equal(response.statusCode, 200);
+    assert.equal(session.status, "analyzed");
+    assert.equal(session.converterUploadId, "upload-1");
+    assert.equal(session.targetTemplateId, "bsn_sales");
+    assert.equal(session.sourceSignatureHash, "source-hash");
+    assert.deepEqual(session.summary, { dataRowCount: 2 });
+    assert.equal(fallbackReads, 0);
+    assert.deepEqual(updateCalls[0].filter.$or, [
+      { converterUploadId: "" },
+      { converterUploadId: "upload-1" },
+      { converterUploadId: { $exists: false } },
+      { converterUploadId: null },
+    ]);
+    assert.equal(updateCalls[0].filter.ownerScope, session.ownerScope);
+    assert.equal(updateCalls[0].filter.workspaceId, null);
+    assert.equal(updateCalls[0].options.new, true);
+    assert.equal(updateCalls[0].options.runValidators, true);
+
+    const idempotent = { ...response, statusCode: 200, body: null };
+    await recordStudentAnalysisCompleted(
+      {
+        params: { id: session._id },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": token,
+        },
+        body: {
+          event: "analysis_completed",
+          converterUploadId: "upload-1",
+          targetTemplateId: "bsn_sales",
+          sourceSignatureHash: "source-hash-refreshed",
+          summary: { dataRowCount: 2, explanationCount: 5 },
+        },
+      },
+      idempotent,
+    );
+    assert.equal(idempotent.statusCode, 200);
+    assert.equal(session.converterUploadId, "upload-1");
+    assert.equal(session.sourceSignatureHash, "source-hash-refreshed");
+    assert.equal(fallbackReads, 0);
+
+    const conflict = { ...response, statusCode: 200, body: null };
+    await recordStudentAnalysisCompleted(
+      {
+        params: { id: session._id },
+        headers: {
+          "x-converter-service-token": "converter-service-secret",
+          "x-student-context": token,
+        },
+        body: {
+          event: "analysis_completed",
+          converterUploadId: "upload-2",
+          targetTemplateId: "bsn_sales",
+          sourceSignatureHash: "source-hash-2",
+          summary: { dataRowCount: 3 },
+        },
+      },
+      conflict,
+    );
+    assert.equal(conflict.statusCode, 409);
+    assert.equal(session.converterUploadId, "upload-1");
+    assert.equal(session.sourceSignatureHash, "source-hash-refreshed");
+    assert.equal(fallbackReads, 1);
+  } finally {
+    StudentFileSession.findOne = originalFindOne;
+    StudentFileSession.findOneAndUpdate = originalFindOneAndUpdate;
+  }
+
+  const rejected = { ...response, statusCode: 200, body: null };
+  await recordStudentAnalysisCompleted(
+    {
+      params: { id: session._id },
+      headers: {
+        "x-converter-service-token": "wrong",
+        "x-student-context": token,
+      },
+      body: { event: "analysis_completed" },
+    },
+    rejected,
+  );
+  assert.equal(rejected.statusCode, 401);
+});
diff --git a/converter/app/student_models.py b/converter/app/student_models.py
new file mode 100755
index 0000000..fd3d9a0
--- /dev/null
+++ b/converter/app/student_models.py
@@ -0,0 +1,79 @@
+from __future__ import annotations
+
+from typing import Any, Literal
+
+from pydantic import BaseModel, Field, model_validator
+
+
+EvidenceKind = Literal["source_cell", "source_column", "rule", "template"]
+ExplanationKind = Literal[
+    "mapping",
+    "field",
+    "normalization",
+    "issue",
+    "calculation",
+    "master_data",
+    "unsupported",
+]
+ExplanationSeverity = Literal["blocker", "warning", "info", "none"]
+
+
+class StudentEvidence(BaseModel):
+    kind: EvidenceKind
+    source_ref: str = Field(min_length=1)
+    sheet: str | None = None
+    row: int | None = Field(default=None, ge=1)
+    column: str | None = None
+    raw_value: Any = None
+    rule_id: str | None = None
+    source_url: str | None = None
+    checked_at: str | None = None
+    effective_from: str | None = None
+    effective_to: str | None = None
+
+
+class StudentExplanation(BaseModel):
+    id: str = Field(min_length=1)
+    kind: ExplanationKind
+    severity: ExplanationSeverity = "none"
+    deterministic: bool = True
+    target_field: str | None = None
+    title: str = Field(min_length=1)
+    meaning_vi: str = Field(min_length=1)
+    reason_vi: str = Field(min_length=1)
+    impact_vi: str | None = None
+    fix_hint_vi: str = Field(min_length=1)
+    normalized_value: Any = None
+    evidence: list[StudentEvidence] = Field(default_factory=list)
+    claim_sources: list[str] = Field(default_factory=list)
+    preview_row: int | None = Field(default=None, ge=1)
+    issue_code: str | None = None
+    issue_row: int | None = Field(default=None, ge=1)
+    state_hash: str = ""
+    stale: bool = False
+
+    @model_validator(mode="after")
+    def deterministic_explanations_require_evidence(self) -> "StudentExplanation":
+        if self.deterministic and not self.evidence:
+            raise ValueError("Deterministic student explanation requires evidence")
+        return self
+
+
+class StudentFileSummary(BaseModel):
+    session_id: str = Field(min_length=1)
+    upload_id: str = Field(min_length=1)
+    file_name: str = ""
+    target_template_id: str = Field(min_length=1)
+    sheet_name: str = ""
+    header_row: int = Field(ge=1)
+    data_row_count: int = Field(ge=0)
+    document_count: int | None = Field(default=None, ge=0)
+    recognized_columns: int = Field(ge=0)
+    unresolved_columns: int = Field(ge=0)
+    mapping_counts: dict[str, int] = Field(default_factory=dict)
+    issue_counts: dict[str, int] = Field(default_factory=dict)
+    master_data_status: str = "not_configured"
+    reconcilable_totals: dict[str, Any] = Field(default_factory=dict)
+    explanation_count: int = Field(default=0, ge=0)
+    state_hash: str = ""
+    stale: bool = False
diff --git a/converter/app/student_field_dictionary.py b/converter/app/student_field_dictionary.py
new file mode 100755
index 0000000..518634d
--- /dev/null
+++ b/converter/app/student_field_dictionary.py
@@ -0,0 +1,319 @@
+from __future__ import annotations
+
+import re
+from copy import deepcopy
+from typing import Any
+
+from app.misa_templates import get_misa_template
+from app.normalization import normalize_header
+
+
+DICTIONARY_VERSION = "student-field-dictionary-v1"
+CHECKED_AT = "2026-07-17"
+MISA_IMPORT_SOURCE_URL = "https://helpact.misa.vn/kb/html_10050000/"
+
+
+def _definition(
+    title: str,
+    meaning_vi: str,
+    aliases: list[str],
+    mistakes: list[str],
+    fix_hint_vi: str,
+) -> dict[str, Any]:
+    return {
+        "title": title,
+        "meaning_vi": meaning_vi,
+        "aliases": aliases,
+        "common_mistakes": mistakes,
+        "fix_hint_vi": fix_hint_vi,
+    }
+
+
+CRITICAL_DEFINITIONS = {
+    "ngay_hach_toan": _definition(
+        "Ngày hạch toán",
+        "Ngày nghiệp vụ được ghi nhận vào sổ kế toán trong dữ liệu đích.",
+        ["ngày ghi sổ", "posting date", "ngayct"],
+        ["Nhầm với ngày hóa đơn", "Dùng giá trị không phải ngày"],
+        "Đối chiếu ngày ghi nhận nghiệp vụ với chứng từ nguồn và yêu cầu bài làm.",
+    ),
+    "ngay_chung_tu": _definition(
+        "Ngày chứng từ",
+        "Ngày được ghi trên chứng từ dùng làm căn cứ cho dòng dữ liệu.",
+        ["document date", "ngày phiếu", "ngayct"],
+        ["Nhầm với ngày hạch toán", "Mất phần ngày do định dạng Excel"],
+        "Chọn cột ngày chứng từ thực tế và kiểm tra định dạng ngày trước khi import.",
+    ),
+    "so_chung_tu": _definition(
+        "Số chứng từ",
+        "Mã nhận diện chứng từ, thường được dùng để theo dõi và nhóm các dòng cùng chứng từ.",
+        ["số phiếu", "document number", "soct", "mã hóa đơn"],
+        ["Mất số 0 ở đầu", "Dùng số hóa đơn thay cho số chứng từ nội bộ"],
+        "Giữ trường này ở dạng văn bản và đối chiếu khóa chứng từ trong file nguồn.",
+    ),
+    "so_phieu_nhap": _definition(
+        "Số phiếu nhập",
+        "Mã nhận diện phiếu nhập dùng để theo dõi các dòng của cùng nghiệp vụ mua hàng.",
+        ["số chứng từ", "receipt number", "soct"],
+        ["Mất số 0 ở đầu", "Trùng số nhưng khác ngày hoặc nhà cung cấp"],
+        "Giữ nguyên mã phiếu từ nguồn và kiểm tra các dòng cùng phiếu có thông tin nhất quán.",
+    ),
+    "ma_hang": _definition(
+        "Mã hàng",
+        "Mã định danh hàng hóa trong dòng nghiệp vụ và danh mục đích.",
+        ["mã vật tư", "item code", "sku", "mathang"],
+        ["Dùng tên hàng thay cho mã", "Mất số 0 ở đầu", "Mã chưa có trong danh mục"],
+        "Ưu tiên cột mã hàng; nếu nguồn chỉ có tên hàng thì cần rà soát lại danh mục trước import.",
+    ),
+    "ma_dich_vu": _definition(
+        "Mã dịch vụ",
+        "Mã định danh dịch vụ trong dòng nghiệp vụ và danh mục đích.",
+        ["service code", "mã nội dung dịch vụ"],
+        ["Dùng tên dịch vụ thay cho mã", "Mã chưa có trong danh mục"],
+        "Chọn cột mã dịch vụ và xác minh mã tồn tại trong danh mục sử dụng.",
+    ),
+    "tk_tien_chi_phi_no": _definition(
+        "Tài khoản Nợ",
+        "Tài khoản nhận giá trị bên Nợ cho dòng bán hàng theo cấu hình của chứng từ.",
+        ["tài khoản nợ", "debit account", "tk nợ"],
+        ["Nhập tên tài khoản thay vì mã", "Tự suy đoán tài khoản khi thiếu căn cứ"],
+        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp; không tự suy đoán.",
+    ),
+    "tk_doanh_thu_co": _definition(
+        "Tài khoản doanh thu/Có",
+        "Tài khoản nhận giá trị bên Có cho doanh thu của dòng bán hàng.",
+        ["tài khoản có", "revenue account", "tk doanh thu"],
+        ["Nhập tên tài khoản thay vì mã", "Dùng một tài khoản cho mọi loại nghiệp vụ"],
+        "Đối chiếu mã tài khoản với nội dung nghiệp vụ và yêu cầu bài làm trước import.",
+    ),
+    "tk_kho_tk_chi_phi": _definition(
+        "Tài khoản kho/chi phí",
+        "Tài khoản ghi nhận giá trị hàng mua vào kho hoặc chi phí của dòng mua hàng.",
+        ["tài khoản nợ", "inventory account", "expense account", "tk kho"],
+        ["Không phân biệt hàng hóa và dịch vụ", "Tự suy đoán tài khoản từ tên hàng"],
+        "Rà soát loại nghiệp vụ và mã tài khoản được yêu cầu; giữ trạng thái cần xem xét khi thiếu căn cứ.",
+    ),
+    "tk_cong_no_tk_tien": _definition(
+        "Tài khoản công nợ/tiền",
+        "Tài khoản đối ứng phản ánh công nợ nhà cung cấp hoặc khoản tiền đã thanh toán.",
+        ["tài khoản có", "payable account", "cash account", "tk công nợ"],
+        ["Không khớp phương thức thanh toán", "Tự suy đoán tài khoản từ tên nhà cung cấp"],
+        "Đối chiếu phương thức thanh toán và yêu cầu bài làm trước khi chọn mã tài khoản.",
+    ),
+    "so_hoa_don": _definition(
+        "Số hóa đơn",
+        "Số nhận diện hóa đơn được ghi trong dữ liệu nguồn.",
+        ["invoice number", "so_hd", "số HĐ"],
+        ["Mất số 0 ở đầu", "Nhầm với số chứng từ nội bộ"],
+        "Giữ dạng văn bản và đối chiếu trực tiếp với hóa đơn hoặc file nguồn.",
+    ),
+    "ngay_hoa_don": _definition(
+        "Ngày hóa đơn",
+        "Ngày được ghi trên hóa đơn liên quan đến nghiệp vụ.",
+        ["invoice date", "ngay_hd"],
+        ["Nhầm với ngày hạch toán", "Định dạng ngày không đọc được"],
+        "Đối chiếu ngày trên hóa đơn và giữ riêng với ngày hạch toán khi hai ngày khác nhau.",
+    ),
+    "ma_so_thue": _definition(
+        "Mã số thuế",
+        "Mã định danh thuế của khách hàng hoặc nhà cung cấp như được ghi trong dữ liệu nguồn.",
+        ["tax code", "mst", "mã số thuế NCC"],
+        ["Mất số 0 ở đầu", "Gắn nhầm mã cho đối tượng khác"],
+        "Giữ dạng văn bản và đối chiếu với đúng đối tượng trong chứng từ nguồn.",
+    ),
+    "so_luong": _definition(
+        "Số lượng",
+        "Số lượng hàng hóa hoặc dịch vụ của dòng chi tiết.",
+        ["quantity", "qty", "luong"],
+        ["Dùng chuỗi có kèm đơn vị", "Nhầm dấu phân cách thập phân"],
+        "Chọn cột số lượng dạng số và đối chiếu với đơn vị tính của cùng dòng.",
+    ),
+    "don_gia": _definition(
+        "Đơn giá",
+        "Giá cho một đơn vị hàng hóa hoặc dịch vụ của dòng chi tiết.",
+        ["unit price", "price", "dgvnd"],
+        ["Nhầm giá đã gồm thuế", "Nhầm dấu phân cách hàng nghìn"],
+        "Đối chiếu cách tính thành tiền trong file nguồn trước khi dùng cột đơn giá.",
+    ),
+    "thanh_tien": _definition(
+        "Thành tiền",
+        "Giá trị tiền của dòng chi tiết trước các khoản được tách riêng trong mẫu.",
+        ["amount", "line amount", "ttvnd"],
+        ["Nhầm tổng thanh toán với thành tiền", "Sai do số lượng nhân đơn giá"],
+        "Đối chiếu công thức của file nguồn và so sánh với số lượng, đơn giá khi các cột này có đủ.",
+    ),
+    "ty_le_ck": _definition(
+        "Tỷ lệ chiết khấu",
+        "Tỷ lệ chiết khấu áp dụng cho dòng chi tiết nếu nguồn có thông tin này.",
+        ["discount rate", "% CK", "pt_ck"],
+        ["Nhập 10 thay vì 10% theo định dạng nguồn", "Có tỷ lệ nhưng thiếu tiền chiết khấu"],
+        "Kiểm tra cách biểu diễn phần trăm trong file nguồn và đối chiếu với tiền chiết khấu.",
+    ),
+    "tien_chiet_khau": _definition(
+        "Tiền chiết khấu",
+        "Số tiền chiết khấu của dòng chi tiết.",
+        ["discount amount", "chiết khấu"],
+        ["Nhầm với tỷ lệ chiết khấu", "Dấu âm/dương không nhất quán"],
+        "Đối chiếu với tỷ lệ chiết khấu và thành tiền nếu nguồn cung cấp đủ dữ liệu.",
+    ),
+    "thue_gtgt": _definition(
+        "Thuế suất GTGT",
+        "Tỷ lệ thuế GTGT được ghi cho dòng dữ liệu; trường này chỉ phản ánh giá trị nguồn, không kết luận tính phù hợp pháp lý.",
+        ["VAT rate", "thuế suất", "ts_gtgt"],
+        ["Nhập phần trăm sai định dạng", "Tự chọn thuế suất khi nguồn không có"],
+        "Giữ nguyên giá trị có căn cứ từ nguồn; nếu thiếu hoặc cần phán đoán thì đánh dấu cần rà soát.",
+    ),
+    "tien_thue_gtgt": _definition(
+        "Tiền thuế GTGT",
+        "Số tiền thuế GTGT được ghi cho dòng hoặc chứng từ.",
+        ["VAT amount", "thuế GTGT", "thuevnd"],
+        ["Nhầm với tổng thanh toán", "Không khớp thành tiền và thuế suất"],
+        "Đối chiếu phép tính khi thành tiền và thuế suất đều có trong nguồn.",
+    ),
+    "tk_thue_gtgt": _definition(
+        "Tài khoản thuế GTGT",
+        "Mã tài khoản dùng cho phần thuế GTGT của dòng dữ liệu.",
+        ["VAT account", "tk thuế", "tkthue"],
+        ["Nhập tên thay vì mã tài khoản", "Tự suy đoán khi thiếu ngữ cảnh"],
+        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp; không tự suy đoán.",
+    ),
+    "loai_tien": _definition(
+        "Loại tiền",
+        "Mã đồng tiền áp dụng cho chứng từ hoặc dòng dữ liệu.",
+        ["currency", "currency code"],
+        ["Dùng tên tiền thay cho mã", "Thiếu tỷ giá khi nguồn cần quy đổi"],
+        "Đối chiếu mã đồng tiền trong nguồn và kiểm tra tỷ giá khi không dùng đồng tiền hạch toán.",
+    ),
+    "ty_gia": _definition(
+        "Tỷ giá",
+        "Hệ số quy đổi giữa loại tiền của chứng từ và đồng tiền hạch toán.",
+        ["exchange rate", "rate"],
+        ["Nhầm chiều tỷ giá", "Nhập văn bản không phải số"],
+        "Đối chiếu tỷ giá và cách quy đổi được sử dụng trong file nguồn.",
+    ),
+    "ma_khach_hang": _definition(
+        "Mã khách hàng",
+        "Mã định danh khách hàng trong danh mục đích.",
+        ["customer code", "mã KH", "makh"],
+        ["Dùng tên khách hàng thay cho mã", "Mã chưa được xác minh trong danh mục"],
+        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
+    ),
+    "ma_nha_cung_cap": _definition(
+        "Mã nhà cung cấp",
+        "Mã định danh nhà cung cấp trong danh mục đích.",
+        ["supplier code", "vendor code", "mã NCC"],
+        ["Dùng tên nhà cung cấp thay cho mã", "Mã chưa được xác minh trong danh mục"],
+        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
+    ),
+    "ma_ncc": _definition(
+        "Mã nhà cung cấp",
+        "Mã định danh nhà cung cấp trong danh mục đích.",
+        ["supplier code", "vendor code", "mã nhà cung cấp"],
+        ["Dùng tên nhà cung cấp thay cho mã", "Mã chưa được xác minh trong danh mục"],
+        "Ưu tiên mã từ nguồn và kiểm tra trạng thái danh mục khi có hồ sơ doanh nghiệp.",
+    ),
+    "ma_kho": _definition(
+        "Mã kho",
+        "Mã định danh kho liên quan đến dòng hàng hóa.",
+        ["warehouse code", "kho"],
+        ["Dùng tên kho thay cho mã", "Mã kho chưa được xác minh"],
+        "Đối chiếu mã kho trong nguồn hoặc danh mục được chọn.",
+    ),
+    "tk_kho": _definition(
+        "Tài khoản kho",
+        "Mã tài khoản phản ánh giá trị hàng tồn kho của dòng dữ liệu.",
+        ["inventory account", "tài khoản kho"],
+        ["Nhập tên thay vì mã tài khoản", "Không khớp loại hàng hoặc kho"],
+        "Đối chiếu mã tài khoản với yêu cầu bài làm hoặc hồ sơ doanh nghiệp.",
+    ),
+    "tk_gia_von": _definition(
+        "Tài khoản giá vốn",
+        "Mã tài khoản dùng cho giá vốn của dòng bán hàng khi nghiệp vụ có theo dõi giá vốn.",
+        ["cost of goods sold account", "COGS account"],
+        ["Nhập tên thay vì mã", "Tự suy đoán khi file nguồn không có căn cứ"],
+        "Chỉ điền khi nguồn hoặc cấu hình nghiệp vụ có căn cứ; nếu không, để người dùng rà soát.",
+    ),
+    "don_gia_von": _definition(
+        "Đơn giá vốn",
+        "Giá vốn cho một đơn vị hàng hóa của dòng bán hàng.",
+        ["unit cost", "cost price"],
+        ["Nhầm với đơn giá bán", "Tự tính khi thiếu dữ liệu nguồn"],
+        "Đối chiếu với dữ liệu giá vốn có sẵn; không tự tạo giá trị khi nguồn không cung cấp.",
+    ),
+    "tien_von": _definition(
+        "Tiền vốn",
+        "Tổng giá vốn của dòng bán hàng.",
+        ["cost amount", "COGS amount"],
+        ["Nhầm với thành tiền bán", "Không khớp số lượng và đơn giá vốn"],
+        "Đối chiếu với dữ liệu giá vốn nguồn và phép tính khi đủ số lượng, đơn giá vốn.",
+    ),
+}
+
+
+KEY_ALIASES = {
+    normalize_header("Số chứng từ (*)"): "so_chung_tu",
+    normalize_header("Số phiếu nhập (*)"): "so_phieu_nhap",
+    normalize_header("Mã hàng (*)"): "ma_hang",
+    normalize_header("Mã dịch vụ (*)"): "ma_dich_vu",
+    normalize_header("TK Tiền/Chi phí/Nợ (*)"): "tk_tien_chi_phi_no",
+    normalize_header("TK Doanh thu/Có (*)"): "tk_doanh_thu_co",
+    normalize_header("TK kho/TK chi phí (*)"): "tk_kho_tk_chi_phi",
+    normalize_header("TK công nợ/TK tiền (*)"): "tk_cong_no_tk_tien",
+    normalize_header("% thuế GTGT"): "thue_gtgt",
+}
+
+
+def field_definition(template_id: str, header: str) -> dict[str, Any]:
+    template = get_misa_template(str(template_id or "").strip())
+    clean_header = str(header or "").strip()
+    if not clean_header:
+        raise ValueError("Student field header là bắt buộc")
+
+    required = "(*)" in clean_header
+    in_template = clean_header in template.headers
+    normalized = normalize_header(re.sub(r"\s*\(\*\)\s*", "", clean_header))
+    definition_key = KEY_ALIASES.get(normalize_header(clean_header), normalized)
+    definition = CRITICAL_DEFINITIONS.get(definition_key)
+    specific = definition is not None
+    if definition is None:
+        definition = _definition(
+            clean_header,
+            (
+                f"Trường tùy chọn '{clean_header}' trong mẫu {template.id}; trường này chỉ "
+                "mang giá trị cùng tên từ file nguồn khi dữ liệu phù hợp."
+            ),
+            [clean_header],
+            ["Gán cột nguồn chỉ vì tên gần giống", "Tạo giá trị khi file nguồn không có căn cứ"],
+            "Đối chiếu theo tên cột và dữ liệu nguồn; để trống nếu không có căn cứ phù hợp.",
+        )
+
+    payload = deepcopy(definition)
+    payload.update(
+        {
+            "template_id": template.id,
+            "header": clean_header,
+            "required": required,
+            "required_source": (
+                "template_marker" if required else "not_required_by_template_marker"
+            ),
+            "specific": specific,
+            "source": {
+                "rule_id": (
+                    "student_field_definition_specific_v1"
+                    if specific
+                    else "student_optional_field_safe_fallback_v1"
+                ),
+                "source_ref": (
+                    f"template:{template.id}:{clean_header}"
+                    if in_template
+                    else f"header:{template.id}:{clean_header}"
+                ),
+                "source_url": MISA_IMPORT_SOURCE_URL if specific and in_template else None,
+                "checked_at": CHECKED_AT,
+                "effective_from": None,
+                "effective_to": None,
+                "dictionary_version": DICTIONARY_VERSION,
+            },
+        }
+    )
+    return payload
diff --git a/converter/app/student_explanations.py b/converter/app/student_explanations.py
new file mode 100755
index 0000000..120f75c
--- /dev/null
+++ b/converter/app/student_explanations.py
@@ -0,0 +1,684 @@
+from __future__ import annotations
+
+import hashlib
+import json
+import re
+from datetime import date, datetime
+from typing import Any
+
+from app.excel_io import InputTable
+from app.misa_mapping import transform_value
+from app.student_field_dictionary import field_definition
+from app.student_models import StudentEvidence, StudentExplanation, StudentFileSummary
+
+
+RULE_SOURCE_PREFIX = "urn:ezformat:student-rule"
+MAX_ROW_SPECIFIC_EXPLANATION_ROWS = 25
+
+
+def stable_explanation_id(
+    *,
+    session_id: str,
+    upload_id: str,
+    kind: str,
+    target_field: str | None,
+    rule_id: str,
+) -> str:
+    identity = "|".join(
+        [session_id, upload_id, kind, target_field or "", rule_id]
+    )
+    return "exp_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
+
+
+def explanation_state_hash(
+    *,
+    session_id: str,
+    upload_id: str,
+    target_template_id: str,
+    source_signature_hash: str,
+    mapping_source: str,
+    mapping_identity: str,
+    mapping: dict[str, Any],
+    defaults: dict[str, Any],
+    formulas: dict[str, Any],
+) -> str:
+    payload = {
+        "session_id": session_id,
+        "upload_id": upload_id,
+        "target_template_id": target_template_id,
+        "source_signature_hash": source_signature_hash,
+        "mapping_source": mapping_source,
+        "mapping_identity": mapping_identity,
+        "mapping": mapping,
+        "defaults": defaults,
+        "formulas": formulas,
+    }
+    encoded = json.dumps(
+        payload,
+        ensure_ascii=False,
+        sort_keys=True,
+        separators=(",", ":"),
+        default=str,
+    ).encode("utf-8")
+    return hashlib.sha256(encoded).hexdigest()
+
+
+def build_student_explanations(
+    *,
+    session_id: str,
+    upload_id: str,
+    target_template_id: str,
+    table: InputTable,
+    target_headers: list[str],
+    mapping_source: str,
+    mapping: dict[str, Any],
+    defaults: dict[str, Any],
+    formulas: dict[str, str],
+    readiness: dict[str, Any],
+    master_data: dict[str, Any],
+    state_hash: str,
+) -> list[StudentExplanation]:
+    target_to_sources = _target_to_sources(mapping)
+    explanations: list[StudentExplanation] = []
+
+    for target_field in target_headers:
+        definition = field_definition(target_template_id, target_field)
+        sources = target_to_sources.get(target_field, [])
+        active_modes = [
+            mode
+            for mode, active in (
+                ("mapping", bool(sources)),
+                ("default", _has_value(defaults.get(target_field))),
+                ("formula", _has_value(formulas.get(target_field))),
+            )
+            if active
+        ]
+        if "formula" in active_modes:
+            reason = f"Công thức hiện tại tạo giá trị cho trường {target_field}."
+        elif "default" in active_modes:
+            reason = f"Giá trị mặc định hiện tại được dùng cho trường {target_field}."
+        elif "mapping" in active_modes:
+            reason = (
+                f"Trường {target_field} nhận dữ liệu từ cột nguồn "
+                + ", ".join(sources)
+                + "."
+            )
+        else:
+            reason = f"Trường {target_field} chưa có mapping, mặc định hoặc công thức."
+
+        severity = "none"
+        if definition["required"] and not active_modes:
+            severity = "blocker"
+        elif len(active_modes) > 1:
+            severity = "warning"
+
+        evidence = [_template_evidence(definition)]
+        for source_column in sources:
+            evidence.append(_source_column_evidence(table, source_column))
+        if "default" in active_modes:
+            evidence.append(
+                StudentEvidence(
+                    kind="rule",
+                    rule_id="mapping_default_value_v1",
+                    source_ref=(
+                        f"{RULE_SOURCE_PREFIX}:mapping-default:v1:"
+                        f"{target_template_id}:{target_field}"
+                    ),
+                    raw_value=defaults.get(target_field),
+                )
+            )
+        if "formula" in active_modes:
+            evidence.append(
+                StudentEvidence(
+                    kind="rule",
+                    rule_id="mapping_formula_v1",
+                    source_ref=(
+                        f"{RULE_SOURCE_PREFIX}:mapping-formula:v1:"
+                        f"{target_template_id}:{target_field}"
+                    ),
+                    raw_value=formulas.get(target_field),
+                )
+            )
+        explanations.append(
+            _explanation(
+                session_id=session_id,
+                upload_id=upload_id,
+                kind="field",
+                severity=severity,
+                target_field=target_field,
+                rule_id=f"field:{target_field}",
+                title=definition["title"],
+                meaning_vi=definition["meaning_vi"],
+                reason_vi=reason,
+                impact_vi=(
+                    "Trường bắt buộc chưa có nguồn dữ liệu nên readiness có thể bị chặn."
+                    if severity == "blocker"
+                    else None
+                ),
+                fix_hint_vi=definition["fix_hint_vi"],
+                evidence=evidence,
+                claim_sources=(
+                    sources
+                    if active_modes == ["mapping"]
+                    else []
+                ),
+                state_hash=state_hash,
+            )
+        )
+
+    for source_column, target_spec in mapping.items():
+        targets = target_spec if isinstance(target_spec, list) else [target_spec]
+        for target_field in targets:
+            if target_field not in target_headers:
+                continue
+            definition = field_definition(target_template_id, target_field)
+            rule_id = f"mapping:{mapping_source}:{source_column}"
+            explanations.append(
+                _explanation(
+                    session_id=session_id,
+                    upload_id=upload_id,
+                    kind="mapping",
+                    severity="none",
+                    target_field=target_field,
+                    rule_id=rule_id,
+                    title=f"{source_column} -> {target_field}",
+                    meaning_vi=definition["meaning_vi"],
+                    reason_vi=(
+                        f"Pipeline mapping hiện tại ({mapping_source}) gán cột "
+                        f"{source_column} vào trường {target_field}."
+                    ),
+                    impact_vi="Giá trị của cột nguồn này sẽ được dùng để tạo dữ liệu đích.",
+                    fix_hint_vi=(
+                        "Mở cột nguồn và so sánh vài dòng với ý nghĩa của trường đích trước khi dùng."
+                    ),
+                    evidence=[
+                        _source_column_evidence(table, source_column),
+                        StudentEvidence(
+                            kind="rule",
+                            rule_id=f"mapping_source_{mapping_source}",
+                            source_ref=f"{RULE_SOURCE_PREFIX}:mapping-source:{mapping_source}:v1",
+                        ),
+                    ],
+                    claim_sources=[source_column],
+                    state_hash=state_hash,
+                )
+            )
+
+    explanations.extend(
+        _normalization_explanations(
+            session_id=session_id,
+            upload_id=upload_id,
+            target_template_id=target_template_id,
+            table=table,
+            mapping=mapping,
+            state_hash=state_hash,
+        )
+    )
+    explanations.extend(
+        _formula_explanations(
+            session_id=session_id,
+            upload_id=upload_id,
+            target_template_id=target_template_id,
+            table=table,
+            formulas=formulas,
+            target_to_sources=target_to_sources,
+            state_hash=state_hash,
+        )
+    )
+    explanations.extend(
+        _issue_explanations(
+            session_id=session_id,
+            upload_id=upload_id,
+            target_template_id=target_template_id,
+            table=table,
+            readiness=readiness,
+            target_to_sources=target_to_sources,
+            state_hash=state_hash,
+        )
+    )
+
+    master_status = str(master_data.get("status") or "not_configured")
+    if master_status != "connected":
+        explanations.append(
+            _explanation(
+                session_id=session_id,
+                upload_id=upload_id,
+                kind="master_data",
+                severity="warning" if master_status == "unavailable" else "info",
+                target_field=None,
+                rule_id=f"master_data:{master_status}",
+                title="Trạng thái đối chiếu danh mục",
+                meaning_vi="Cho biết dữ liệu mã đã được đối chiếu với hồ sơ doanh nghiệp hay chưa.",
+                reason_vi=(
+                    str(master_data.get("message") or "Chưa cấu hình hồ sơ doanh nghiệp để đối chiếu mã.")
+                ),
+                impact_vi="Các mã khách hàng, nhà cung cấp, hàng hóa hoặc kho có thể vẫn cần rà soát.",
+                fix_hint_vi="Chọn hồ sơ doanh nghiệp nếu cần xác minh danh mục, hoặc kiểm tra mã trực tiếp.",
+                evidence=[
+                    StudentEvidence(
+                        kind="rule",
+                        rule_id="master_data_context_status_v1",
+                        source_ref=f"{RULE_SOURCE_PREFIX}:master-data-context:v1",
+                        raw_value=master_status,
+                    )
+                ],
+                state_hash=state_hash,
+            )
+        )
+
+    return explanations
+
+
+def build_student_summary(
+    *,
+    session_id: str,
+    upload_id: str,
+    file_name: str,
+    target_template_id: str,
+    table: InputTable,
+    target_headers: list[str],
+    mapping: dict[str, Any],
+    defaults: dict[str, Any],
+    formulas: dict[str, str],
+    preview: dict[str, Any],
+    readiness: dict[str, Any],
+    explanation_count: int,
+    state_hash: str,
+) -> StudentFileSummary:
+    target_to_sources = _target_to_sources(mapping)
+    mapping_counts = {
+        "mapped": 0,
+        "default": 0,
+        "formula": 0,
+        "unresolved": 0,
+        "mixed": 0,
+    }
+    for target in target_headers:
+        active = sum(
+            [
+                bool(target_to_sources.get(target)),
+                _has_value(defaults.get(target)),
+                _has_value(formulas.get(target)),
+            ]
+        )
+        if active > 1:
+            mapping_counts["mixed"] += 1
+        elif target_to_sources.get(target):
+            mapping_counts["mapped"] += 1
+        elif _has_value(defaults.get(target)):
+            mapping_counts["default"] += 1
+        elif _has_value(formulas.get(target)):
+            mapping_counts["formula"] += 1
+        else:
+            mapping_counts["unresolved"] += 1
+
+    recognized_source_columns = sum(1 for header in table.headers if header in mapping)
+    issue_summary = readiness.get("summary") or {}
+    reconciliation = readiness.get("reconciliation") or {}
+    totals = {
+        key: reconciliation.get(key)
+        for key in ("sum_amount", "sum_vat", "sum_total")
+        if reconciliation.get(key) not in (None, "")
+    }
+    rows = preview.get("rows") or []
+    return StudentFileSummary(
+        session_id=session_id,
+        upload_id=upload_id,
+        file_name=file_name,
+        target_template_id=target_template_id,
+        sheet_name=table.sheet_name or "",
+        header_row=table.header_row_index + 1,
+        data_row_count=len(table.rows),
+        document_count=_document_count(rows),
+        recognized_columns=recognized_source_columns,
+        unresolved_columns=max(0, len(table.headers) - recognized_source_columns),
+        mapping_counts=mapping_counts,
+        issue_counts={
+            "blocker": int(issue_summary.get("blocker") or 0),
+            "warning": int(issue_summary.get("warning") or 0),
+            "info": int(issue_summary.get("info") or 0),
+        },
+        master_data_status=str(
+            (preview.get("master_data") or {}).get("status") or "not_configured"
+        ),
+        reconcilable_totals=totals,
+        explanation_count=explanation_count,
+        state_hash=state_hash,
+    )
+
+
+def _normalization_explanations(
+    *,
+    session_id: str,
+    upload_id: str,
+    target_template_id: str,
+    table: InputTable,
+    mapping: dict[str, Any],
+    state_hash: str,
+) -> list[StudentExplanation]:
+    items: list[StudentExplanation] = []
+    emitted_cells: set[tuple[str, int]] = set()
+    for row_index, source_row in enumerate(table.rows):
+        if row_index >= MAX_ROW_SPECIFIC_EXPLANATION_ROWS:
+            break
+        for source_column, target_spec in mapping.items():
+            if source_column not in source_row:
+                continue
+            raw_value = source_row.get(source_column)
+            if not _has_value(raw_value):
+                continue
+            targets = target_spec if isinstance(target_spec, list) else [target_spec]
+            for target_field in targets:
+                cell_key = (str(target_field), row_index)
+                if cell_key in emitted_cells:
+                    continue
+                normalized_value = transform_value(raw_value, target_field)
+                if not _normalization_changed(raw_value, normalized_value):
+                    continue
+                definition = field_definition(target_template_id, target_field)
+                rule_id = f"normalization:{target_field}:{row_index + 1}"
+                items.append(
+                    _explanation(
+                        session_id=session_id,
+                        upload_id=upload_id,
+                        kind="normalization",
+                        severity="info",
+                        target_field=target_field,
+                        rule_id=rule_id,
+                        title=f"Chuẩn hóa {target_field}",
+                        meaning_vi=definition["meaning_vi"],
+                        reason_vi=(
+                            f"Giá trị từ cột {source_column} được chuẩn hóa theo kiểu dữ liệu "
+                            f"của trường {target_field}."
+                        ),
+                        impact_vi="Dữ liệu đích có thể khác cách hiển thị ban đầu nhưng vẫn giữ giá trị đã đọc.",
+                        fix_hint_vi="Mở ô nguồn được dẫn chiếu và xác nhận giá trị chuẩn hóa là đúng.",
+                        normalized_value=normalized_value,
+                        evidence=[
+                            _source_cell_evidence(
+                                table, row_index, source_column, raw_value
+                            ),
+                            StudentEvidence(
+                                kind="rule",
+                                rule_id="misa_transform_value_v1",
+                                source_ref=f"{RULE_SOURCE_PREFIX}:misa-transform-value:v1",
+                            ),
+                        ],
+                        claim_sources=[source_column],
+                        preview_row=row_index + 1,
+                        state_hash=state_hash,
+                    )
+                )
+                emitted_cells.add(cell_key)
+    return items
+
+
+def _formula_explanations(
+    *,
+    session_id: str,
+    upload_id: str,
+    target_template_id: str,
+    table: InputTable,
+    formulas: dict[str, str],
+    target_to_sources: dict[str, list[str]],
+    state_hash: str,
+) -> list[StudentExplanation]:
+    items: list[StudentExplanation] = []
+    for target_field, expression in formulas.items():
+        definition = field_definition(target_template_id, target_field)
+        evidence: list[StudentEvidence] = [
+            StudentEvidence(
+                kind="rule",
+                rule_id="mapping_formula_v1",
+                source_ref=(
+                    f"{RULE_SOURCE_PREFIX}:mapping-formula:v1:"
+                    f"{target_template_id}:{target_field}"
+                ),
+                raw_value=expression,
+            )
+        ]
+        referenced_targets = re.findall(r"\$\{(.+?)\}", str(expression))
+        for referenced_target in referenced_targets:
+            for source_column in target_to_sources.get(referenced_target, []):
+                candidate = _source_column_evidence(table, source_column)
+                if candidate.source_ref not in {item.source_ref for item in evidence}:
+                    evidence.append(candidate)
+        items.append(
+            _explanation(
+                session_id=session_id,
+                upload_id=upload_id,
+                kind="calculation",
+                severity="info",
+                target_field=target_field,
+                rule_id=f"formula:{target_field}",
+                title=f"Công thức {target_field}",
+                meaning_vi=definition["meaning_vi"],
+                reason_vi=f"Trường {target_field} được tính bằng công thức {expression}.",
+                impact_vi="Kết quả phụ thuộc vào các trường được tham chiếu trong công thức.",
+                fix_hint_vi="Kiểm tra mapping của các trường tham chiếu và đối chiếu vài dòng kết quả.",
+                evidence=evidence,
+                state_hash=state_hash,
+            )
+        )
+    return items
+
+
+def _issue_explanations(
+    *,
+    session_id: str,
+    upload_id: str,
+    target_template_id: str,
+    table: InputTable,
+    readiness: dict[str, Any],
+    target_to_sources: dict[str, list[str]],
+    state_hash: str,
+) -> list[StudentExplanation]:
+    items: list[StudentExplanation] = []
+    for issue in readiness.get("issues") or []:
+        field = str(issue.get("field") or "").strip() or None
+        definition = field_definition(target_template_id, field) if field else None
+        code = str(issue.get("code") or "readiness_issue")
+        row = _positive_int(issue.get("row"))
+        issue_fingerprint = hashlib.sha256(
+            json.dumps(
+                {
+                    "code": code,
+                    "row": row,
+                    "field": field,
+                    "message": issue.get("message"),
+                    "expected": issue.get("expected"),
+                    "actual": issue.get("actual"),
+                },
+                ensure_ascii=False,
+                sort_keys=True,
+                default=str,
+            ).encode("utf-8")
+        ).hexdigest()[:12]
+        rule_id = f"readiness:{code}:{row or 'all'}:{issue_fingerprint}"
+        evidence: list[StudentEvidence] = [
+            StudentEvidence(
+                kind="rule",
+                rule_id=code,
+                source_ref=f"{RULE_SOURCE_PREFIX}:readiness:{code}:v1",
+                source_url=issue.get("source_url"),
+            )
+        ]
+        if field and row and row <= len(table.rows):
+            for source_column in target_to_sources.get(field, [])[:1]:
+                evidence.insert(
+                    0,
+                    _source_cell_evidence(
+                        table,
+                        row - 1,
+                        source_column,
+                        table.rows[row - 1].get(source_column),
+                    ),
+                )
+        severity = str(issue.get("severity") or "warning")
+        if severity not in {"blocker", "warning", "info"}:
+            severity = "warning"
+        items.append(
+            _explanation(
+                session_id=session_id,
+                upload_id=upload_id,
+                kind="issue",
+                severity=severity,
+                target_field=field,
+                rule_id=rule_id,
+                title=(definition["title"] if definition else "Vấn đề cần rà soát"),
+                meaning_vi=(
+                    definition["meaning_vi"]
+                    if definition
+                    else "Vấn đề được tạo bởi readiness rules engine hiện có."
+                ),
+                reason_vi=str(issue.get("message") or code),
+                impact_vi=(
+                    "Vấn đề chắc chắn cần sửa trước khi export."
+                    if severity == "blocker"
+                    else "Vấn đề cần được rà soát trước khi tiếp tục."
+                ),
+                fix_hint_vi=str(
+                    issue.get("fix_hint")
+                    or (definition or {}).get("fix_hint_vi")
+                    or "Đối chiếu bằng chứng và chỉnh dữ liệu hoặc mapping liên quan."
+                ),
+                normalized_value=issue.get("actual"),
+                evidence=evidence,
+                preview_row=row,
+                issue_code=code,
+                issue_row=row,
+                state_hash=state_hash,
+            )
+        )
+    return items
+
+
+def _explanation(
+    *,
+    session_id: str,
+    upload_id: str,
+    kind: str,
+    severity: str,
+    target_field: str | None,
+    rule_id: str,
+    title: str,
+    meaning_vi: str,
+    reason_vi: str,
+    fix_hint_vi: str,
+    evidence: list[StudentEvidence],
+    state_hash: str,
+    claim_sources: list[str] | None = None,
+    preview_row: int | None = None,
+    issue_code: str | None = None,
+    issue_row: int | None = None,
+    impact_vi: str | None = None,
+    normalized_value: Any = None,
+) -> StudentExplanation:
+    return StudentExplanation(
+        id=stable_explanation_id(
+            session_id=session_id,
+            upload_id=upload_id,
+            kind=kind,
+            target_field=target_field,
+            rule_id=rule_id,
+        ),
+        kind=kind,
+        severity=severity,
+        deterministic=True,
+        target_field=target_field,
+        title=title,
+        meaning_vi=meaning_vi,
+        reason_vi=reason_vi,
+        impact_vi=impact_vi,
+        fix_hint_vi=fix_hint_vi,
+        normalized_value=normalized_value,
+        evidence=evidence,
+        claim_sources=list(claim_sources or []),
+        preview_row=preview_row,
+        issue_code=issue_code,
+        issue_row=issue_row,
+        state_hash=state_hash,
+        stale=False,
+    )
+
+
+def _template_evidence(definition: dict[str, Any]) -> StudentEvidence:
+    source = definition["source"]
+    return StudentEvidence(
+        kind="template",
+        rule_id=source["rule_id"],
+        source_ref=source["source_ref"],
+        source_url=source.get("source_url"),
+        checked_at=source.get("checked_at"),
+        effective_from=source.get("effective_from"),
+        effective_to=source.get("effective_to"),
+    )
+
+
+def _source_column_evidence(table: InputTable, source_column: str) -> StudentEvidence:
+    return StudentEvidence(
+        kind="source_column",
+        sheet=table.sheet_name or "",
+        column=source_column,
+        source_ref=f"sheet:{table.sheet_name or ''}:column:{source_column}",
+    )
+
+
+def _source_cell_evidence(
+    table: InputTable,
+    row_index: int,
+    source_column: str,
+    raw_value: Any,
+) -> StudentEvidence:
+    source_row_number = table.header_row_index + 2 + row_index
+    return StudentEvidence(
+        kind="source_cell",
+        sheet=table.sheet_name or "",
+        row=source_row_number,
+        column=source_column,
+        raw_value=raw_value,
+        source_ref=(
+            f"sheet:{table.sheet_name or ''}:row:{source_row_number}:column:{source_column}"
+        ),
+    )
+
+
+def _target_to_sources(mapping: dict[str, Any]) -> dict[str, list[str]]:
+    result: dict[str, list[str]] = {}
+    for source_column, target_spec in mapping.items():
+        targets = target_spec if isinstance(target_spec, list) else [target_spec]
+        for target in targets:
+            if not target:
+                continue
+            result.setdefault(str(target), []).append(str(source_column))
+    return result
+
+
+def _document_count(rows: list[dict[str, Any]]) -> int | None:
+    for field in ("Số chứng từ (*)", "Số phiếu nhập (*)", "Số hóa đơn"):
+        values = {
+            str(row.get(field)).strip()
+            for row in rows
+            if _has_value(row.get(field))
+        }
+        if values:
+            return len(values)
+    return None
+
+
+def _normalization_changed(raw_value: Any, normalized_value: Any) -> bool:
+    if isinstance(normalized_value, (date, datetime)):
+        return True
+    return type(raw_value) is not type(normalized_value) or raw_value != normalized_value
+
+
+def _has_value(value: Any) -> bool:
+    return value is not None and str(value).strip() != ""
+
+
+def _positive_int(value: Any) -> int | None:
+    try:
+        parsed = int(value)
+    except (TypeError, ValueError):
+        return None
+    return parsed if parsed > 0 else None
diff --git a/converter/app/student_session_client.py b/converter/app/student_session_client.py
new file mode 100755
index 0000000..0a1a5da
--- /dev/null
+++ b/converter/app/student_session_client.py
@@ -0,0 +1,45 @@
+from __future__ import annotations
+
+import os
+from typing import Any
+
+import httpx
+
+
+class StudentSessionClientError(ValueError):
+    pass
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
diff --git a/converter/app/student_workflow.py b/converter/app/student_workflow.py
new file mode 100755
index 0000000..5c84292
--- /dev/null
+++ b/converter/app/student_workflow.py
@@ -0,0 +1,364 @@
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
+from app.student_session_client import (
+    StudentSessionClientError,
+    record_analysis_completed,
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
index 0000000..d2419ac
--- /dev/null
+++ b/converter/app/student_store.py
@@ -0,0 +1,243 @@
+from __future__ import annotations
+
+import json
+import os
+import shutil
+import time
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
+    try:
+        descriptor = os.open(
+            lock_path,
+            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
+            0o600,
+        )
+    except FileExistsError as exc:
+        raise StudentUploadConflictError(
+            "Phiên học đang được phân tích"
+        ) from exc
+
+    try:
+        os.close(descriptor)
+        yield
+    finally:
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
diff --git a/converter/tests/test_student_explanations.py b/converter/tests/test_student_explanations.py
new file mode 100755
index 0000000..ba3978a
--- /dev/null
+++ b/converter/tests/test_student_explanations.py
@@ -0,0 +1,179 @@
+from __future__ import annotations
+
+import pytest
+
+from app.misa_templates import list_misa_templates
+from app.student_field_dictionary import field_definition
+from app.student_explanations import explanation_state_hash, stable_explanation_id
+from app.student_models import StudentEvidence, StudentExplanation, StudentFileSummary
+
+
+EXPECTED_TEMPLATE_IDS = {
+    "bsn_sales",
+    "bsn_purchase",
+    "misa_purchase_domestic",
+    "sales_goods",
+    "sales_service",
+    "purchase_goods",
+    "purchase_service",
+}
+
+
+def test_field_dictionary_covers_every_header_in_all_student_templates():
+    templates = list_misa_templates()
+    assert {template.id for template in templates} == EXPECTED_TEMPLATE_IDS
+
+    for template in templates:
+        for header in template.headers:
+            definition = field_definition(template.id, header)
+            assert definition["header"] == header
+            assert definition["meaning_vi"].strip()
+            assert definition["fix_hint_vi"].strip()
+            assert definition["source"]["rule_id"].strip()
+            assert definition["source"]["source_ref"].strip()
+
+            if "(*)" in header:
+                assert definition["required"] is True
+                assert definition["required_source"] == "template_marker"
+                assert definition["specific"] is True
+                assert "trường tùy chọn" not in definition["meaning_vi"].lower()
+
+
+def test_optional_unknown_field_uses_safe_generic_definition():
+    definition = field_definition("bsn_sales", "Trường tham chiếu nội bộ")
+
+    assert definition["required"] is False
+    assert definition["specific"] is False
+    assert "trường tùy chọn" in definition["meaning_vi"].lower()
+    assert "theo tên cột" in definition["fix_hint_vi"].lower()
+    assert "pháp luật" not in definition["meaning_vi"].lower()
+    assert definition["source"]["source_url"] is None
+    assert definition["source"]["rule_id"] == "student_optional_field_safe_fallback_v1"
+
+
+def test_optional_template_fallback_uses_template_and_internal_rule_evidence():
+    definition = field_definition("bsn_sales", "Hình thức bán hàng")
+
+    assert definition["specific"] is False
+    assert definition["source"]["source_ref"] == "template:bsn_sales:Hình thức bán hàng"
+    assert definition["source"]["source_url"] is None
+
+
+def test_student_explanation_rejects_deterministic_claim_without_evidence():
+    with pytest.raises(ValueError, match="evidence"):
+        StudentExplanation(
+            id="explanation-1",
+            kind="mapping",
+            severity="none",
+            deterministic=True,
+            target_field="Ngày hạch toán (*)",
+            title="Ngày hạch toán",
+            meaning_vi="Ngày nghiệp vụ được ghi nhận vào sổ kế toán.",
+            reason_vi="Cột nguồn được nhận diện theo tên và kiểu dữ liệu.",
+            fix_hint_vi="Đối chiếu cột ngày trong file nguồn.",
+            evidence=[],
+        )
+
+
+def test_student_contract_serializes_source_and_rule_evidence():
+    explanation = StudentExplanation(
+        id="explanation-1",
+        kind="mapping",
+        severity="none",
+        deterministic=True,
+        target_field="Ngày hạch toán (*)",
+        title="Ngày hạch toán",
+        meaning_vi="Ngày nghiệp vụ được ghi nhận vào sổ kế toán.",
+        reason_vi="Cột Thời gian được dùng làm ngày hạch toán.",
+        fix_hint_vi="Đối chiếu ngày trên chứng từ nguồn.",
+        evidence=[
+            StudentEvidence(
+                kind="source_column",
+                sheet="Data",
+                column="Thời gian",
+                source_ref="Data!Thời gian",
+            ),
+            StudentEvidence(
+                kind="rule",
+                rule_id="posting_date_mapping",
+                source_ref="urn:ezformat:student-rule:posting-date-mapping:v1",
+            ),
+        ],
+    )
+    summary = StudentFileSummary(
+        session_id="session-1",
+        upload_id="upload-1",
+        file_name="sales.xlsx",
+        target_template_id="bsn_sales",
+        sheet_name="Data",
+        header_row=1,
+        data_row_count=2,
+        recognized_columns=1,
+        unresolved_columns=0,
+        mapping_counts={"mapped": 1, "default": 0, "formula": 0, "unresolved": 0},
+        issue_counts={"blocker": 0, "warning": 0, "info": 0},
+        master_data_status="not_configured",
+        explanation_count=1,
+    )
+
+    payload = explanation.model_dump(mode="json")
+    assert payload["evidence"][0]["sheet"] == "Data"
+    assert payload["evidence"][1]["rule_id"] == "posting_date_mapping"
+    assert summary.model_dump(mode="json")["mapping_counts"]["mapped"] == 1
+
+
+def test_explanation_ids_are_stable_for_the_same_session_upload_field_and_rule():
+    first = stable_explanation_id(
+        session_id="session-1",
+        upload_id="upload-1",
+        kind="mapping",
+        target_field="Ngày hạch toán (*)",
+        rule_id="mapping:Thời gian",
+    )
+    second = stable_explanation_id(
+        session_id="session-1",
+        upload_id="upload-1",
+        kind="mapping",
+        target_field="Ngày hạch toán (*)",
+        rule_id="mapping:Thời gian",
+    )
+
+    assert first == second
+    assert first != stable_explanation_id(
+        session_id="session-1",
+        upload_id="upload-2",
+        kind="mapping",
+        target_field="Ngày hạch toán (*)",
+        rule_id="mapping:Thời gian",
+    )
+
+
+def test_explanation_state_hash_includes_mapping_source_and_profile_identity():
+    common = {
+        "session_id": "session-1",
+        "upload_id": "upload-1",
+        "target_template_id": "bsn_sales",
+        "source_signature_hash": "signature-1",
+        "mapping": {"Thời gian": "Ngày hạch toán (*)"},
+        "defaults": {},
+        "formulas": {},
+    }
+
+    heuristic = explanation_state_hash(
+        **common,
+        mapping_source="heuristic",
+        mapping_identity="heuristic",
+    )
+    confirmed = explanation_state_hash(
+        **common,
+        mapping_source="confirmed",
+        mapping_identity="profile-1",
+    )
+    another_profile = explanation_state_hash(
+        **common,
+        mapping_source="confirmed",
+        mapping_identity="profile-2",
+    )
+
+    assert heuristic != confirmed
+    assert confirmed != another_profile
diff --git a/converter/tests/test_student_api.py b/converter/tests/test_student_api.py
new file mode 100755
index 0000000..3872651
--- /dev/null
+++ b/converter/tests/test_student_api.py
@@ -0,0 +1,373 @@
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
+from app.student_session_client import record_analysis_completed
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
diff --git a/frontend/src/hooks/useStudentAssistantApi.js b/frontend/src/hooks/useStudentAssistantApi.js
new file mode 100755
index 0000000..76294fa
--- /dev/null
+++ b/frontend/src/hooks/useStudentAssistantApi.js
@@ -0,0 +1,105 @@
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
+  return { createSession, analyzeSession, getOverview };
+}
diff --git a/frontend/src/pages/StudentAssistantPage.jsx b/frontend/src/pages/StudentAssistantPage.jsx
new file mode 100755
index 0000000..9394e14
--- /dev/null
+++ b/frontend/src/pages/StudentAssistantPage.jsx
@@ -0,0 +1,379 @@
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
+import StudentMappingTable from "../components/student/StudentMappingTable";
+import StudentSessionSummary from "../components/student/StudentSessionSummary";
+import {
+  fetchStudentAssistantStatus,
+  STUDENT_TEMPLATE_OPTIONS,
+  useStudentAssistantApi,
+} from "../hooks/useStudentAssistantApi";
+import {
+  classifyStudentAssistantError,
+  clearStudentSessionResume,
+  keepCurrentExplanationSelection,
+  loadStudentSessionResume,
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
+  const { createSession, analyzeSession, getOverview } = useStudentAssistantApi();
+  const [serviceStatus, setServiceStatus] = useState({
+    loading: true,
+    serviceOnline: null,
+    aiStatus: null,
+    capabilityEnabled: null,
+  });
+  const [file, setFile] = useState(null);
+  const [targetTemplateId, setTargetTemplateId] = useState("bsn_sales");
+  const [status, setStatus] = useState("empty");
+  const [error, setError] = useState(null);
+  const [session, setSession] = useState(null);
+  const [analysis, setAnalysis] = useState(null);
+  const [selectedExplanationId, setSelectedExplanationId] = useState(null);
+  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
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
+            />
+            <ExplanationInspector
+              explanation={selectedExplanation}
+              mobileOpen={mobileInspectorOpen}
+              onMobileOpenChange={setMobileInspectorOpen}
+            />
+          </div>
+        )}
+      </main>
+      <Footer />
+    </div>
+  );
+}
diff --git a/frontend/src/components/student/StudentSessionSummary.jsx b/frontend/src/components/student/StudentSessionSummary.jsx
new file mode 100755
index 0000000..61d3cae
--- /dev/null
+++ b/frontend/src/components/student/StudentSessionSummary.jsx
@@ -0,0 +1,85 @@
+import {
+  AlertTriangle,
+  CheckCircle2,
+  FileSpreadsheet,
+  RefreshCw,
+  ShieldCheck,
+} from "lucide-react";
+import { getStudentSummaryItems } from "../../utils/studentAssistant";
+
+const itemTone = {
+  blockers: "border-red-100 bg-red-50 text-red-800",
+  warnings: "border-amber-100 bg-amber-50 text-amber-800",
+  unresolved: "border-amber-100 bg-amber-50 text-amber-800",
+};
+
+export default function StudentSessionSummary({ analysis, onReset }) {
+  const summary = analysis?.student_summary || {};
+  const items = getStudentSummaryItems(summary);
+  const syncStatus = analysis?.session_sync?.status;
+
+  return (
+    <aside className="space-y-4" aria-label="Tóm tắt phiên giải thích file">
+      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
+        <div className="flex items-start gap-3">
+          <span className="rounded-2xl bg-primary-50 p-3 text-primary-700">
+            <FileSpreadsheet size={23} />
+          </span>
+          <div className="min-w-0">
+            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">
+              File đang học
+            </p>
+            <h2 className="mt-1 truncate text-base font-black text-gray-950">
+              {summary.file_name || "File Excel"}
+            </h2>
+            <p className="mt-1 text-xs text-gray-500">
+              {analysis?.target_template_id} · Sheet {summary.sheet_name || "-"}
+            </p>
+          </div>
+        </div>
+
+        <div className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-1 2xl:grid-cols-2">
+          {items.map((item) => (
+            <div
+              key={item.key}
+              className={`rounded-2xl border p-3 ${
+                itemTone[item.key] || "border-slate-100 bg-slate-50 text-gray-900"
+              }`}
+            >
+              <p className="text-[11px] font-semibold text-current/70">{item.label}</p>
+              <p className="mt-1 text-lg font-black leading-tight">{item.value}</p>
+            </div>
+          ))}
+        </div>
+      </section>
+
+      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
+        <div className="flex items-start gap-3">
+          {syncStatus === "unavailable" ? (
+            <AlertTriangle className="mt-0.5 text-amber-600" size={20} />
+          ) : (
+            <ShieldCheck className="mt-0.5 text-emerald-600" size={20} />
+          )}
+          <div>
+            <h3 className="text-sm font-black text-gray-950">Dữ liệu có truy vết</h3>
+            <p className="mt-1 text-xs leading-5 text-gray-500">
+              Mỗi giải thích đều dẫn về cột, ô nguồn hoặc quy tắc. AI không quyết định
+              mapping hay severity.
+            </p>
+          </div>
+        </div>
+        <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
+          <CheckCircle2 size={15} />
+          {analysis?.explanations?.length || 0} giải thích deterministic
+        </div>
+        <button
+          type="button"
+          onClick={onReset}
+          className="btn-secondary mt-4 w-full"
+        >
+          <RefreshCw size={16} /> Phân tích file khác
+        </button>
+      </section>
+    </aside>
+  );
+}
diff --git a/frontend/src/components/student/ExplanationInspector.jsx b/frontend/src/components/student/ExplanationInspector.jsx
new file mode 100755
index 0000000..850fead
--- /dev/null
+++ b/frontend/src/components/student/ExplanationInspector.jsx
@@ -0,0 +1,166 @@
+import * as Dialog from "@radix-ui/react-dialog";
+import { BookOpenCheck, ExternalLink, X } from "lucide-react";
+import { formatStudentEvidenceLabel } from "../../utils/studentAssistant";
+
+const severityTone = {
+  blocker: "bg-red-100 text-red-800",
+  warning: "bg-amber-100 text-amber-800",
+  info: "bg-blue-100 text-blue-800",
+  none: "bg-slate-100 text-slate-700",
+};
+
+function InspectorContent({ explanation, compact = false }) {
+  if (!explanation) {
+    return (
+      <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
+        <BookOpenCheck className="text-slate-300" size={34} />
+        <h2 className="mt-3 text-base font-black text-gray-900">Chọn một mục để hiểu</h2>
+        <p className="mt-1 max-w-xs text-sm leading-6 text-gray-500">
+          Chọn mapping, ô xem trước hoặc lỗi để mở giải thích cùng bằng chứng.
+        </p>
+      </div>
+    );
+  }
+
+  return (
+    <div className={compact ? "max-h-[78vh] overflow-y-auto px-5 pb-7" : "p-5"}>
+      <div className="flex flex-wrap items-center gap-2">
+        <span
+          className={`rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${
+            severityTone[explanation.severity] || severityTone.none
+          }`}
+        >
+          {explanation.severity === "none" ? "Giải thích" : explanation.severity}
+        </span>
+        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
+          Deterministic
+        </span>
+      </div>
+      <h2 className="mt-4 text-xl font-black tracking-tight text-gray-950">
+        {explanation.title}
+      </h2>
+      {explanation.target_field && (
+        <p className="mt-1 text-xs font-bold text-primary-700">
+          Trường đích: {explanation.target_field}
+        </p>
+      )}
+
+      <div className="mt-5 space-y-4 text-sm leading-6">
+        <section>
+          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+            Ý nghĩa
+          </h3>
+          <p className="mt-1 text-gray-700">{explanation.meaning_vi}</p>
+        </section>
+        <section>
+          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+            Vì sao xuất hiện
+          </h3>
+          <p className="mt-1 text-gray-700">{explanation.reason_vi}</p>
+        </section>
+        {explanation.impact_vi && (
+          <section>
+            <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+              Ảnh hưởng
+            </h3>
+            <p className="mt-1 text-gray-700">{explanation.impact_vi}</p>
+          </section>
+        )}
+        {explanation.normalized_value !== null &&
+          explanation.normalized_value !== undefined && (
+            <section className="rounded-2xl bg-slate-50 p-3">
+              <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+                Giá trị sau xử lý
+              </h3>
+              <p className="mt-1 break-words font-mono text-xs text-gray-800">
+                {String(explanation.normalized_value)}
+              </p>
+            </section>
+          )}
+        <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
+          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-emerald-700">
+            Cách kiểm tra / sửa
+          </h3>
+          <p className="mt-1 text-emerald-950">{explanation.fix_hint_vi}</p>
+        </section>
+      </div>
+
+      <section className="mt-6">
+        <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
+          Bằng chứng
+        </h3>
+        <div className="mt-2 space-y-2">
+          {(explanation.evidence || []).map((evidence, index) => (
+            <div
+              key={`${evidence.source_ref}-${index}`}
+              className="rounded-2xl border border-slate-200 bg-white p-3"
+            >
+              <div className="flex items-start justify-between gap-3">
+                <p className="text-xs font-bold leading-5 text-gray-800">
+                  {formatStudentEvidenceLabel(evidence)}
+                </p>
+                {evidence.source_url && (
+                  <a
+                    href={evidence.source_url}
+                    target="_blank"
+                    rel="noreferrer"
+                    aria-label="Mở nguồn quy tắc"
+                    className="shrink-0 text-primary-600 hover:text-primary-800"
+                  >
+                    <ExternalLink size={15} />
+                  </a>
+                )}
+              </div>
+              {evidence.raw_value !== null && evidence.raw_value !== undefined && (
+                <p className="mt-2 break-words rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-gray-600">
+                  {String(evidence.raw_value)}
+                </p>
+              )}
+            </div>
+          ))}
+        </div>
+      </section>
+    </div>
+  );
+}
+
+export default function ExplanationInspector({ explanation, mobileOpen, onMobileOpenChange }) {
+  return (
+    <>
+      <aside
+        className="hidden min-h-[620px] rounded-3xl border border-slate-200 bg-white shadow-card xl:block"
+        aria-label="Trình giải thích"
+      >
+        <InspectorContent explanation={explanation} />
+      </aside>
+
+      <Dialog.Root open={Boolean(explanation) && mobileOpen} onOpenChange={onMobileOpenChange}>
+        <Dialog.Portal>
+          <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/45 backdrop-blur-[2px] xl:hidden" />
+          <Dialog.Content className="fixed inset-x-0 bottom-0 z-[100] max-h-[88vh] rounded-t-[28px] bg-white shadow-2xl xl:hidden">
+            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
+              <div>
+                <Dialog.Title className="text-sm font-black text-gray-950">
+                  Giải thích và bằng chứng
+                </Dialog.Title>
+                <Dialog.Description className="mt-0.5 text-xs text-gray-500">
+                  Cùng contract với inspector trên desktop.
+                </Dialog.Description>
+              </div>
+              <Dialog.Close asChild>
+                <button
+                  type="button"
+                  className="rounded-full p-2 text-gray-500 hover:bg-slate-100"
+                  aria-label="Đóng trình giải thích"
+                >
+                  <X size={20} />
+                </button>
+              </Dialog.Close>
+            </div>
+            <InspectorContent explanation={explanation} compact />
+          </Dialog.Content>
+        </Dialog.Portal>
+      </Dialog.Root>
+    </>
+  );
+}
diff --git a/frontend/src/components/student/StudentMappingTable.jsx b/frontend/src/components/student/StudentMappingTable.jsx
new file mode 100755
index 0000000..ddf960a
--- /dev/null
+++ b/frontend/src/components/student/StudentMappingTable.jsx
@@ -0,0 +1,325 @@
+import { useMemo, useRef, useState } from "react";
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
+export default function StudentMappingTable({ analysis, selectedId, onSelectExplanation }) {
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
+                    selected ? "bg-primary-50" : "hover:bg-slate-50"
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
+                    <td key={header} className="border-b border-slate-100 p-1.5">
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
diff --git a/frontend/src/utils/studentAssistant.js b/frontend/src/utils/studentAssistant.js
new file mode 100755
index 0000000..eb87a1c
--- /dev/null
+++ b/frontend/src/utils/studentAssistant.js
@@ -0,0 +1,276 @@
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
index 0000000..cbd07fb
--- /dev/null
+++ b/frontend/src/utils/studentAssistant.test.mjs
@@ -0,0 +1,203 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+import {
+  formatStudentEvidenceLabel,
+  findStudentExplanation,
+  getStudentSummaryItems,
+  getNextStudentTabId,
+  keepCurrentExplanationSelection,
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
