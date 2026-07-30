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
const StudentQuestionEvent = require("./models/StudentQuestionEvent");
const {
  migrateStudentQuestionEventPrivacy,
} = require("./services/studentSessionService");

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

function createStartServer({
  connectDatabase = connectDB,
  migrateMappingProfiles = migrateMappingProfileOwnerScope,
  ensureV2Indexes = ensureMappingProfileV2Indexes,
  migrateMappingProfilesV2 = migrateMappingProfilesV1ToV2,
  migrateQuestionEvents = migrateStudentQuestionEventPrivacy,
  questionEventModel = StudentQuestionEvent,
  repairEnabled = misaImportRepairEnabled,
  ensureRepairIndexes = ensureMisaImportRepairIndexes,
  startArtifactSweeper = startConversionArtifactSweeper,
  startRepairSweeper = startMisaImportRepairSweeper,
  listen = app.listen.bind(app),
  logger = console,
} = {}) {
  return async function startServer() {
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
    const migration = await migrateMappingProfiles();
    if (!migration.skipped) {
      logger.log(
        `[DB] MappingProfile owner migration: ${migration.backfilled} backfilled, ${migration.droppedIndexes.length} obsolete index(es) dropped`,
      );
    }
    const v2MigrationMode = String(
      process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
    ).trim().toLowerCase();
    if (mappingProfileV2Enabled || v2MigrationMode === "apply") {
      await ensureV2Indexes();
    }
    const v2Migration = await migrateMappingProfilesV2({ mode: v2MigrationMode });
    if (!v2Migration.skipped) {
      logger.log(
        `[DB] MappingProfile V2 migration (${v2Migration.mode}): ${v2Migration.created} created, ${v2Migration.skippedExisting} existing, ${v2Migration.quarantined} quarantined`,
      );
    }
    try {
      const questionMigration = await migrateQuestionEvents(questionEventModel);
      if (questionMigration.purged) {
        logger.log(
          `[DB] Student question privacy migration: ${questionMigration.purged} legacy event(s) purged`,
        );
      }
    } catch (error) {
      logger.error(`[DB] Student question privacy migration failed: ${error.message}`);
    }
    const artifactSweeper = converterGatewayUsageReady
      ? startArtifactSweeper()
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
