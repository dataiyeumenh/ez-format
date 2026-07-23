# Phase 0 Tasks 3-5 review package - final
## backend/server.js relevant current state
     1	const express = require("express");
     2	const cors = require("cors");
     3	const dotenv = require("dotenv");
     4	const crypto = require("crypto");
     5	const connectDB = require("./config/db");
     6	const {
     7	  migrateMappingProfileOwnerScope,
     8	} = require("./services/mappingProfileMigrationService");
     9	const { getRevenue } = require("./controllers/adminController");
    10	const { protect, adminOnly } = require("./middleware/auth");
    11	const requireDb = require("./middleware/requireDb");
    12	
    13	require("dotenv").config();
    14	
    15	console.log("[BOOT] NODE_ENV:", process.env.NODE_ENV);
    16	console.log("[BOOT] PORT:", process.env.PORT);
    17	console.log("[BOOT] FRONTEND_URL:", process.env.FRONTEND_URL);
    18	console.log("[BOOT] FRONTEND_URL_WWW:", process.env.FRONTEND_URL_WWW);
    19	
    20	const app = express();
    21	const masterDataWorkspacesEnabled =
    22	  String(process.env.MASTER_DATA_WORKSPACES_ENABLED || "true").toLowerCase() !==
    23	  "false";
    24	const voucherReconstructionEnabled =
    25	  String(process.env.VOUCHER_RECONSTRUCTION_ENABLED || "false").toLowerCase() ===
    26	  "true";
    27	const studentAssistantEnabled =
    28	  String(process.env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
    29	
    30	// CORS config: allow localhost for dev + Vercel production URL
    31	const allowedOrigins = [
    32	  "http://localhost:5173", // Dev Vite
    33	  "http://127.0.0.1:5173", // Dev Vite via explicit loopback host
    34	  "http://localhost:3000", // Dev alternative
    35	  "http://127.0.0.1:3000", // Dev alternative via explicit loopback host
    36	  process.env.FRONTEND_URL, // Production (e.g., https://ezformat.io.vn)
    37	  process.env.FRONTEND_URL_WWW, // www variant (e.g., https://www.ezformat.io.vn)
    38	].filter(Boolean);
    39	
    40	console.log("[CORS] Allowed origins:", allowedOrigins);
    41	
    42	app.use(
    43	  cors({
    44	    origin: allowedOrigins,
    45	    credentials: true,
    46	    exposedHeaders: ["X-Request-ID"],
    47	  }),
    48	);
    49	app.use((req, res, next) => {
    50	  const supplied = String(req.headers["x-request-id"] || "").trim();
    51	  req.requestId = supplied.slice(0, 128) || crypto.randomUUID();
    52	  res.setHeader("X-Request-ID", req.requestId);
    53	  next();
    54	});
    55	app.use(express.json({ limit: "50mb" }));
    56	app.use(express.urlencoded({ extended: true, limit: "50mb" }));
    57	
    58	// Routes
    59	app.use("/api/auth", require("./routes/auth"));
    60	app.use("/api/plans", require("./routes/plans"));
    61	app.use("/api/admin", require("./routes/admin"));
    62	app.use("/api/convert", require("./routes/convert"));
    63	app.use("/api/conversion-runs", require("./routes/conversionRuns"));
    64	app.use("/api/payments", require("./routes/payments"));
    65	app.use("/api/feedback", require("./routes/feedback"));
    66	if (masterDataWorkspacesEnabled) {
    67	  app.use(
    68	    "/api/accounting-workspaces",
    69	    require("./routes/accountingWorkspaces"),
    70	  );
    71	}
    72	if (voucherReconstructionEnabled) {
    73	  app.use("/api/reconstructions", require("./routes/reconstructions"));
    74	}
    75	if (studentAssistantEnabled) {
    76	  app.use("/api/student", require("./routes/student"));
    77	}
    78	if (masterDataWorkspacesEnabled || voucherReconstructionEnabled) {
    79	  app.use("/api/internal", require("./routes/internal"));
    80	}
    81	
    82	// Backward-compatible alias for older admin revenue bundles.
    83	app.get("/api/revenue", requireDb, protect, adminOnly, getRevenue);
    84	app.get("/admin/revenue", requireDb, protect, adminOnly, getRevenue);
    85	
    86	// Health check
    87	app.get("/api/health", (req, res) => {
    88	  res.json({
    89	    status: "OK",
    90	    message: "EzFormat API is running",
    91	    capabilities: {
    92	      masterDataWorkspaces: masterDataWorkspacesEnabled,
    93	      voucherReconstruction: voucherReconstructionEnabled,
    94	      studentAssistant: studentAssistantEnabled,
    95	    },
    96	  });
    97	});
    98	
    99	const PORT = process.env.PORT || 5000;
   100	
   101	async function startServer() {
   102	  await connectDB();
   103	  const migration = await migrateMappingProfileOwnerScope();
   104	  if (!migration.skipped) {
   105	    console.log(
   106	      `[DB] MappingProfile owner migration: ${migration.backfilled} backfilled, ${migration.droppedIndexes.length} obsolete index(es) dropped`,
   107	    );
   108	  }
   109	  return app.listen(PORT, () => {
   110	    console.log(`Server running on port ${PORT}`);
   111	  });
   112	}
   113	
   114	if (require.main === module) {
   115	  startServer().catch((error) => {
   116	    console.error("[BOOT] Server startup failed:", error.message);
   117	    process.exit(1);
   118	  });
   119	}
   120	
   121	module.exports = { app, startServer };
diff --git a/backend/controllers/accountingWorkspaceController.js b/backend/controllers/accountingWorkspaceController.js
index 2634cec..1be0194 100644
--- a/backend/controllers/accountingWorkspaceController.js
+++ b/backend/controllers/accountingWorkspaceController.js
@@ -19,10 +19,12 @@ const {
 const {
   createConversionContextToken,
   verifyConversionContextToken,
+  verifyStudentContextToken,
 } = require("../services/conversionContextService");
 const { parseMasterDataFile } = require("../services/converterClient");
 const {
   cleanMappingProfilePayload,
+  mappingProfileOwnerFromClaims,
   serializeMappingProfile,
 } = require("../services/mappingProfileService");
 
@@ -41,7 +43,7 @@ function secureTokenEquals(actual, expected) {
   );
 }
 
-function authenticateInternalContext(req) {
+function authenticateInternalContext(req, requiredStudentScope = "analyze") {
   const expectedServiceToken = String(
     process.env.CONVERTER_SERVICE_TOKEN || "",
   ).trim();
@@ -60,8 +62,12 @@ function authenticateInternalContext(req) {
   if (!contextToken) throw httpError(401, "Thiếu conversion context");
   try {
     return verifyConversionContextToken(contextToken);
-  } catch (error) {
-    throw httpError(401, error.message);
+  } catch (conversionError) {
+    try {
+      return verifyStudentContextToken(contextToken, requiredStudentScope);
+    } catch (studentError) {
+      throw httpError(401, studentError.message || conversionError.message);
+    }
   }
 }
 
@@ -74,6 +80,17 @@ async function internalWorkspaceFromClaims(claims) {
   return workspace;
 }
 
+async function mappingProfileAccessFromClaims(claims, { requireEdit = false } = {}) {
+  const owner = mappingProfileOwnerFromClaims(claims);
+  if (!owner.workspaceId) return { ...owner, workspace: null };
+
+  const workspace = await internalWorkspaceFromClaims(claims);
+  if (requireEdit && !userCanEditWorkspace(workspace, owner.userId)) {
+    throw httpError(403, "Bạn không có quyền lưu mapping profile");
+  }
+  return { ...owner, workspace };
+}
+
 async function assertCurrentMasterDataContext(claims, requestedHash) {
   if (claims.snapshot_set_hash !== requestedHash) {
     throw httpError(409, "Snapshot context không khớp");
@@ -649,7 +666,7 @@ async function createConversionContext(req, res) {
 
 async function getInternalMasterDataContext(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
+    const claims = authenticateInternalContext(req, "analyze");
     const { workspace, snapshots } = await assertCurrentMasterDataContext(
       claims,
       req.params.snapshotSetHash,
@@ -673,7 +690,7 @@ async function getInternalMasterDataContext(req, res) {
 
 async function validateInternalMasterDataContext(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
+    const claims = authenticateInternalContext(req, "analyze");
     const { workspace } = await assertCurrentMasterDataContext(
       claims,
       req.params.snapshotSetHash,
@@ -691,8 +708,8 @@ async function validateInternalMasterDataContext(req, res) {
 
 async function findInternalMappingProfile(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
-    const workspace = await internalWorkspaceFromClaims(claims);
+    const claims = authenticateInternalContext(req, "analyze");
+    const owner = await mappingProfileAccessFromClaims(claims);
     const targetTemplateId = String(req.query.targetTemplateId || "").trim();
     const sourceSignatureHash = String(
       req.query.sourceSignatureHash || "",
@@ -701,7 +718,7 @@ async function findInternalMappingProfile(req, res) {
       throw httpError(400, "Thiếu targetTemplateId hoặc sourceSignatureHash");
     }
     const profile = await MappingProfile.findOne({
-      workspace: workspace._id,
+      ownerScope: owner.ownerScope,
       targetTemplateId,
       sourceSignatureHash,
     });
@@ -716,12 +733,12 @@ async function findInternalMappingProfile(req, res) {
 
 async function getInternalMappingProfile(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
-    const workspace = await internalWorkspaceFromClaims(claims);
+    const claims = authenticateInternalContext(req, "export");
+    const owner = await mappingProfileAccessFromClaims(claims);
     const profile = mongoose.isValidObjectId(req.params.profileId)
       ? await MappingProfile.findOne({
           _id: req.params.profileId,
-          workspace: workspace._id,
+          ownerScope: owner.ownerScope,
         })
       : null;
     if (!profile) throw httpError(404, "Không tìm thấy mapping profile");
@@ -736,11 +753,10 @@ async function getInternalMappingProfile(req, res) {
 
 async function saveInternalMappingProfile(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
-    const workspace = await internalWorkspaceFromClaims(claims);
-    if (!userCanEditWorkspace(workspace, claims.user_id)) {
-      throw httpError(403, "Bạn không có quyền lưu mapping profile");
-    }
+    const claims = authenticateInternalContext(req, "attempt");
+    const owner = await mappingProfileAccessFromClaims(claims, {
+      requireEdit: true,
+    });
     const payload = cleanMappingProfilePayload(req.body);
     if (!payload.targetTemplateId || !payload.sourceSignatureHash) {
       throw httpError(
@@ -750,15 +766,17 @@ async function saveInternalMappingProfile(req, res) {
     }
     const profile = await MappingProfile.findOneAndUpdate(
       {
-        workspace: workspace._id,
+        ownerScope: owner.ownerScope,
         targetTemplateId: payload.targetTemplateId,
         sourceSignatureHash: payload.sourceSignatureHash,
       },
       {
         $set: {
           ...payload,
-          workspace: workspace._id,
-          updatedBy: claims.user_id,
+          ownerScope: owner.ownerScope,
+          workspace: owner.workspace?._id || null,
+          user: owner.userId,
+          updatedBy: owner.userId,
         },
         $setOnInsert: { usageCount: 0 },
       },
@@ -780,11 +798,11 @@ async function saveInternalMappingProfile(req, res) {
 
 async function markInternalMappingProfileUsed(req, res) {
   try {
-    const claims = authenticateInternalContext(req);
-    const workspace = await internalWorkspaceFromClaims(claims);
+    const claims = authenticateInternalContext(req, "analyze");
+    const owner = await mappingProfileAccessFromClaims(claims);
     const profile = mongoose.isValidObjectId(req.params.profileId)
       ? await MappingProfile.findOneAndUpdate(
-          { _id: req.params.profileId, workspace: workspace._id },
+          { _id: req.params.profileId, ownerScope: owner.ownerScope },
           { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
           { new: true },
         )
diff --git a/backend/models/MappingProfile.js b/backend/models/MappingProfile.js
index f3b641f..4176a01 100644
--- a/backend/models/MappingProfile.js
+++ b/backend/models/MappingProfile.js
@@ -2,10 +2,26 @@ const mongoose = require("mongoose");
 
 const mappingProfileSchema = new mongoose.Schema(
   {
+    ownerScope: {
+      type: String,
+      required: [true, "Mapping profile owner scope là bắt buộc"],
+      trim: true,
+      validate: {
+        validator: (value) => Boolean(String(value || "").trim()),
+        message: "Mapping profile owner scope là bắt buộc",
+      },
+      index: true,
+    },
     workspace: {
       type: mongoose.Schema.Types.ObjectId,
       ref: "AccountingWorkspace",
-      required: true,
+      default: null,
+      index: true,
+    },
+    user: {
+      type: mongoose.Schema.Types.ObjectId,
+      ref: "User",
+      default: null,
       index: true,
     },
     name: {
@@ -74,11 +90,11 @@ const mappingProfileSchema = new mongoose.Schema(
       required: true,
     },
   },
-  { timestamps: true },
+  { timestamps: true, autoIndex: false },
 );
 
 mappingProfileSchema.index(
-  { workspace: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
+  { ownerScope: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
   { unique: true },
 );
 
diff --git a/backend/services/conversionContextService.js b/backend/services/conversionContextService.js
index ddcb82f..0860125 100644
--- a/backend/services/conversionContextService.js
+++ b/backend/services/conversionContextService.js
@@ -1,5 +1,7 @@
 const jwt = require("jsonwebtoken");
 
+const MAX_STUDENT_CONTEXT_LIFETIME_SECONDS = 24 * 60 * 60;
+
 function contextSecret() {
   const secret =
     process.env.CONVERSION_CONTEXT_SECRET || process.env.JWT_SECRET;
@@ -74,9 +76,89 @@ function verifyReconstructionContextToken(token, requiredScope = null) {
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
+  const claims = jwt.verify(token, contextSecret(), { algorithms: ["HS256"] });
+  if (claims.purpose !== "student_file_session") {
+    throw new Error("Student context token không hợp lệ");
+  }
+  if (
+    typeof claims.exp !== "number" ||
+    !Number.isFinite(claims.exp) ||
+    claims.exp <= Math.floor(Date.now() / 1000)
+  ) {
+    throw new Error("Student context exp phải là thời điểm tương lai");
+  }
+  if (!Array.isArray(claims.allowed_scopes)) {
+    throw new Error("Student context scopes không hợp lệ");
+  }
+  if (!claims.allowed_scopes.includes(normalizedRequiredScope)) {
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
diff --git a/backend/services/mappingProfileService.js b/backend/services/mappingProfileService.js
index c0dd47d..b01c651 100644
--- a/backend/services/mappingProfileService.js
+++ b/backend/services/mappingProfileService.js
@@ -4,6 +4,47 @@ function objectValue(value) {
     : {};
 }
 
+function optionalId(value) {
+  if (value == null) return null;
+  const normalized = String(value?._id || value).trim();
+  return normalized || null;
+}
+
+function mappingProfileOwnerFromClaims(claims = {}) {
+  const purpose = String(claims.purpose || "");
+  const userId = optionalId(claims.user_id);
+  const workspaceId = optionalId(claims.workspace_id);
+
+  if (purpose === "student_file_session") {
+    const sessionId = String(claims.session_id || "").trim();
+    const ownerScope = String(claims.owner_scope || "").trim();
+    if (!sessionId || !userId || !ownerScope) {
+      throw new Error("Student context thiếu session, user hoặc owner scope");
+    }
+    if (
+      (ownerScope.startsWith("workspace:") &&
+        ownerScope !== `workspace:${workspaceId || ""}`) ||
+      (ownerScope.startsWith("user:") && ownerScope !== `user:${userId}`) ||
+      (!ownerScope.startsWith("workspace:") && !ownerScope.startsWith("user:"))
+    ) {
+      throw new Error("Student context owner scope không hợp lệ");
+    }
+    return { ownerScope, userId, workspaceId };
+  }
+
+  if (!["misa_conversion", "misa_reconstruction"].includes(purpose)) {
+    throw new Error("Conversion context token không hợp lệ");
+  }
+  if (!workspaceId || !userId) {
+    throw new Error("Conversion context thiếu workspace hoặc user");
+  }
+  return {
+    ownerScope: `workspace:${workspaceId}`,
+    userId,
+    workspaceId,
+  };
+}
+
 function cleanMappingProfilePayload(body = {}) {
   return {
     name: String(body.name || "Thiết lập ghép cột")
@@ -31,7 +72,9 @@ function cleanMappingProfilePayload(body = {}) {
 function serializeMappingProfile(profile) {
   return {
     id: String(profile._id || profile.id),
-    workspaceId: String(profile.workspace?._id || profile.workspace),
+    ownerScope: String(profile.ownerScope || ""),
+    workspaceId: optionalId(profile.workspace),
+    userId: optionalId(profile.user),
     name: profile.name,
     targetTemplateId: profile.targetTemplateId,
     sourceSignatureHash: profile.sourceSignatureHash,
@@ -51,5 +94,6 @@ function serializeMappingProfile(profile) {
 
 module.exports = {
   cleanMappingProfilePayload,
+  mappingProfileOwnerFromClaims,
   serializeMappingProfile,
 };
diff --git a/backend/tests/mappingProfiles.test.js b/backend/tests/mappingProfiles.test.js
index a090bb1..8dd80fa 100644
--- a/backend/tests/mappingProfiles.test.js
+++ b/backend/tests/mappingProfiles.test.js
@@ -5,20 +5,28 @@ const mongoose = require("mongoose");
 const MappingProfile = require("../models/MappingProfile");
 const {
   authenticateInternalContext,
+  findInternalMappingProfile,
+  getInternalMappingProfile,
+  markInternalMappingProfileUsed,
+  saveInternalMappingProfile,
 } = require("../controllers/accountingWorkspaceController");
 const {
   createConversionContextToken,
+  createStudentContextToken,
 } = require("../services/conversionContextService");
 const {
   cleanMappingProfilePayload,
   serializeMappingProfile,
 } = require("../services/mappingProfileService");
 
-test("mapping profile is scoped by workspace, template and source signature", () => {
+test("mapping profile is scoped by owner, template and source signature", () => {
+  assert.equal(MappingProfile.schema.options.autoIndex, false);
   const workspace = new mongoose.Types.ObjectId();
   const user = new mongoose.Types.ObjectId();
   const profile = new MappingProfile({
+    ownerScope: `workspace:${workspace}`,
     workspace,
+    user,
     updatedBy: user,
     name: "KiotViet mua hàng",
     targetTemplateId: "misa_purchase_domestic",
@@ -32,12 +40,23 @@ test("mapping profile is scoped by workspace, template and source signature", ()
     .indexes()
     .find(
       ([fields, options]) =>
-        fields.workspace === 1 &&
+        fields.ownerScope === 1 &&
         fields.targetTemplateId === 1 &&
         fields.sourceSignatureHash === 1 &&
         options.unique,
-    );
+  );
   assert.ok(uniqueIndex);
+
+  const missingOwner = new MappingProfile({
+    updatedBy: user,
+    name: "Missing owner",
+    targetTemplateId: "misa_purchase_domestic",
+    sourceSignatureHash: "signature-2",
+  });
+  assert.match(
+    missingOwner.validateSync().errors.ownerScope.message,
+    /owner scope/i,
+  );
 });
 
 test("mapping profile payload drops unsupported values and serializes safely", () => {
@@ -59,11 +78,182 @@ test("mapping profile payload drops unsupported values and serializes safely", (
 
   const serialized = serializeMappingProfile({
     _id: "profile-1",
+    ownerScope: "workspace:workspace-1",
     workspace: "workspace-1",
+    user: "user-1",
     ...payload,
   });
   assert.equal(serialized.id, "profile-1");
+  assert.equal(serialized.ownerScope, "workspace:workspace-1");
   assert.equal(serialized.workspaceId, "workspace-1");
+  assert.equal(serialized.userId, "user-1");
+});
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
+      return this;
+    },
+  };
+}
+
+function internalRequest(token, overrides = {}) {
+  return {
+    headers: {
+      "x-converter-service-token": "service-secret",
+      "x-conversion-context": token,
+    },
+    params: {},
+    query: {},
+    body: {},
+    ...overrides,
+  };
+}
+
+test("mapping profile lookup/get/save/use stay bound to the signed student owner", async () => {
+  const previousContextSecret = process.env.CONVERSION_CONTEXT_SECRET;
+  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
+  const originalFindOne = MappingProfile.findOne;
+  const originalFindOneAndUpdate = MappingProfile.findOneAndUpdate;
+  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
+  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
+
+  const profileId = new mongoose.Types.ObjectId().toString();
+  const ownerA = "user:user-a";
+  const ownerB = "user:user-b";
+  const storedProfile = {
+    _id: profileId,
+    ownerScope: ownerA,
+    user: "user-a",
+    workspace: null,
+    name: "Student mapping",
+    targetTemplateId: "bsn_purchase",
+    sourceSignatureHash: "signature-1",
+  };
+  const findFilters = [];
+  const updateCalls = [];
+  MappingProfile.findOne = async (filter) => {
+    findFilters.push(filter);
+    return filter.ownerScope === ownerA ? storedProfile : null;
+  };
+  MappingProfile.findOneAndUpdate = async (filter, update) => {
+    updateCalls.push({ filter, update });
+    return filter.ownerScope === ownerA ? { ...storedProfile, ...update.$set } : null;
+  };
+
+  const tokenFor = (userId, ownerScope, allowedScopes) =>
+    createStudentContextToken({
+      sessionId: `session-${userId}`,
+      userId,
+      ownerScope,
+      allowedScopes,
+    });
+
+  try {
+    const analyzeA = tokenFor("user-a", ownerA, ["analyze"]);
+    const analyzeB = tokenFor("user-b", ownerB, ["analyze"]);
+    const attemptA = tokenFor("user-a", ownerA, ["attempt"]);
+    const exportA = tokenFor("user-a", ownerA, ["export"]);
+    const exportB = tokenFor("user-b", ownerB, ["export"]);
+
+    const findA = responseRecorder();
+    await findInternalMappingProfile(
+      internalRequest(analyzeA, {
+        query: {
+          targetTemplateId: "bsn_purchase",
+          sourceSignatureHash: "signature-1",
+        },
+      }),
+      findA,
+    );
+    assert.equal(findA.statusCode, 200);
+    assert.equal(findA.body.profile.ownerScope, ownerA);
+
+    const findB = responseRecorder();
+    await findInternalMappingProfile(
+      internalRequest(analyzeB, {
+        query: {
+          targetTemplateId: "bsn_purchase",
+          sourceSignatureHash: "signature-1",
+        },
+      }),
+      findB,
+    );
+    assert.equal(findB.body.profile, null);
+
+    const getA = responseRecorder();
+    await getInternalMappingProfile(
+      internalRequest(exportA, { params: { profileId } }),
+      getA,
+    );
+    assert.equal(getA.statusCode, 200);
+    assert.equal(getA.body.profile.ownerScope, ownerA);
+
+    const getB = responseRecorder();
+    await getInternalMappingProfile(
+      internalRequest(exportB, { params: { profileId } }),
+      getB,
+    );
+    assert.equal(getB.statusCode, 404);
+
+    const deniedSave = responseRecorder();
+    await saveInternalMappingProfile(
+      internalRequest(analyzeA, {
+        body: {
+          name: "Denied student mapping",
+          targetTemplateId: "bsn_purchase",
+          sourceSignatureHash: "signature-1",
+        },
+      }),
+      deniedSave,
+    );
+    assert.equal(deniedSave.statusCode, 401);
+    assert.equal(updateCalls.length, 0);
+
+    const saveA = responseRecorder();
+    await saveInternalMappingProfile(
+      internalRequest(attemptA, {
+        body: {
+          name: "Student mapping",
+          targetTemplateId: "bsn_purchase",
+          sourceSignatureHash: "signature-1",
+          mapping: { Source: "Target" },
+        },
+      }),
+      saveA,
+    );
+    assert.equal(saveA.statusCode, 201);
+    assert.equal(updateCalls.at(-1).filter.ownerScope, ownerA);
+    assert.equal(updateCalls.at(-1).update.$set.ownerScope, ownerA);
+    assert.equal(updateCalls.at(-1).update.$set.user, "user-a");
+    assert.equal(updateCalls.at(-1).update.$set.workspace, null);
+
+    const usedB = responseRecorder();
+    await markInternalMappingProfileUsed(
+      internalRequest(analyzeB, { params: { profileId } }),
+      usedB,
+    );
+    assert.equal(usedB.statusCode, 404);
+
+    assert.ok(findFilters.every((filter) => filter.ownerScope));
+    assert.ok(updateCalls.every(({ filter }) => filter.ownerScope));
+  } finally {
+    MappingProfile.findOne = originalFindOne;
+    MappingProfile.findOneAndUpdate = originalFindOneAndUpdate;
+    if (previousContextSecret === undefined)
+      delete process.env.CONVERSION_CONTEXT_SECRET;
+    else process.env.CONVERSION_CONTEXT_SECRET = previousContextSecret;
+    if (previousServiceToken === undefined)
+      delete process.env.CONVERTER_SERVICE_TOKEN;
+    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
+  }
 });
 
 test("internal context requires service token and verifies conversion claims", () => {
diff --git a/converter/.env.example b/converter/.env.example
index 62f59ba..73c8e08 100644
--- a/converter/.env.example
+++ b/converter/.env.example
@@ -32,6 +32,19 @@ NODE_INTERNAL_API_URL=http://127.0.0.1:5000/api/internal
 MASTER_DATA_CONTEXT_TIMEOUT_SECONDS=15
 MASTER_DATA_CONTEXT_CACHE_SECONDS=300
 MAPPING_PROFILE_TIMEOUT_SECONDS=15
+LOCAL_MAPPING_OWNER_SCOPE=local:default
+
+# Student assistant rollback gates. Existing converter routes remain available
+# when these flags are false.
+STUDENT_ASSISTANT_ENABLED=false
+STUDENT_FILE_EXPLAIN_ENABLED=false
+STUDENT_FILE_QA_ENABLED=false
+STUDENT_CHECK_WORK_ENABLED=false
+STUDENT_ACCOUNTING_MAP_ENABLED=false
+STUDENT_RECONCILIATION_ENABLED=false
+STUDENT_INTERNSHIP_ENABLED=false
+STUDENT_UPLOAD_RETENTION_SECONDS=86400
+STUDENT_UPLOAD_CLEANUP_INTERVAL_SECONDS=300
 
 # Smart voucher reconstruction (Phase 3)
 VOUCHER_RECONSTRUCTION_ENABLED=false
diff --git a/converter/app/main.py b/converter/app/main.py
index d51c5d4..cc680f8 100644
--- a/converter/app/main.py
+++ b/converter/app/main.py
@@ -56,15 +56,43 @@ from app.reconstruction_workflow import (
     update_reconstruction_draft,
     validate_reconstruction,
 )
+from app.student_store import cleanup_expired_student_uploads
 
 
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
@@ -208,6 +236,7 @@ async def analyze_raw_upload(
     file: Annotated[UploadFile, File()],
     target_template_id: Annotated[str | None, Form()] = None,
     conversion_context_token: Annotated[str | None, Form()] = None,
+    student_context_token: Annotated[str | None, Form()] = None,
 ) -> JSONResponse:
     try:
         content = await file.read()
@@ -217,6 +246,7 @@ async def analyze_raw_upload(
             content=content,
             requested_target_template_id=target_template_id,
             conversion_context_token=conversion_context_token,
+            student_context_token=student_context_token,
         )
         return JSONResponse(jsonable_encoder(payload))
     except ValueError as exc:
@@ -474,6 +504,7 @@ async def preview_misa_mapping(body: dict) -> JSONResponse:
             defaults=body.get("defaults") or {},
             formulas=body.get("formulas") or {},
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -495,6 +526,7 @@ async def readiness_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             edited_rows=edited_rows if isinstance(edited_rows, list) else None,
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -515,6 +547,7 @@ async def confirm_misa_mapping(body: dict) -> JSONResponse:
             formulas=body.get("formulas") or {},
             profile_name=body.get("profile_name"),
             conversion_context_token=body.get("conversion_context_token"),
+            student_context_token=body.get("student_context_token"),
         )
         return JSONResponse(jsonable_encoder(payload))
     except KeyError as exc:
@@ -579,6 +612,7 @@ async def export_conversion_rows(body: dict) -> Response:
                 edited_rows=edited_rows if isinstance(edited_rows, list) and edited_rows else None,
                 acknowledge_warnings=bool(body.get("acknowledge_warnings")),
                 conversion_context_token=body.get("conversion_context_token"),
+                student_context_token=body.get("student_context_token"),
             )
         except KeyError as exc:
             raise HTTPException(status_code=404, detail=str(exc)) from exc
diff --git a/converter/app/mapping_profile_client.py b/converter/app/mapping_profile_client.py
index 6667d4f..1993523 100644
--- a/converter/app/mapping_profile_client.py
+++ b/converter/app/mapping_profile_client.py
@@ -128,6 +128,10 @@ def _request(
 
 
 def _profile_from_payload(payload: dict[str, Any]) -> MappingProfile:
+    workspace_id = str(payload.get("workspaceId") or "")
+    owner_scope = str(payload.get("ownerScope") or "").strip()
+    if not owner_scope and workspace_id:
+        owner_scope = f"workspace:{workspace_id}"
     return MappingProfile(
         id=str(payload.get("id") or ""),
         name=str(payload.get("name") or ""),
@@ -141,5 +145,6 @@ def _profile_from_payload(payload: dict[str, Any]) -> MappingProfile:
         formulas=dict(payload.get("formulas") or {}),
         confidence=float(payload.get("confidence") or 0),
         usage_count=int(payload.get("usageCount") or 0),
-        workspace_id=str(payload.get("workspaceId") or ""),
+        owner_scope=owner_scope,
+        workspace_id=workspace_id,
     )
diff --git a/converter/app/misa_profiles.py b/converter/app/misa_profiles.py
index 4ed9732..bc40af9 100644
--- a/converter/app/misa_profiles.py
+++ b/converter/app/misa_profiles.py
@@ -23,6 +23,26 @@ def utc_now() -> str:
     return datetime.now(timezone.utc).isoformat()
 
 
+def local_mapping_owner_scope() -> str:
+    return os.getenv("LOCAL_MAPPING_OWNER_SCOPE", "local:default").strip() or "local:default"
+
+
+def resolve_owner_scope(
+    owner_scope: str | None = None,
+    *,
+    workspace_id: str = "",
+) -> str:
+    if owner_scope is not None:
+        normalized = str(owner_scope).strip()
+        if not normalized:
+            raise ValueError("Mapping profile owner_scope must not be empty")
+        return normalized
+    normalized_workspace = str(workspace_id or "").strip()
+    if normalized_workspace:
+        return f"workspace:{normalized_workspace}"
+    return local_mapping_owner_scope()
+
+
 @dataclass(frozen=True)
 class MappingProfile:
     id: str
@@ -37,6 +57,7 @@ class MappingProfile:
     formulas: dict[str, Any]
     confidence: float
     usage_count: int
+    owner_scope: str = ""
     workspace_id: str = ""
 
 
@@ -68,6 +89,8 @@ class ProfileStore:
                     formulas_json TEXT NOT NULL,
                     confidence REAL NOT NULL,
                     usage_count INTEGER NOT NULL DEFAULT 0,
+                    owner_scope TEXT NOT NULL CHECK (length(trim(owner_scope)) > 0),
+                    workspace_id TEXT NOT NULL DEFAULT '',
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
@@ -100,10 +123,55 @@ class ProfileStore:
                 connection.execute(
                     "ALTER TABLE mapping_profiles ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''"
                 )
+            owner_scope_added = "owner_scope" not in columns
+            if owner_scope_added:
+                connection.execute(
+                    "ALTER TABLE mapping_profiles ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'local:legacy'"
+                )
+            if owner_scope_added:
+                connection.execute(
+                    """
+                    UPDATE mapping_profiles
+                    SET owner_scope = CASE
+                        WHEN length(trim(workspace_id)) > 0
+                            THEN 'workspace:' || trim(workspace_id)
+                        ELSE 'local:legacy'
+                    END
+                    """
+                )
+            else:
+                connection.execute(
+                    """
+                    UPDATE mapping_profiles
+                    SET owner_scope = CASE
+                        WHEN length(trim(workspace_id)) > 0
+                            THEN 'workspace:' || trim(workspace_id)
+                        ELSE 'local:legacy'
+                    END
+                    WHERE length(trim(owner_scope)) = 0
+                    """
+                )
             connection.execute(
                 """
-                CREATE INDEX IF NOT EXISTS idx_mapping_profiles_workspace_signature
-                ON mapping_profiles(workspace_id, target_template_id, source_signature_hash)
+                CREATE INDEX IF NOT EXISTS idx_mapping_profiles_owner_signature
+                ON mapping_profiles(owner_scope, target_template_id, source_signature_hash)
+                """
+            )
+            connection.executescript(
+                """
+                CREATE TRIGGER IF NOT EXISTS mapping_profiles_owner_scope_insert
+                BEFORE INSERT ON mapping_profiles
+                WHEN length(trim(NEW.owner_scope)) = 0
+                BEGIN
+                    SELECT RAISE(ABORT, 'mapping_profiles.owner_scope must not be empty');
+                END;
+
+                CREATE TRIGGER IF NOT EXISTS mapping_profiles_owner_scope_update
+                BEFORE UPDATE OF owner_scope ON mapping_profiles
+                WHEN length(trim(NEW.owner_scope)) = 0
+                BEGIN
+                    SELECT RAISE(ABORT, 'mapping_profiles.owner_scope must not be empty');
+                END;
                 """
             )
 
@@ -112,18 +180,29 @@ class ProfileStore:
         *,
         target_template_id: str,
         source_signature_hash: str,
+        owner_scope: str | None = None,
         workspace_id: str = "",
     ) -> MappingProfile | None:
+        resolved_owner_scope = resolve_owner_scope(
+            owner_scope,
+            workspace_id=workspace_id,
+        )
         with self._connect() as connection:
             row = connection.execute(
                 """
                 SELECT * FROM mapping_profiles
-                WHERE workspace_id = ? AND target_template_id = ? AND source_signature_hash = ?
+                WHERE owner_scope = ? AND target_template_id = ? AND source_signature_hash = ?
                 ORDER BY updated_at DESC
                 LIMIT 1
                 """,
-                (workspace_id, target_template_id, source_signature_hash),
+                (resolved_owner_scope, target_template_id, source_signature_hash),
             ).fetchone()
+            if row is None and resolved_owner_scope == "local:default":
+                row = self._claim_legacy_profile_by_signature(
+                    connection,
+                    target_template_id=target_template_id,
+                    source_signature_hash=source_signature_hash,
+                )
         return self._row_to_profile(row) if row else None
 
     def save_profile(
@@ -140,12 +219,17 @@ class ProfileStore:
         formulas: dict[str, Any],
         confidence: float,
         previous: dict[str, Any] | None = None,
+        owner_scope: str | None = None,
         workspace_id: str = "",
     ) -> MappingProfile:
+        resolved_owner_scope = resolve_owner_scope(
+            owner_scope,
+            workspace_id=workspace_id,
+        )
         existing = self.find_by_signature(
             target_template_id=target_template_id,
             source_signature_hash=source_signature_hash,
-            workspace_id=workspace_id,
+            owner_scope=resolved_owner_scope,
         )
         now = utc_now()
         profile_id = existing.id if existing else str(uuid.uuid4())
@@ -176,15 +260,16 @@ class ProfileStore:
                 connection.execute(
                     """
                     INSERT INTO mapping_profiles (
-                        id, name, workspace_id, target_template_id, source_signature_hash,
+                        id, name, owner_scope, workspace_id, target_template_id, source_signature_hash,
                         source_headers_json, sheet_name, header_row, mapping_json,
                         defaults_json, formulas_json, confidence, usage_count,
                         created_at, updated_at
-                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
+                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                     """,
                     (
                         profile_id,
                         name,
+                        resolved_owner_scope,
                         workspace_id,
                         target_template_id,
                         source_signature_hash,
@@ -221,27 +306,103 @@ class ProfileStore:
                         now,
                     ),
                 )
-        return self.get_profile(profile_id)
+        return self.get_profile(profile_id, owner_scope=resolved_owner_scope)
 
-    def get_profile(self, profile_id: str) -> MappingProfile:
+    def get_profile(
+        self,
+        profile_id: str,
+        *,
+        owner_scope: str | None = None,
+        workspace_id: str = "",
+    ) -> MappingProfile:
+        resolved_owner_scope = resolve_owner_scope(
+            owner_scope,
+            workspace_id=workspace_id,
+        )
         with self._connect() as connection:
             row = connection.execute(
-                "SELECT * FROM mapping_profiles WHERE id = ?", (profile_id,)
+                "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = ?",
+                (profile_id, resolved_owner_scope),
             ).fetchone()
+            if row is None and resolved_owner_scope == "local:default":
+                row = self._claim_legacy_profile_by_id(connection, profile_id)
         if not row:
             raise KeyError(f"Mapping profile not found: {profile_id}")
         return self._row_to_profile(row)
 
-    def mark_used(self, profile_id: str) -> None:
+    def mark_used(
+        self,
+        profile_id: str,
+        *,
+        owner_scope: str | None = None,
+        workspace_id: str = "",
+    ) -> None:
+        resolved_owner_scope = resolve_owner_scope(
+            owner_scope,
+            workspace_id=workspace_id,
+        )
         with self._connect() as connection:
-            connection.execute(
+            cursor = connection.execute(
                 """
                 UPDATE mapping_profiles
                 SET usage_count = usage_count + 1, updated_at = ?
-                WHERE id = ?
+                WHERE id = ? AND owner_scope = ?
                 """,
-                (utc_now(), profile_id),
+                (utc_now(), profile_id, resolved_owner_scope),
             )
+            if cursor.rowcount != 1:
+                raise KeyError(f"Mapping profile not found: {profile_id}")
+
+    @staticmethod
+    def _claim_legacy_profile_by_signature(
+        connection: sqlite3.Connection,
+        *,
+        target_template_id: str,
+        source_signature_hash: str,
+    ) -> sqlite3.Row | None:
+        legacy = connection.execute(
+            """
+            SELECT id FROM mapping_profiles
+            WHERE owner_scope = 'local:legacy'
+              AND target_template_id = ?
+              AND source_signature_hash = ?
+            ORDER BY updated_at DESC
+            LIMIT 1
+            """,
+            (target_template_id, source_signature_hash),
+        ).fetchone()
+        if legacy is None:
+            return None
+        connection.execute(
+            """
+            UPDATE mapping_profiles
+            SET owner_scope = 'local:default'
+            WHERE id = ? AND owner_scope = 'local:legacy'
+            """,
+            (legacy["id"],),
+        )
+        return connection.execute(
+            "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = 'local:default'",
+            (legacy["id"],),
+        ).fetchone()
+
+    @staticmethod
+    def _claim_legacy_profile_by_id(
+        connection: sqlite3.Connection,
+        profile_id: str,
+    ) -> sqlite3.Row | None:
+        connection.execute(
+            """
+            UPDATE mapping_profiles
+            SET owner_scope = 'local:default'
+            WHERE id = ? AND owner_scope = 'local:legacy'
+            """,
+            (profile_id,),
+        )
+        return connection.execute(
+            "SELECT * FROM mapping_profiles WHERE id = ? AND owner_scope = 'local:default'",
+            (profile_id,),
+        ).fetchone()
 
     def record_run(
         self,
@@ -289,5 +450,6 @@ class ProfileStore:
             formulas=json.loads(row["formulas_json"]),
             confidence=float(row["confidence"]),
             usage_count=int(row["usage_count"]),
+            owner_scope=str(row["owner_scope"] or ""),
             workspace_id=str(row["workspace_id"] or ""),
         )
diff --git a/converter/app/misa_workflow.py b/converter/app/misa_workflow.py
index 65b8446..69de326 100644
--- a/converter/app/misa_workflow.py
+++ b/converter/app/misa_workflow.py
@@ -1,6 +1,7 @@
 from __future__ import annotations
 
 import json
+import os
 import shutil
 import uuid
 from pathlib import Path
@@ -43,10 +44,17 @@ from app.mapping_profile_client import (
     save_mapping_profile,
 )
 from app.misa_readiness import add_master_data_resolutions, build_readiness_report
-from app.misa_profiles import ProfileStore
+from app.misa_profiles import ProfileStore, local_mapping_owner_scope
 from app.misa_templates import get_misa_template, list_misa_templates
 from app.models import MisaReadinessReport
 from app.normalization import normalize_header
+from app.student_context import StudentContextClaims, verify_student_context
+from app.student_store import (
+    assert_upload_owner,
+    bind_upload_to_student,
+    student_upload_is_bound,
+    student_upload_retention_seconds,
+)
 
 
 UPLOAD_ROOT = BACKEND_ROOT / ".artifacts" / "uploads"
@@ -84,13 +92,23 @@ def templates_payload() -> dict[str, Any]:
     }
 
 
-def save_upload(filename: str, content: bytes) -> tuple[str, Path]:
+def save_upload(
+    filename: str,
+    content: bytes,
+    *,
+    student_claims: StudentContextClaims | None = None,
+    student_ttl_seconds: int | None = None,
+) -> tuple[str, Path]:
     suffix = Path(filename or "").suffix.lower()
     if suffix not in {".xls", ".xlsx"}:
         raise ValueError("Only .xls and .xlsx files are supported.")
     upload_id = str(uuid.uuid4())
     directory = _upload_dir(upload_id)
     directory.mkdir(parents=True, exist_ok=True)
+    if student_claims is not None:
+        if student_ttl_seconds is None:
+            raise ValueError("Student upload TTL là bắt buộc")
+        bind_upload_to_student(upload_id, student_claims, student_ttl_seconds)
     input_path = directory / f"input{suffix}"
     input_path.write_bytes(content)
     metadata = {"upload_id": upload_id, "filename": filename, "input_path": str(input_path)}
@@ -104,8 +122,18 @@ def analyze_upload(
     content: bytes,
     requested_target_template_id: str | None = None,
     conversion_context_token: str | None = None,
+    student_context_token: str | None = None,
 ) -> dict[str, Any]:
-    upload_id, input_path = save_upload(filename, content)
+    if student_context_token and conversion_context_token:
+        raise ValueError("Không thể dùng student context và conversion context đồng thời")
+    student_claims = _verify_student_token(student_context_token, "analyze")
+    student_ttl = student_upload_retention_seconds() if student_claims else None
+    upload_id, input_path = save_upload(
+        filename,
+        content,
+        student_claims=student_claims,
+        student_ttl_seconds=student_ttl,
+    )
     table = read_input_table(input_path)
     target_template_id = detect_target_template_id(table, requested_target_template_id)
     template = get_misa_template(target_template_id)
@@ -114,18 +142,26 @@ def analyze_upload(
         conversion_context_token
     )
     workspace_id = str((context_claims or {}).get("workspace_id") or "")
+    owner_scope = student_claims.owner_scope if student_claims else (
+        f"workspace:{workspace_id}" if workspace_id else local_mapping_owner_scope()
+    )
+    profile_token = student_context_token or conversion_context_token
     store = ProfileStore()
     profile_warning: str | None = None
-    if workspace_id and conversion_context_token:
+    if profile_token:
         try:
             profile = find_mapping_profile(
-                conversion_context_token,
+                profile_token,
                 target_template_id=target_template_id,
                 source_signature_hash=signature.hash,
             )
+            if profile and profile.owner_scope != owner_scope:
+                raise MappingProfileClientError(
+                    "Backend trả về mapping profile sai owner scope"
+                )
             if profile:
                 try:
-                    mark_mapping_profile_used(conversion_context_token, profile.id)
+                    mark_mapping_profile_used(profile_token, profile.id)
                 except MappingProfileClientError as exc:
                     profile_warning = f"Không cập nhật được lượt dùng mapping profile: {exc}"
         except MappingProfileClientError as exc:
@@ -135,11 +171,11 @@ def analyze_upload(
         profile = store.find_by_signature(
             target_template_id=target_template_id,
             source_signature_hash=signature.hash,
-            workspace_id="",
+            owner_scope=owner_scope,
         )
     if profile:
-        if not workspace_id:
-            store.mark_used(profile.id)
+        if not profile_token:
+            store.mark_used(profile.id, owner_scope=owner_scope)
         suggestion = profile_suggestion(profile)
         profile_issues = validate_mapping(target_template_id, suggestion.mapping, template.headers)
         if _has_missing_required_mapping(profile_issues):
@@ -191,6 +227,7 @@ def analyze_upload(
                 if context_claims
                 else None
             ),
+            "owner_scope": owner_scope,
         }
     )
     _write_metadata(upload_id, metadata)
@@ -233,7 +270,9 @@ def preview_mapping(
     defaults: dict[str, Any] | None = None,
     formulas: dict[str, str] | None = None,
     conversion_context_token: str | None = None,
+    student_context_token: str | None = None,
 ) -> dict[str, Any]:
+    _assert_student_upload_context(upload_id, student_context_token, "explain")
     table = _read_upload_table(upload_id)
     template = get_misa_template(target_template_id)
     issues = validate_mapping(target_template_id, mapping, template.headers)
@@ -278,7 +317,9 @@ def readiness_mapping(
     formulas: dict[str, str] | None = None,
     edited_rows: list[dict[str, Any]] | None = None,
     conversion_context_token: str | None = None,
+    student_context_token: str | None = None,
 ) -> dict[str, Any]:
+    _assert_student_upload_context(upload_id, student_context_token, "explain")
     table = _read_upload_table(upload_id)
     template = get_misa_template(target_template_id)
     rows = edited_rows or apply_mapping(
@@ -322,7 +363,9 @@ def confirm_mapping(
     formulas: dict[str, str] | None = None,
     profile_name: str | None = None,
     conversion_context_token: str | None = None,
+    student_context_token: str | None = None,
 ) -> dict[str, Any]:
+    _assert_student_upload_context(upload_id, student_context_token, "attempt")
     metadata = _read_metadata(upload_id)
     _context_for_upload(upload_id, conversion_context_token)
     signature_payload = metadata.get("signature")
@@ -343,15 +386,12 @@ def confirm_mapping(
         defaults,
         template.headers,
     )
-    workspace_id = str(
-        ((metadata.get("conversion_context") or {}).get("workspace_id") or "")
-    )
-    if workspace_id:
-        if not conversion_context_token:
-            raise ValueError("Thiếu conversion context của hồ sơ doanh nghiệp")
+    owner_scope = _owner_scope_from_upload_metadata(metadata)
+    profile_token = student_context_token or conversion_context_token
+    if profile_token:
         try:
             profile = save_mapping_profile(
-                conversion_context_token,
+                profile_token,
                 name=profile_name or f"{target_template_id} profile",
                 target_template_id=target_template_id,
                 source_signature_hash=signature.hash,
@@ -378,7 +418,7 @@ def confirm_mapping(
             formulas=formulas or {},
             confidence=1.0,
             previous=previous,
-            workspace_id="",
+            owner_scope=owner_scope,
         )
     metadata["profile_id"] = profile.id
     metadata["confirmed"] = {
@@ -405,26 +445,25 @@ def export_confirmed_profile(
     edited_rows: list[dict[str, Any]] | None = None,
     acknowledge_warnings: bool = False,
     conversion_context_token: str | None = None,
+    student_context_token: str | None = None,
 ) -> tuple[bytes, str]:
+    _assert_student_upload_context(upload_id, student_context_token, "export")
     table = _read_upload_table(upload_id)
     metadata = _read_metadata(upload_id)
     context, context_status, context_message = _context_for_upload(
         upload_id, conversion_context_token
     )
-    workspace_id = str(
-        ((metadata.get("conversion_context") or {}).get("workspace_id") or "")
-    )
-    if workspace_id:
-        if not conversion_context_token:
-            raise ValueError("Thiếu conversion context của hồ sơ doanh nghiệp")
+    owner_scope = _owner_scope_from_upload_metadata(metadata)
+    profile_token = student_context_token or conversion_context_token
+    if profile_token:
         try:
-            profile = get_mapping_profile(conversion_context_token, profile_id)
+            profile = get_mapping_profile(profile_token, profile_id)
         except MappingProfileClientError as exc:
             raise ValueError(str(exc)) from exc
-        if profile.workspace_id != workspace_id:
+        if profile.owner_scope != owner_scope:
             raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
     else:
-        profile = ProfileStore().get_profile(profile_id)
+        profile = ProfileStore().get_profile(profile_id, owner_scope=owner_scope)
     template = get_misa_template(profile.target_template_id)
     clean_mapping = sanitize_mapping_for_template(profile.target_template_id, profile.mapping)
     clean_defaults = sanitize_defaults_for_template(
@@ -485,6 +524,55 @@ def _context_for_analyze(
         return None, "unavailable", str(exc), claims
 
 
+def _owner_scope_from_upload_metadata(metadata: dict[str, Any]) -> str:
+    owner_scope = str(metadata.get("owner_scope") or "").strip()
+    if owner_scope:
+        return owner_scope
+    workspace_id = str(
+        ((metadata.get("conversion_context") or {}).get("workspace_id") or "")
+    ).strip()
+    if workspace_id:
+        return f"workspace:{workspace_id}"
+    return local_mapping_owner_scope()
+
+
+def _student_assistant_enabled() -> bool:
+    return os.getenv("STUDENT_ASSISTANT_ENABLED", "false").lower() in {
+        "1",
+        "true",
+        "yes",
+    }
+
+
+def _verify_student_token(
+    token: str | None,
+    required_scope: str,
+) -> StudentContextClaims | None:
+    if not token:
+        return None
+    if not _student_assistant_enabled():
+        raise ValueError("Student assistant đang tắt")
+    return verify_student_context(token, required_scope)
+
+
+def _assert_student_upload_context(
+    upload_id: str,
+    token: str | None,
+    required_scope: str,
+) -> StudentContextClaims | None:
+    is_bound = student_upload_is_bound(upload_id)
+    if not is_bound:
+        if token:
+            _verify_student_token(token, required_scope)
+            raise ValueError("Upload chưa được bind với student context")
+        return None
+    claims = _verify_student_token(token, required_scope)
+    if claims is None:
+        raise ValueError("Thiếu student context của upload")
+    assert_upload_owner(upload_id, claims)
+    return claims
+
+
 def _context_for_upload(
     upload_id: str, token: str | None
 ) -> tuple[dict[str, Any] | None, str, str | None]:
diff --git a/converter/tests/test_mapping_profile_client.py b/converter/tests/test_mapping_profile_client.py
index af5014e..79aef44 100644
--- a/converter/tests/test_mapping_profile_client.py
+++ b/converter/tests/test_mapping_profile_client.py
@@ -17,6 +17,7 @@ class FakeResponse:
 def _profile_payload():
     return {
         "id": "profile-1",
+        "ownerScope": "workspace:workspace-1",
         "workspaceId": "workspace-1",
         "name": "BAE purchase",
         "targetTemplateId": "bsn_purchase",
@@ -50,6 +51,7 @@ def test_find_mapping_profile_uses_internal_context_headers(monkeypatch):
     )
 
     assert profile is not None
+    assert profile.owner_scope == "workspace:workspace-1"
     assert profile.workspace_id == "workspace-1"
     assert captured["headers"]["x-conversion-context"] == "context-token"
     assert captured["headers"]["x-converter-service-token"] == "service-secret"
@@ -84,3 +86,18 @@ def test_save_and_get_mapping_profile(monkeypatch):
     assert loaded.mapping == {"Mã NCC": "Mã nhà cung cấp"}
     assert calls[0][0] == "POST"
     assert calls[0][2]["json"]["targetTemplateId"] == "bsn_purchase"
+
+
+def test_profile_payload_keeps_workspace_compatibility_when_owner_scope_is_absent(monkeypatch):
+    payload = _profile_payload()
+    payload.pop("ownerScope")
+
+    monkeypatch.setattr(
+        "app.mapping_profile_client.httpx.request",
+        lambda *args, **kwargs: FakeResponse({"profile": payload}),
+    )
+
+    profile = get_mapping_profile("context-token", "profile-1")
+
+    assert profile.owner_scope == "workspace:workspace-1"
+    assert profile.workspace_id == "workspace-1"
diff --git a/converter/tests/test_misa_profile_api.py b/converter/tests/test_misa_profile_api.py
index 118ae58..5c33438 100644
--- a/converter/tests/test_misa_profile_api.py
+++ b/converter/tests/test_misa_profile_api.py
@@ -8,6 +8,7 @@ import xlrd
 from fastapi.testclient import TestClient
 
 from app.main import app
+from app.misa_profiles import ProfileStore
 
 
 ROOT = Path(__file__).resolve().parents[1]
@@ -17,6 +18,149 @@ SAMPLES = ROOT / "fixtures" / "samples"
 client = TestClient(app)
 
 
+def _profile_values(**overrides):
+    values = {
+        "name": "Owner-scoped mapping",
+        "target_template_id": "bsn_purchase",
+        "source_signature_hash": "signature-1",
+        "source_headers": ["Mã NCC"],
+        "sheet_name": "Sheet1",
+        "header_row": 1,
+        "mapping": {"Mã NCC": "Mã nhà cung cấp"},
+        "defaults": {},
+        "formulas": {},
+        "confidence": 1.0,
+    }
+    values.update(overrides)
+    return values
+
+
+def test_sqlite_profiles_are_isolated_by_non_empty_owner_scope(tmp_path):
+    store = ProfileStore(tmp_path / "profiles.sqlite")
+    owner_a = store.save_profile(**_profile_values(), owner_scope="user:user-a")
+    owner_b = store.save_profile(**_profile_values(), owner_scope="user:user-b")
+
+    assert owner_a.id != owner_b.id
+    assert owner_a.owner_scope == "user:user-a"
+    assert owner_b.owner_scope == "user:user-b"
+    assert (
+        store.find_by_signature(
+            target_template_id="bsn_purchase",
+            source_signature_hash="signature-1",
+            owner_scope="user:user-a",
+        ).id
+        == owner_a.id
+    )
+
+    try:
+        store.get_profile(owner_a.id, owner_scope="user:user-b")
+    except KeyError:
+        pass
+    else:
+        raise AssertionError("cross-owner profile get must fail")
+
+    try:
+        store.mark_used(owner_a.id, owner_scope="user:user-b")
+    except KeyError:
+        pass
+    else:
+        raise AssertionError("cross-owner profile use must fail")
+
+
+def test_sqlite_profile_migration_backfills_owner_scope_and_rejects_empty(tmp_path):
+    path = tmp_path / "legacy.sqlite"
+    with sqlite3.connect(path) as connection:
+        connection.executescript(
+            """
+            CREATE TABLE mapping_profiles (
+                id TEXT PRIMARY KEY,
+                name TEXT NOT NULL,
+                target_template_id TEXT NOT NULL,
+                source_signature_hash TEXT NOT NULL,
+                source_headers_json TEXT NOT NULL,
+                sheet_name TEXT NOT NULL,
+                header_row INTEGER NOT NULL,
+                mapping_json TEXT NOT NULL,
+                defaults_json TEXT NOT NULL,
+                formulas_json TEXT NOT NULL,
+                confidence REAL NOT NULL,
+                usage_count INTEGER NOT NULL DEFAULT 0,
+                created_at TEXT NOT NULL,
+                updated_at TEXT NOT NULL,
+                workspace_id TEXT NOT NULL DEFAULT ''
+            );
+            """
+        )
+        rows = [
+            ("workspace-profile", "workspace-123"),
+            ("local-profile", ""),
+            ("local-get-profile", ""),
+        ]
+        for profile_id, workspace_id in rows:
+            connection.execute(
+                """
+                INSERT INTO mapping_profiles (
+                    id, name, target_template_id, source_signature_hash,
+                    source_headers_json, sheet_name, header_row, mapping_json,
+                    defaults_json, formulas_json, confidence, usage_count,
+                    created_at, updated_at, workspace_id
+                ) VALUES (?, 'Legacy', 'bsn_purchase', ?, '[]', 'Sheet1', 1,
+                          '{}', '{}', '{}', 1, 0, 'now', 'now', ?)
+                """,
+                (profile_id, f"signature-{profile_id}", workspace_id),
+            )
+
+    ProfileStore(path)
+
+    with sqlite3.connect(path) as connection:
+        migrated = dict(
+            connection.execute(
+                "SELECT id, owner_scope FROM mapping_profiles ORDER BY id"
+            ).fetchall()
+        )
+        assert migrated == {
+            "local-get-profile": "local:legacy",
+            "local-profile": "local:legacy",
+            "workspace-profile": "workspace:workspace-123",
+        }
+        try:
+            connection.execute(
+                "UPDATE mapping_profiles SET owner_scope = '' WHERE id = 'local-profile'"
+            )
+        except sqlite3.IntegrityError:
+            pass
+        else:
+            raise AssertionError("empty owner_scope update must fail")
+
+    store = ProfileStore(path)
+    found = store.find_by_signature(
+        target_template_id="bsn_purchase",
+        source_signature_hash="signature-local-profile",
+    )
+    loaded = store.get_profile("local-get-profile")
+
+    assert found is not None
+    assert found.owner_scope == "local:default"
+    assert loaded.owner_scope == "local:default"
+    with sqlite3.connect(path) as connection:
+        claimed = dict(
+            connection.execute(
+                "SELECT id, owner_scope FROM mapping_profiles WHERE id LIKE 'local-%'"
+            ).fetchall()
+        )
+    assert claimed == {
+        "local-get-profile": "local:default",
+        "local-profile": "local:default",
+    }
+
+
+def test_sqlite_new_local_profiles_default_to_local_owner_scope(tmp_path, monkeypatch):
+    monkeypatch.delenv("LOCAL_MAPPING_OWNER_SCOPE", raising=False)
+    profile = ProfileStore(tmp_path / "profiles.sqlite").save_profile(**_profile_values())
+
+    assert profile.owner_scope == "local:default"
+
+
 def test_templates_endpoint_reads_real_misa_headers():
     response = client.get("/api/v1/templates")
 
diff --git a/frontend/.env.example b/frontend/.env.example
index 1f24265..e03265f 100644
--- a/frontend/.env.example
+++ b/frontend/.env.example
@@ -8,3 +8,12 @@ VITE_GOOGLE_CLIENT_ID=
 # Set false to hide the company workspace/master-data UI during rollback.
 VITE_MASTER_DATA_WORKSPACES_ENABLED=true
 VITE_VOUCHER_RECONSTRUCTION_ENABLED=false
+
+# Student assistant rollback gates.
+VITE_STUDENT_ASSISTANT_ENABLED=false
+VITE_STUDENT_FILE_EXPLAIN_ENABLED=false
+VITE_STUDENT_FILE_QA_ENABLED=false
+VITE_STUDENT_CHECK_WORK_ENABLED=false
+VITE_STUDENT_ACCOUNTING_MAP_ENABLED=false
+VITE_STUDENT_RECONCILIATION_ENABLED=false
+VITE_STUDENT_INTERNSHIP_ENABLED=false
diff --git a/backend/services/mappingProfileMigrationService.js b/backend/services/mappingProfileMigrationService.js
new file mode 100755
index 0000000..1c79701
--- /dev/null
+++ b/backend/services/mappingProfileMigrationService.js
@@ -0,0 +1,103 @@
+const MappingProfile = require("../models/MappingProfile");
+
+const OBSOLETE_WORKSPACE_UNIQUE_INDEX =
+  "workspace_1_targetTemplateId_1_sourceSignatureHash_1";
+const LEGACY_OWNER_SCOPE_FILTER = {
+  $or: [
+    { ownerScope: { $exists: false } },
+    { ownerScope: null },
+    { ownerScope: "" },
+  ],
+};
+
+function normalizedId(value) {
+  if (value == null) return "";
+  return String(value?._id || value).trim();
+}
+
+function buildLegacyOwnerScopeUpdate(profile = {}) {
+  const profileId = normalizedId(profile._id);
+  const workspaceId = normalizedId(profile.workspace);
+  const updatedBy = normalizedId(profile.updatedBy);
+  if (!profileId) throw new Error("Legacy mapping profile id is required");
+  if (!workspaceId && !updatedBy) {
+    throw new Error(
+      `Legacy mapping profile ${profileId} has no workspace or updatedBy`,
+    );
+  }
+  return {
+    updateOne: {
+      filter: { _id: profile._id, ...LEGACY_OWNER_SCOPE_FILTER },
+      update: {
+        $set: {
+          ownerScope: workspaceId
+            ? `workspace:${workspaceId}`
+            : `user:${updatedBy}`,
+        },
+      },
+    },
+  };
+}
+
+function planMappingProfileIndexMigration(indexes = []) {
+  return {
+    dropIndexNames: indexes
+      .filter((index) => index?.name === OBSOLETE_WORKSPACE_UNIQUE_INDEX)
+      .map((index) => index.name),
+  };
+}
+
+async function existingMappingProfileIndexes(model) {
+  try {
+    return await model.collection.indexes();
+  } catch (error) {
+    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
+      return [];
+    }
+    throw error;
+  }
+}
+
+function isIndexNotFound(error) {
+  return error?.code === 27 || error?.codeName === "IndexNotFound";
+}
+
+async function migrateMappingProfileOwnerScope({ model = MappingProfile } = {}) {
+  if (model.db?.readyState !== 1) {
+    return { skipped: true, backfilled: 0, droppedIndexes: [] };
+  }
+
+  const legacyProfiles = await model
+    .find(LEGACY_OWNER_SCOPE_FILTER)
+    .select("_id workspace updatedBy")
+    .lean();
+  const operations = legacyProfiles.map(buildLegacyOwnerScopeUpdate);
+  if (operations.length) {
+    await model.bulkWrite(operations, { ordered: true });
+  }
+
+  const indexes = await existingMappingProfileIndexes(model);
+  const plan = planMappingProfileIndexMigration(indexes);
+  for (const indexName of plan.dropIndexNames) {
+    try {
+      await model.collection.dropIndex(indexName);
+    } catch (error) {
+      if (!isIndexNotFound(error)) throw error;
+    }
+  }
+  await model.syncIndexes();
+
+  return {
+    skipped: false,
+    backfilled: operations.length,
+    droppedIndexes: plan.dropIndexNames,
+  };
+}
+
+module.exports = {
+  LEGACY_OWNER_SCOPE_FILTER,
+  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
+  buildLegacyOwnerScopeUpdate,
+  migrateMappingProfileOwnerScope,
+  planMappingProfileIndexMigration,
+};
diff --git a/backend/tests/mappingProfileMigration.test.js b/backend/tests/mappingProfileMigration.test.js
new file mode 100755
index 0000000..6feb54f
--- /dev/null
+++ b/backend/tests/mappingProfileMigration.test.js
@@ -0,0 +1,224 @@
+const assert = require("node:assert/strict");
+const test = require("node:test");
+
+const {
+  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
+  buildLegacyOwnerScopeUpdate,
+  migrateMappingProfileOwnerScope,
+  planMappingProfileIndexMigration,
+} = require("../services/mappingProfileMigrationService");
+
+
+test("legacy mapping owner migration prefers workspace and falls back to updatedBy", () => {
+  assert.deepEqual(
+    buildLegacyOwnerScopeUpdate({
+      _id: "profile-workspace",
+      workspace: "workspace-1",
+      updatedBy: "user-1",
+    }),
+    {
+      updateOne: {
+        filter: {
+          _id: "profile-workspace",
+          $or: [
+            { ownerScope: { $exists: false } },
+            { ownerScope: null },
+            { ownerScope: "" },
+          ],
+        },
+        update: { $set: { ownerScope: "workspace:workspace-1" } },
+      },
+    },
+  );
+  assert.equal(
+    buildLegacyOwnerScopeUpdate({
+      _id: "profile-user",
+      workspace: null,
+      updatedBy: "user-2",
+    }).updateOne.update.$set.ownerScope,
+    "user:user-2",
+  );
+  assert.throws(
+    () => buildLegacyOwnerScopeUpdate({ _id: "profile-orphan" }),
+    /workspace or updatedBy/i,
+  );
+});
+
+
+test("mapping profile index plan drops only the obsolete workspace unique index", () => {
+  assert.deepEqual(
+    planMappingProfileIndexMigration([
+      { name: "_id_", key: { _id: 1 }, unique: true },
+      {
+        name: OBSOLETE_WORKSPACE_UNIQUE_INDEX,
+        key: { workspace: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
+        unique: true,
+      },
+      {
+        name: "ownerScope_1_targetTemplateId_1_sourceSignatureHash_1",
+        key: { ownerScope: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
+        unique: true,
+      },
+    ]),
+    { dropIndexNames: [OBSOLETE_WORKSPACE_UNIQUE_INDEX] },
+  );
+});
+
+
+test("mapping profile migration backfills before dropping and syncing indexes", async () => {
+  const calls = [];
+  const documents = [
+    { _id: "profile-1", workspace: "workspace-1", updatedBy: "user-1" },
+    { _id: "profile-2", workspace: null, updatedBy: "user-2" },
+  ];
+  const model = {
+    db: { readyState: 1 },
+    find(filter) {
+      calls.push(["find", filter]);
+      return {
+        select(selection) {
+          calls.push(["select", selection]);
+          return this;
+        },
+        lean: async () => documents,
+      };
+    },
+    async bulkWrite(operations) {
+      calls.push(["bulkWrite", operations]);
+      return { modifiedCount: operations.length };
+    },
+    collection: {
+      async indexes() {
+        calls.push(["indexes"]);
+        return [
+          { name: "_id_", key: { _id: 1 } },
+          { name: OBSOLETE_WORKSPACE_UNIQUE_INDEX },
+        ];
+      },
+      async dropIndex(name) {
+        calls.push(["dropIndex", name]);
+      },
+    },
+    async syncIndexes() {
+      calls.push(["syncIndexes"]);
+    },
+  };
+
+  const result = await migrateMappingProfileOwnerScope({ model });
+
+  assert.equal(result.backfilled, 2);
+  assert.deepEqual(result.droppedIndexes, [OBSOLETE_WORKSPACE_UNIQUE_INDEX]);
+  assert.deepEqual(
+    calls.filter(([name]) => ["bulkWrite", "dropIndex", "syncIndexes"].includes(name)).map(([name]) => name),
+    ["bulkWrite", "dropIndex", "syncIndexes"],
+  );
+});
+
+
+test("mapping profile migration syncs indexes for a fresh collection", async () => {
+  const calls = [];
+  const model = {
+    db: { readyState: 1 },
+    find() {
+      return {
+        select() {
+          return this;
+        },
+        lean: async () => [],
+      };
+    },
+    collection: {
+      async indexes() {
+        const error = new Error("namespace not found");
+        error.code = 26;
+        error.codeName = "NamespaceNotFound";
+        throw error;
+      },
+      async dropIndex() {
+        throw new Error("dropIndex must not be called for a fresh collection");
+      },
+    },
+    async syncIndexes() {
+      calls.push("syncIndexes");
+    },
+  };
+
+  const result = await migrateMappingProfileOwnerScope({ model });
+
+  assert.deepEqual(result.droppedIndexes, []);
+  assert.deepEqual(calls, ["syncIndexes"]);
+});
+
+
+test("concurrent mapping migrations ignore IndexNotFound while dropping the obsolete index", async () => {
+  const calls = [];
+  const model = {
+    db: { readyState: 1 },
+    find() {
+      return {
+        select() {
+          return this;
+        },
+        lean: async () => [],
+      };
+    },
+    collection: {
+      async indexes() {
+        return [{ name: OBSOLETE_WORKSPACE_UNIQUE_INDEX }];
+      },
+      async dropIndex(name) {
+        calls.push(["dropIndex", name]);
+        const error = new Error("index not found after concurrent drop");
+        error.code = 27;
+        error.codeName = "IndexNotFound";
+        throw error;
+      },
+    },
+    async syncIndexes() {
+      calls.push(["syncIndexes"]);
+    },
+  };
+
+  const result = await migrateMappingProfileOwnerScope({ model });
+
+  assert.deepEqual(result.droppedIndexes, [OBSOLETE_WORKSPACE_UNIQUE_INDEX]);
+  assert.deepEqual(calls, [
+    ["dropIndex", OBSOLETE_WORKSPACE_UNIQUE_INDEX],
+    ["syncIndexes"],
+  ]);
+});
+
+
+test("mapping migration fails closed for non-IndexNotFound drop errors", async () => {
+  let syncCalled = false;
+  const model = {
+    db: { readyState: 1 },
+    find() {
+      return {
+        select() {
+          return this;
+        },
+        lean: async () => [],
+      };
+    },
+    collection: {
+      async indexes() {
+        return [{ name: OBSOLETE_WORKSPACE_UNIQUE_INDEX }];
+      },
+      async dropIndex() {
+        const error = new Error("drop denied");
+        error.code = 13;
+        throw error;
+      },
+    },
+    async syncIndexes() {
+      syncCalled = true;
+    },
+  };
+
+  await assert.rejects(
+    () => migrateMappingProfileOwnerScope({ model }),
+    /drop denied/,
+  );
+  assert.equal(syncCalled, false);
+});
diff --git a/converter/app/student_context.py b/converter/app/student_context.py
new file mode 100755
index 0000000..4022d37
--- /dev/null
+++ b/converter/app/student_context.py
@@ -0,0 +1,117 @@
+from __future__ import annotations
+
+import base64
+import hashlib
+import hmac
+import json
+import os
+import time
+from dataclasses import dataclass
+from typing import Any
+
+
+@dataclass(frozen=True)
+class StudentContextClaims:
+    purpose: str
+    session_id: str
+    user_id: str
+    owner_scope: str
+    workspace_id: str | None
+    snapshot_set_hash: str | None
+    allowed_scopes: tuple[str, ...]
+    exp: int
+
+
+def verify_student_context(token: str, required_scope: str) -> StudentContextClaims:
+    normalized_scope = str(required_scope or "").strip()
+    if not normalized_scope:
+        raise ValueError("Student context required scope là bắt buộc")
+
+    secret = os.getenv("CONVERSION_CONTEXT_SECRET") or os.getenv("JWT_SECRET")
+    if not secret:
+        raise ValueError("CONVERSION_CONTEXT_SECRET chưa được cấu hình")
+
+    try:
+        header_part, payload_part, signature_part = str(token).split(".")
+        header = _decode_json_part(header_part)
+        payload = _decode_json_part(payload_part)
+        actual_signature = _decode_bytes(signature_part)
+    except (TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
+        raise ValueError("Student context token không hợp lệ") from exc
+
+    if header.get("alg") != "HS256":
+        raise ValueError("Thuật toán student context không được hỗ trợ")
+    signed = f"{header_part}.{payload_part}".encode("ascii")
+    expected_signature = hmac.new(
+        secret.encode("utf-8"), signed, hashlib.sha256
+    ).digest()
+    if not hmac.compare_digest(expected_signature, actual_signature):
+        raise ValueError("Chữ ký student context không hợp lệ")
+
+    if payload.get("purpose") != "student_file_session":
+        raise ValueError("Student context token sai mục đích")
+
+    session_id = str(payload.get("session_id") or "").strip()
+    user_id = str(payload.get("user_id") or "").strip()
+    owner_scope = str(payload.get("owner_scope") or "").strip()
+    if not session_id:
+        raise ValueError("Student context thiếu session")
+    if not user_id:
+        raise ValueError("Student context thiếu user")
+    if not owner_scope:
+        raise ValueError("Student context thiếu owner scope")
+
+    workspace_value = payload.get("workspace_id")
+    workspace_id = (
+        str(workspace_value).strip() if workspace_value not in (None, "") else None
+    )
+    if owner_scope.startswith("workspace:"):
+        if not workspace_id or owner_scope != f"workspace:{workspace_id}":
+            raise ValueError("Student context owner scope không hợp lệ")
+    elif owner_scope != f"user:{user_id}":
+        raise ValueError("Student context owner scope không hợp lệ")
+
+    raw_scopes = payload.get("allowed_scopes")
+    if not isinstance(raw_scopes, list):
+        raise ValueError("Student context scopes không hợp lệ")
+    allowed_scopes = tuple(str(scope) for scope in raw_scopes)
+    if normalized_scope not in allowed_scopes:
+        raise ValueError(f"Student context thiếu quyền {normalized_scope}")
+
+    exp_value = payload.get("exp")
+    if isinstance(exp_value, bool):
+        raise ValueError("Student context exp không hợp lệ")
+    try:
+        exp = int(exp_value)
+    except (TypeError, ValueError) as exc:
+        raise ValueError("Student context exp không hợp lệ") from exc
+    if exp <= int(time.time()):
+        raise ValueError("Student context token đã hết hạn")
+
+    snapshot_value = payload.get("snapshot_set_hash")
+    snapshot_set_hash = (
+        str(snapshot_value).strip() if snapshot_value not in (None, "") else None
+    )
+    return StudentContextClaims(
+        purpose="student_file_session",
+        session_id=session_id,
+        user_id=user_id,
+        owner_scope=owner_scope,
+        workspace_id=workspace_id,
+        snapshot_set_hash=snapshot_set_hash,
+        allowed_scopes=allowed_scopes,
+        exp=exp,
+    )
+
+
+def _decode_json_part(value: str) -> dict[str, Any]:
+    decoded = _decode_bytes(value).decode("utf-8")
+    payload = json.loads(decoded)
+    if not isinstance(payload, dict):
+        raise ValueError("JWT part must be a JSON object")
+    return payload
+
+
+def _decode_bytes(value: str) -> bytes:
+    padding = "=" * (-len(value) % 4)
+    return base64.urlsafe_b64decode((value + padding).encode("ascii"))
diff --git a/converter/app/student_store.py b/converter/app/student_store.py
new file mode 100755
index 0000000..813ac60
--- /dev/null
+++ b/converter/app/student_store.py
@@ -0,0 +1,150 @@
+from __future__ import annotations
+
+import json
+import os
+import shutil
+import time
+from datetime import datetime
+from pathlib import Path
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
diff --git a/converter/app/student_anonymization.py b/converter/app/student_anonymization.py
new file mode 100755
index 0000000..7b046b5
--- /dev/null
+++ b/converter/app/student_anonymization.py
@@ -0,0 +1,136 @@
+from __future__ import annotations
+
+import hashlib
+import hmac
+from collections.abc import Iterable, Mapping
+from typing import Any
+
+
+ANONYMIZATION_CATEGORIES = (
+    "company",
+    "counterparty",
+    "tax_code",
+    "address",
+    "email",
+    "phone",
+    "bank_account",
+    "document_number",
+)
+
+_TEXT_PREFIXES = {
+    "company": "COMPANY",
+    "counterparty": "COUNTERPARTY",
+    "address": "ADDRESS",
+}
+_NUMERIC_PREFIXES = {
+    "tax_code": "TAX",
+    "phone": "PHONE",
+    "bank_account": "BANK",
+    "document_number": "DOC",
+}
+
+
+class AnonymizationSession:
+    def __init__(self, session_id: str, secret: str | bytes) -> None:
+        self.session_id = str(session_id or "").strip()
+        if not self.session_id:
+            raise ValueError("session_id is required")
+        secret_bytes = secret if isinstance(secret, bytes) else str(secret or "").encode()
+        if not secret_bytes:
+            raise ValueError("secret is required")
+        self._secret = secret_bytes
+        self._replacements: dict[tuple[str, str], str] = {}
+
+    def replace(self, category: str, value: Any):
+        normalized_category = _validate_category(category)
+        if value is None:
+            return None
+        source = str(value)
+        if not source.strip():
+            return source
+        canonical = source.strip().casefold()
+        cache_key = (normalized_category, canonical)
+        if cache_key not in self._replacements:
+            digest = hmac.new(
+                self._secret,
+                f"{self.session_id}\0{normalized_category}\0{canonical}".encode(
+                    "utf-8"
+                ),
+                hashlib.sha256,
+            ).digest()
+            self._replacements[cache_key] = _replacement_for(
+                normalized_category,
+                source,
+                digest,
+            )
+        return self._replacements[cache_key]
+
+    anonymize = replace
+
+
+def scan_confidential_values(
+    payload: Any,
+    confidential_values: Mapping[str, Iterable[Any]],
+) -> tuple[str, ...]:
+    searchable_values = tuple(
+        value.casefold() for value in _iter_text_values(payload) if value.strip()
+    )
+    matches: list[str] = []
+    for category in ANONYMIZATION_CATEGORIES:
+        if category not in confidential_values:
+            continue
+        _validate_category(category)
+        originals = (
+            str(value).strip().casefold()
+            for value in confidential_values[category]
+            if value is not None and str(value).strip()
+        )
+        if any(
+            original in candidate
+            for original in originals
+            for candidate in searchable_values
+        ):
+            matches.append(category)
+    return tuple(matches)
+
+
+def _replacement_for(category: str, source: str, digest: bytes) -> str:
+    token = digest.hex()[:12].upper()
+    if category in _TEXT_PREFIXES:
+        return f"{_TEXT_PREFIXES[category]}-{token}"
+    if category == "email":
+        return f"student-{digest.hex()[:12]}@example.invalid"
+    if category in _NUMERIC_PREFIXES:
+        return f"{_NUMERIC_PREFIXES[category]}-{_numeric_token(source, digest)}"
+    raise ValueError(f"Unsupported anonymization category: {category}")
+
+
+def _numeric_token(source: str, digest: bytes) -> str:
+    source_digits = "".join(character for character in source if character.isdigit())
+    length = max(8, len(source_digits))
+    leading_zeroes = len(source_digits) - len(source_digits.lstrip("0"))
+    leading_zeroes = min(leading_zeroes, max(0, length - 1))
+    generated = "".join(str(byte % 10) for byte in digest)
+    while len(generated) < length:
+        generated += generated
+    return ("0" * leading_zeroes + generated)[:length]
+
+
+def _validate_category(category: str) -> str:
+    normalized = str(category or "").strip().lower()
+    if normalized not in ANONYMIZATION_CATEGORIES:
+        raise ValueError(f"Unsupported anonymization category: {category}")
+    return normalized
+
+
+def _iter_text_values(value: Any):
+    if isinstance(value, str):
+        yield value
+    elif isinstance(value, Mapping):
+        for item in value.values():
+            yield from _iter_text_values(item)
+    elif isinstance(value, Iterable) and not isinstance(value, (bytes, bytearray)):
+        for item in value:
+            yield from _iter_text_values(item)
+    elif value is not None and not isinstance(value, (bytes, bytearray)):
+        yield str(value)
diff --git a/converter/tests/test_student_context.py b/converter/tests/test_student_context.py
new file mode 100755
index 0000000..599df02
--- /dev/null
+++ b/converter/tests/test_student_context.py
@@ -0,0 +1,285 @@
+import base64
+import hashlib
+import hmac
+import json
+import time
+from io import BytesIO
+from pathlib import Path
+
+import openpyxl
+import pytest
+
+from app.misa_workflow import analyze_upload, confirm_mapping, preview_mapping
+from app.student_context import verify_student_context
+from app.student_store import (
+    assert_upload_owner,
+    bind_upload_to_student,
+    cleanup_expired_student_uploads,
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
+    analyze_only = _student_token(allowed_scopes=["analyze"])
+    analyzed = analyze_upload(
+        filename="student.xlsx",
+        content=_workbook_bytes(),
+        requested_target_template_id="bsn_sales",
+        student_context_token=analyze_only,
+    )
+    suggestion = analyzed["mapping_suggestion"]
+
+    with pytest.raises(ValueError, match="explain"):
+        preview_mapping(
+            upload_id=analyzed["upload_id"],
+            target_template_id="bsn_sales",
+            mapping=suggestion["mapping"],
+            defaults=suggestion["defaults"],
+            formulas=suggestion["formulas"],
+            student_context_token=analyze_only,
+        )
+
+    with pytest.raises(ValueError, match="attempt"):
+        confirm_mapping(
+            upload_id=analyzed["upload_id"],
+            target_template_id="bsn_sales",
+            mapping=suggestion["mapping"],
+            defaults=suggestion["defaults"],
+            formulas=suggestion["formulas"],
+            student_context_token=analyze_only,
+        )
diff --git a/converter/tests/test_student_anonymization.py b/converter/tests/test_student_anonymization.py
new file mode 100755
index 0000000..d593d51
--- /dev/null
+++ b/converter/tests/test_student_anonymization.py
@@ -0,0 +1,107 @@
+from pathlib import Path
+
+import pytest
+
+from app.student_anonymization import (
+    AnonymizationSession,
+    scan_confidential_values,
+)
+
+
+ROOT = Path(__file__).resolve().parents[2]
+FEATURE_FLAGS = {
+    "STUDENT_ASSISTANT_ENABLED",
+    "STUDENT_FILE_EXPLAIN_ENABLED",
+    "STUDENT_FILE_QA_ENABLED",
+    "STUDENT_CHECK_WORK_ENABLED",
+    "STUDENT_ACCOUNTING_MAP_ENABLED",
+    "STUDENT_RECONCILIATION_ENABLED",
+    "STUDENT_INTERNSHIP_ENABLED",
+}
+
+
+def test_anonymization_is_stable_within_the_same_session_and_category():
+    first = AnonymizationSession("session-1", "secret")
+    second = AnonymizationSession("session-1", "secret")
+
+    replacement = first.replace("company", "Công ty TNHH Sao Mai")
+
+    assert replacement == first.replace("company", "Công ty TNHH Sao Mai")
+    assert replacement == second.replace("company", "Công ty TNHH Sao Mai")
+    assert replacement != AnonymizationSession("session-2", "secret").replace(
+        "company", "Công ty TNHH Sao Mai"
+    )
+
+
+def test_anonymization_categories_do_not_collide_for_the_same_source_value():
+    session = AnonymizationSession("session-1", "secret")
+
+    replacements = {
+        category: session.replace(category, "0012345678")
+        for category in (
+            "company",
+            "counterparty",
+            "tax_code",
+            "address",
+            "email",
+            "phone",
+            "bank_account",
+            "document_number",
+        )
+    }
+
+    assert len(set(replacements.values())) == len(replacements)
+
+
+def test_anonymization_preserves_blanks_and_numeric_identifiers_as_text():
+    session = AnonymizationSession("session-1", "secret")
+
+    assert session.replace("company", None) is None
+    assert session.replace("company", "") == ""
+    assert session.replace("company", "   ") == "   "
+    tax_code = session.replace("tax_code", "0012345678")
+
+    assert isinstance(tax_code, str)
+    assert tax_code.startswith("TAX-00")
+
+
+def test_anonymization_rejects_unknown_categories():
+    session = AnonymizationSession("session-1", "secret")
+
+    with pytest.raises(ValueError, match="category"):
+        session.replace("password", "secret")
+
+
+def test_confidential_scanner_reports_categories_without_returning_raw_values():
+    matches = scan_confidential_values(
+        {
+            "summary": "Công ty TNHH Sao Mai",
+            "rows": [{"tax_code": "0012345678"}, {"note": "safe"}],
+        },
+        {
+            "company": ["Công ty TNHH Sao Mai"],
+            "tax_code": ["0012345678"],
+            "phone": ["0900000000"],
+        },
+    )
+
+    assert matches == ("company", "tax_code")
+    assert "Công ty TNHH Sao Mai" not in matches
+    assert "0012345678" not in matches
+
+
+def test_student_feature_flags_and_retention_values_are_documented():
+    root_env = (ROOT / ".env.example").read_text(encoding="utf-8")
+    converter_env = (ROOT / "converter" / ".env.example").read_text(encoding="utf-8")
+    frontend_env = (ROOT / "frontend" / ".env.example").read_text(encoding="utf-8")
+
+    for flag in FEATURE_FLAGS:
+        assert f"{flag}=false" in root_env
+        assert f"{flag}=false" in converter_env
+        assert f"VITE_{flag}=false" in frontend_env
+    assert "CONVERSION_CONTEXT_SECRET=" in root_env
+    assert "CONVERSION_CONTEXT_SECRET=" in converter_env
+    assert "STUDENT_UPLOAD_RETENTION_SECONDS=86400" in root_env
+    assert "STUDENT_UPLOAD_RETENTION_SECONDS=86400" in converter_env
+    assert "STUDENT_UPLOAD_CLEANUP_INTERVAL_SECONDS=300" in converter_env
+    assert "LOCAL_MAPPING_OWNER_SCOPE=local:default" in converter_env
diff --git a/backend/tests/studentSessions.test.js b/backend/tests/studentSessions.test.js
new file mode 100755
index 0000000..1b7abc8
--- /dev/null
+++ b/backend/tests/studentSessions.test.js
@@ -0,0 +1,380 @@
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
diff --git a/.env.example b/.env.example
new file mode 100755
index 0000000..7b686e0
--- /dev/null
+++ b/.env.example
@@ -0,0 +1,14 @@
+# Student assistant rollback gates. Keep all false until each phase is enabled.
+STUDENT_ASSISTANT_ENABLED=false
+STUDENT_FILE_EXPLAIN_ENABLED=false
+STUDENT_FILE_QA_ENABLED=false
+STUDENT_CHECK_WORK_ENABLED=false
+STUDENT_ACCOUNTING_MAP_ENABLED=false
+STUDENT_RECONCILIATION_ENABLED=false
+STUDENT_INTERNSHIP_ENABLED=false
+
+# Shared HS256 secret for Node-issued conversion/student contexts.
+CONVERSION_CONTEXT_SECRET=replace-with-a-long-random-secret
+
+# Temporary raw student uploads are capped at 24 hours.
+STUDENT_UPLOAD_RETENTION_SECONDS=86400
