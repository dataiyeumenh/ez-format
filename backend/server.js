const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const connectDB = require("./config/db");
const { getPaymentSettlementReadiness } = require("./config/db");
const {
  migrateMappingProfileOwnerScope,
} = require("./services/mappingProfileMigrationService");
const {
  ensureMisaImportRepairIndexes,
} = require("./services/misaImportRepairMigrationService");
const {
  startMisaImportRepairSweeper,
} = require("./services/misaImportRepairSweeper");
const {
  ensureMappingProfileV2Indexes,
  migrateMappingProfilesV1ToV2,
} = require("./services/mappingProfileV2MigrationService");
const {
  runProductionMigrationPreflight,
} = require("./scripts/preflight-production-migrations");
const {
  getRuntimeCapabilities,
} = require("./services/runtimeCapabilitiesService");
const { getRevenue } = require("./controllers/adminController");
const { protect, adminOnly } = require("./middleware/auth");
const requireDb = require("./middleware/requireDb");
const {
  assertConversionContextConfig,
} = require("./services/conversionContextService");
const {
  assertArtifactStorageConfigured,
  assertArtifactStorageReachable,
  ensureConversionArtifactIndexes,
  startConversionArtifactSweeper,
} = require("./services/conversionArtifactService");
const {
  assertConverterGatewayStartupConfig,
  isConverterGatewayUsageReady,
} = require("./services/converterGatewayService");
const {
  mergeGatewayCapabilities,
} = require("./routes/converterGateway");
const {
  migrateStudentPrivacy,
  normalizeStudentPrivacyMigrationMode,
} = require("./services/studentSessionService");
const {
  startStudentDeletionSweeper,
} = require("./controllers/studentSessionController");

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
const misaImportRepairEnabled =
  String(process.env.MISA_IMPORT_REPAIR_ENABLED || "false").trim().toLowerCase() ===
  "true";
const runtimeCapabilities = getRuntimeCapabilities();
const mappingProfileV2Enabled = runtimeCapabilities.mapping_profile_v2;
const converterGatewayUsageReady = isConverterGatewayUsageReady();

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
    exposedHeaders: ["Content-Disposition", "X-Request-ID"],
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

// Routes
if (converterGatewayUsageReady) {
  app.use("/api/converter", require("./routes/converterGateway").router);
  app.use("/api/converter/context", require("./routes/conversionContext"));
  app.use("/api/internal/converter-sessions", require("./routes/internalConverterSessions"));
}
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

if (!converterGatewayUsageReady) {
  app.get("/api/converter/capabilities", requireDb, protect, (_req, res) => {
    res.status(503).json(
      mergeGatewayCapabilities(
        {},
        process.env,
        {},
        { gatewayAvailable: false },
      ),
    );
  });
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "EzFormat API is running",
    capabilities: {
      masterDataWorkspaces: masterDataWorkspacesEnabled,
      voucherReconstruction: voucherReconstructionEnabled,
      converterGateway: converterGatewayUsageReady,
      studentAssistant: studentAssistantEnabled,
      operations: converterGatewayUsageReady ? runtimeCapabilities : {},
      paymentSettlement: getPaymentSettlementReadiness().ready,
    },
  });
});

const PORT = process.env.PORT || 5000;

function loadStudentPrivacyModels(connection = mongoose.connection) {
  const database = connection?.connection?.db || connection?.db;
  if (!database || typeof database.collection !== "function") {
    throw new Error("MongoDB connection is required for Student privacy migration");
  }
  return {
    questionEventModel: require("./models/StudentQuestionEvent"),
    activityModel: require("./models/StudentActivity"),
    sessionModel: require("./models/StudentFileSession"),
    retiredCollections: {
      studentattempts: database.collection("studentattempts"),
      studentskillprogresses: database.collection("studentskillprogresses"),
    },
  };
}

