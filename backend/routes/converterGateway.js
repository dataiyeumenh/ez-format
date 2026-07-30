const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const { forwardJson, forwardMultipart, forwardBinary } = require("../services/converterGatewayService");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20 * 1024 * 1024), files: 1 },
  fileFilter(_req, file, callback) {
    if ([".xls", ".xlsx"].includes(path.extname(file.originalname).toLowerCase())) return callback(null, true);
    const error = new Error("Only .xls and .xlsx files are supported");
    error.statusCode = 400;
    return callback(error);
  },
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function gatewayContext(req) {
  return String(req.headers["x-conversion-context"] || "").trim();
}

function sendUpstream(response, res) {
  for (const [name, value] of Object.entries(response.headers || {})) res.setHeader(name, value);
  if (Buffer.isBuffer(response.data)) return res.status(response.status).send(response.data);
  return res.status(response.status).json(response.data == null ? {} : response.data);
}

function mergeGatewayCapabilities(payload = {}, env = process.env) {
  const backendStudentEnabled =
    String(env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
  return {
    ...payload,
    capabilities: {
      ...(payload.capabilities || {}),
      studentAssistant: Boolean(
        backendStudentEnabled && payload.capabilities?.studentAssistant,
      ),
    },
    gateway: true,
    artifactStorage: "mongodb-gridfs",
  };
}

router.get("/capabilities", requireDb, protect, asyncRoute(async (req, res) => {
  const response = await forwardJson({
    path: "/healthz",
    method: "GET",
    requestId: req.requestId,
    requireContext: false,
  });
  return res.status(response.status).json(mergeGatewayCapabilities(response.data));
}));
router.get("/templates", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/templates", method: "GET", contextToken: gatewayContext(req), requestId: req.requestId, requireContext: false }), res)));
router.post("/uploads/analyze", requireDb, protect, upload.single("file"), asyncRoute(async (req, res) => sendUpstream(await forwardMultipart({ path: "/api/v1/uploads/analyze", file: req.file, fields: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/preview", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/preview", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/readiness", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/readiness", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/confirm", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/confirm", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/conversions/export", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardBinary({ path: "/api/v1/conversions/export", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));

module.exports = { mergeGatewayCapabilities, router };
