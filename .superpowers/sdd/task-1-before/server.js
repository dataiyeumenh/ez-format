const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const connectDB = require("./config/db");
const {
  migrateMappingProfileOwnerScope,
} = require("./services/mappingProfileMigrationService");
const {
  ensureMappingProfileV2Indexes,
  migrateMappingProfilesV1ToV2,
} = require("./services/mappingProfileV2MigrationService");
const {
  getRuntimeCapabilities,
} = require("./services/runtimeCapabilitiesService");
const { getRevenue } = require("./controllers/adminController");
const { protect, adminOnly } = require("./middleware/auth");
const requireDb = require("./middleware/requireDb");
const {
  createConversionContextToken,
} = require("./services/conversionContextService");

require("dotenv").config();

console.log("[BOOT] NODE_ENV:", process.env.NODE_ENV);
console.log("[BOOT] PORT:", process.env.PORT);
console.log("[BOOT] FRONTEND_URL:", process.env.FRONTEND_URL);
console.log("[BOOT] FRONTEND_URL_WWW:", process.env.FRONTEND_URL_WWW);

const app = express();
const masterDataWorkspacesEnabled =
  String(process.env.MASTER_DATA_WORKSPACES_ENABLED || "true").toLowerCase() !==
  "false";
const voucherReconstructionEnabled =
  String(process.env.VOUCHER_RECONSTRUCTION_ENABLED || "false").toLowerCase() ===
  "true";
const studentAssistantEnabled =
  String(process.env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
const runtimeCapabilities = getRuntimeCapabilities();
const mappingProfileV2Enabled = runtimeCapabilities.mapping_profile_v2;

// CORS config: allow localhost for dev + Vercel production URL
const allowedOrigins = [
  "http://localhost:5173", // Dev Vite
  "http://127.0.0.1:5173", // Dev Vite via explicit loopback host
  "http://localhost:3000", // Dev alternative
  "http://127.0.0.1:3000", // Dev alternative via explicit loopback host
  process.env.FRONTEND_URL, // Production (e.g., https://ezformat.io.vn)
  process.env.FRONTEND_URL_WWW, // www variant (e.g., https://www.ezformat.io.vn)
].filter(Boolean);

console.log("[CORS] Allowed origins:", allowedOrigins);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ["X-Request-ID"],
  }),
);
app.use((req, res, next) => {
  const supplied = String(req.headers["x-request-id"] || "").trim();
  req.requestId = supplied.slice(0, 128) || crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

function createPersonalConversionContext(req, res) {
  const userId = String(req.user?._id || "").trim();
  const ownerScope = `user:${userId}`;
  const contextToken = createConversionContextToken({
    userId,
    workspaceId: null,
    ownerScope,
    snapshotSetHash: null,
    snapshotIds: [],
    masterDataRevision: 0,
  });
  return res.json({
    success: true,
    contextToken,
    ownerScope,
    snapshotSetHash: null,
    workspace: null,
    snapshots: [],
  });
}

// Routes
app.post(
  "/api/converter/context",
  requireDb,
  protect,
  createPersonalConversionContext,
);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/plans", require("./routes/plans"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/convert", require("./routes/convert"));
app.use("/api/conversion-runs", require("./routes/conversionRuns"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/feedback", require("./routes/feedback"));
if (masterDataWorkspacesEnabled) {
  app.use(
    "/api/accounting-workspaces",
    require("./routes/accountingWorkspaces"),
  );
}
if (voucherReconstructionEnabled) {
  app.use("/api/reconstructions", require("./routes/reconstructions"));
}
if (studentAssistantEnabled) {
  app.use("/api/student", require("./routes/student"));
}
if (mappingProfileV2Enabled) {
  app.use("/api/mapping-profiles/v2", require("./routes/mappingProfilesV2"));
}
if (
  masterDataWorkspacesEnabled ||
  voucherReconstructionEnabled ||
  studentAssistantEnabled ||
  mappingProfileV2Enabled
) {
  app.use("/api/internal", require("./routes/internal"));
}
if (mappingProfileV2Enabled) {
  app.use(
    "/api/internal/mapping-profiles/v2",
    require("./routes/mappingProfilesV2").internalRouter,
  );
}

// Backward-compatible alias for older admin revenue bundles.
app.get("/api/revenue", requireDb, protect, adminOnly, getRevenue);
app.get("/admin/revenue", requireDb, protect, adminOnly, getRevenue);

app.get("/api/converter/capabilities", (_req, res) => {
  res.json(runtimeCapabilities);
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "EzFormat API is running",
    capabilities: {
      masterDataWorkspaces: masterDataWorkspacesEnabled,
      voucherReconstruction: voucherReconstructionEnabled,
      studentAssistant: studentAssistantEnabled,
      operations: runtimeCapabilities,
    },
  });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  await connectDB();
  const migration = await migrateMappingProfileOwnerScope();
  if (!migration.skipped) {
    console.log(
      `[DB] MappingProfile owner migration: ${migration.backfilled} backfilled, ${migration.droppedIndexes.length} obsolete index(es) dropped`,
    );
  }
  const v2MigrationMode = String(
    process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
  ).trim().toLowerCase();
  if (mappingProfileV2Enabled || v2MigrationMode === "apply") {
    await ensureMappingProfileV2Indexes();
  }
  const v2Migration = await migrateMappingProfilesV1ToV2();
  if (!v2Migration.skipped) {
    console.log(
      `[DB] MappingProfile V2 migration (${v2Migration.mode}): ${v2Migration.created} created, ${v2Migration.skippedExisting} existing, ${v2Migration.quarantined} quarantined`,
    );
  }
  return app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[BOOT] Server startup failed:", error.message);
    process.exit(1);
  });
}

module.exports = { app, startServer };