function createStartServer({
  connectDatabase = connectDB,
  migrateMappingProfiles = migrateMappingProfileOwnerScope,
  ensureV2Indexes = ensureMappingProfileV2Indexes,
  migrateMappingProfilesV2 = migrateMappingProfilesV1ToV2,
  runMappingProfileMigrations = runProductionMigrationPreflight,
  studentEnabled = studentAssistantEnabled,
  migrateStudentPrivacy: runStudentPrivacyMigration = migrateStudentPrivacy,
  loadStudentPrivacyModels: loadPrivacyModels = loadStudentPrivacyModels,
  repairEnabled = misaImportRepairEnabled,
  ensureRepairIndexes = ensureMisaImportRepairIndexes,
  startArtifactSweeper = startConversionArtifactSweeper,
  startRepairSweeper = startMisaImportRepairSweeper,
  startStudentDeletionSweeper: startStudentDeleteSweeper = startStudentDeletionSweeper,
  listen = app.listen.bind(app),
  logger = console,
} = {}) {
  return async function startServer() {
    const privacyMigrationMode = normalizeStudentPrivacyMigrationMode(
      process.env.STUDENT_PRIVACY_MIGRATION_MODE,
    );
    const v2MigrationMode = String(
      process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
    ).trim().toLowerCase();
    if (v2MigrationMode === "rollback") {
      throw new Error(
        "MappingProfile rollback cannot run during startup; use the production migration command",
      );
    }
    if (!["off", "dry-run", "apply"].includes(v2MigrationMode)) {
      throw new Error(
        "MAPPING_PROFILE_V2_MIGRATION_MODE must be off, dry-run, or apply during startup",
      );
    }
    if (converterGatewayUsageReady) {
      assertConversionContextConfig();
      assertConverterGatewayStartupConfig();
      assertArtifactStorageConfigured();
    }
    const connection = await connectDatabase();
    if (converterGatewayUsageReady) {
      const mongoConnection = connection || mongoose.connection;
      await assertArtifactStorageReachable({ connection: mongoConnection });
      await ensureConversionArtifactIndexes();
    }
    if (repairEnabled) {
      const repairIndexes = await ensureRepairIndexes();
      if (repairIndexes.droppedIndexes.length || repairIndexes.unsetNullKeys) {
        logger.log(
          `[DB] MisaImportRepair indexes: ${repairIndexes.droppedIndexes.length} legacy index(es) dropped, ${repairIndexes.unsetNullKeys} null key(s) unset`,
        );
      }
    }
    if (v2MigrationMode === "off") {
      await migrateMappingProfiles({ mode: "off" });
      await migrateMappingProfilesV2({ mode: "off" });
    } else {
      try {
        const migrationReport = await runMappingProfileMigrations({
          mode: v2MigrationMode,
          connection: connection?.connection || connection || mongoose.connection,
          migrateOwnerScope: migrateMappingProfiles,
          ensureV2Indexes,
          migrateV2: migrateMappingProfilesV2,
        });
        logger.log(JSON.stringify({
          event: "mapping-profile-migration-completed",
          report: migrationReport,
        }));
      } catch (error) {
        if (error?.report) {
          logger.error(JSON.stringify({
            event: "mapping-profile-migration-failed",
            report: error.report,
          }));
        }
        throw error;
      }
    }
    if (studentEnabled && privacyMigrationMode !== "off") {
      try {
        const report = await runStudentPrivacyMigration(loadPrivacyModels(connection), {
          mode: privacyMigrationMode,
          maxRetiredRecords: process.env.STUDENT_PRIVACY_MIGRATION_MAX_TOTAL,
          maxDurationMs: process.env.STUDENT_PRIVACY_MIGRATION_MAX_DURATION_MS,
        });
        logger.log(JSON.stringify({
          event: "student-privacy-migration-completed",
          report,
        }));
      } catch (error) {
        if (error?.report) {
          logger.error(JSON.stringify({
            event: "student-privacy-migration-failed",
            report: error.report,
          }));
        }
        throw error;
      }
    }
    const artifactSweeper = converterGatewayUsageReady
      ? startArtifactSweeper()
      : null;
    const studentDeletionSweeper = studentEnabled
      ? startStudentDeleteSweeper()
      : null;
    const server = listen(PORT, () => {
      logger.log(`Server running on port ${PORT}`);
    });
    const repairSweeper = repairEnabled
      ? startRepairSweeper({ owner: server })
      : null;
    server.once("close", () => {
      artifactSweeper?.stop();
      repairSweeper?.stop();
      studentDeletionSweeper?.stop();
    });
    return server;
  };
}

const startServer = createStartServer();

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[BOOT] Server startup failed:", error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  createStartServer,
  converterGatewayUsageReady,
  studentAssistantEnabled,
};
