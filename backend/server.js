const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const connectDB = require("./config/db");
const { getPaymentSettlementReadiness } = require("./config/db");
const {
  migrateMappingProfileOwnerScope,
} = require("./services/mappingProfileMigrationService");
const { getRevenue } = require("./controllers/adminController");
const { protect, adminOnly } = require("./middleware/auth");
const requireDb = require("./middleware/requireDb");

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

// Routes
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
if (
  masterDataWorkspacesEnabled ||
  voucherReconstructionEnabled ||
  studentAssistantEnabled
) {
  app.use("/api/internal", require("./routes/internal"));
}

// Backward-compatible alias for older admin revenue bundles.
app.get("/api/revenue", requireDb, protect, adminOnly, getRevenue);
app.get("/admin/revenue", requireDb, protect, adminOnly, getRevenue);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "EzFormat API is running",
    capabilities: {
      masterDataWorkspaces: masterDataWorkspacesEnabled,
      voucherReconstruction: voucherReconstructionEnabled,
      studentAssistant: studentAssistantEnabled,
      paymentSettlement: getPaymentSettlementReadiness().ready,
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
