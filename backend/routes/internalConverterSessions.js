const express = require("express");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { verifyConversionContextToken } = require("../services/conversionContextService");
const { getArtifact, putArtifact } = require("../services/conversionArtifactService");

const router = express.Router();
const MAX_STATE_BYTES = 2 * 1024 * 1024;

async function readState(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_STATE_BYTES) throw new Error("Artifact state exceeds the size limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function internalContext(req, sessionId, runId) {
  const expected = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
  const supplied = String(req.headers["x-converter-service-token"] || "");
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    const error = new Error("Internal service authentication failed");
    error.statusCode = 401;
    throw error;
  }
  let claims;
  try {
    claims = verifyConversionContextToken(String(req.headers["x-conversion-context"] || ""));
  } catch {
    const error = new Error("Conversion context authentication failed");
    error.statusCode = 401;
    throw error;
  }
  if (String(claims.operation_session_id || "") !== String(sessionId) || String(claims.conversion_run_id || "") !== String(runId)) {
    const error = new Error("Session or run binding does not match conversion context");
    error.statusCode = 403;
    throw error;
  }
  return claims;
}

function binding(claims, sessionId, runId, kind, revision) {
  return {
    ownerScope: claims.owner_scope,
    userId: claims.user_id,
    sessionId,
    runId,
    uploadId: claims.upload_id,
    targetTemplateId: claims.target_template_id,
    kind,
    revision,
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    res.status(Number(error.statusCode) || 500).json({ message: error.message, code: error.code });
  });
}

router.put("/:sessionId/state", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.body?.run_id || "");
  const revision = Number(req.body?.revision);
  const claims = internalContext(req, sessionId, runId);
  const bytes = Buffer.from(JSON.stringify(req.body?.state || {}), "utf8");
  const saved = await putArtifact({
    ...binding(claims, sessionId, runId, "state", revision),
    bytes,
    mime: "application/json",
    expiresAt: req.body?.expires_at,
  });
  return res.json({ session: saved, state: req.body?.state || {} });
}));

router.get("/:sessionId/state", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.query.run_id || "");
  const claims = internalContext(req, sessionId, runId);
  const found = await getArtifact({ ...binding(claims, sessionId, runId, "state", req.query.revision) });
  return res.json({ session: found.metadata, state: await readState(found.content) });
}));

router.put("/:sessionId/artifacts/:kind", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.body?.run_id || "");
  const revision = Number(req.body?.revision);
  const claims = internalContext(req, sessionId, runId);
  const bytes = Buffer.from(String(req.body?.content_base64 || ""), "base64");
  const saved = await putArtifact({
    ...binding(claims, sessionId, runId, req.params.kind, revision),
    bytes,
    sha256: req.body?.sha256,
    mime: req.body?.content_type,
    expiresAt: req.body?.expires_at,
  });
  return res.json({ artifact: saved });
}));

router.get("/:sessionId/artifacts/:kind", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.query.run_id || "");
  const claims = internalContext(req, sessionId, runId);
  const found = await getArtifact({ ...binding(claims, sessionId, runId, req.params.kind, req.query.revision) });
  res.setHeader("Content-Type", found.metadata.mime);
  res.setHeader("X-Artifact-Sha256", found.metadata.sha256);
  await pipeline(found.content, res);
}));

module.exports = router;
