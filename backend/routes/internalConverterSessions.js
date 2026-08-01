const express = require("express");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { verifyConversionContextToken } = require("../services/conversionContextService");
const {
  getArtifact,
  purgeSessionArtifacts,
  putArtifact,
} = require("../services/conversionArtifactService");
const { configuredMaxBytes } = require("../services/mongoGridFsArtifactStorage");

const router = express.Router();
const MAX_STATE_BYTES = configuredMaxBytes();
const LEGACY_NODE_JSON_MAX_BODY_BYTES = 50 * 1024 * 1024;

function legacyJsonBodyLimit(maxBytes) {
  return Math.max(
    LEGACY_NODE_JSON_MAX_BODY_BYTES,
    4 * Math.ceil(maxBytes / 3) + 64 * 1024,
  );
}

const LEGACY_JSON_BODY_BYTES = legacyJsonBodyLimit(MAX_STATE_BYTES);

function artifactError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function readState(stream, maxBytes = MAX_STATE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw artifactError(413, "Artifact state exceeds the size limit", "ARTIFACT_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function boundedBody(req, maxBytes = MAX_STATE_BYTES) {
  if (!Buffer.isBuffer(req.body)) {
    throw artifactError(400, "Raw artifact body is required", "INVALID_ARTIFACT_CONTENT");
  }
  if (req.body.length > maxBytes) {
    throw artifactError(413, "Artifact exceeds the size limit", "ARTIFACT_TOO_LARGE");
  }
  return req.body;
}

function requiredSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw artifactError(400, `${label} is invalid`, "INVALID_ARTIFACT_SHA256");
  }
  return normalized;
}

function decodeLegacyBase64(value, label) {
  if (typeof value !== "string" || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw artifactError(400, `${label} is invalid`, "INVALID_ARTIFACT_CONTENT");
  }
  return Buffer.from(value, "base64");
}

function authenticatedClaims(req) {
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
  return claims;
}

function internalContext(req, sessionId, runId) {
  const claims = req.converterClaims || authenticatedClaims(req);
  if (String(claims.operation_session_id || "") !== String(sessionId) ||
    String(claims.conversion_run_id || "") !== String(runId)) {
    const error = new Error("Session or run binding does not match conversion context");
    error.statusCode = 403;
    throw error;
  }
  return claims;
}

function authenticateInternalRequest(req, _res, next) {
  try {
    req.converterClaims = authenticatedClaims(req);
    next();
  } catch (error) {
    next(error);
  }
}

function createInternalRateLimiter({
  limit = 120,
  maxEntries = 10_000,
  now = Date.now,
  windowMs = 60_000,
} = {}) {
  const buckets = new Map();
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 120;
  const boundedEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 10_000;
  const boundedWindowMs = Number.isSafeInteger(windowMs) && windowMs > 0 ? windowMs : 60_000;

  function internalRateLimit(req, res, next) {
    const currentTime = Number(now());
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
    const claims = req.converterClaims || {};
    const key = `${String(claims.owner_scope || "")}:${String(claims.user_id || "")}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      while (buckets.size >= boundedEntries) buckets.delete(buckets.keys().next().value);
      bucket = { count: 0, resetAt: currentTime + boundedWindowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > boundedLimit) {
      if (typeof res.setHeader === "function") {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000))));
      }
      next(artifactError(429, "Internal converter rate limit exceeded", "INTERNAL_RATE_LIMITED"));
      return;
    }
    next();
  }
  internalRateLimit.bucketCount = () => buckets.size;
  return internalRateLimit;
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

function operationBinding(claims, sessionId, runId) {
  const { kind: _kind, revision: _revision, ...operation } = binding(
    claims,
    sessionId,
    runId,
    "state",
  );
  return operation;
}

async function deleteOperationArtifacts({
  claims,
  sessionId,
  runId,
  purgeArtifactsFn = purgeSessionArtifacts,
}) {
  const result = await purgeArtifactsFn(operationBinding(claims, sessionId, runId));
  if (
    result?.success !== true ||
    result?.purgeScope !== "all_artifacts" ||
    result?.remainingMetadata !== 0 ||
    result?.remainingBytes !== 0
  ) {
    const error = new Error("Operation artifact purge did not prove zero remaining data");
    error.statusCode = 503;
    error.code = "OPERATION_ARTIFACT_PURGE_INCOMPLETE";
    throw error;
  }
  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    purge_scope: "all_artifacts",
    deleted_artifacts: Number(result.deletedArtifacts || 0),
    remaining_metadata: 0,
    remaining_bytes: 0,
    remote_operation_session_deleted: true,
  };
}

async function putOperationState({
  claims,
  sessionId,
  runId,
  revision,
  expectedPriorRevision,
  expectedPriorSha256,
  expiresAt,
  bytes,
  sha256,
  allowLegacyExpectedPriorSha256 = false,
  putArtifactFn = putArtifact,
  getArtifactFn = getArtifact,
  maxBytes = MAX_STATE_BYTES,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) {
    throw artifactError(413, "Artifact state exceeds the size limit", "ARTIFACT_TOO_LARGE");
  }
  const candidateSha256 = requiredSha256(sha256, "Candidate state SHA-256");
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== candidateSha256) {
    throw artifactError(409, "Candidate state checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
  }
  JSON.parse(bytes.toString("utf8"));
  const artifactBinding = binding(claims, sessionId, runId, "state", revision);
  const saved = await putArtifactFn({
    ...artifactBinding,
    bytes,
    sha256: candidateSha256,
    expectedPriorRevision,
    expectedPriorSha256,
    allowLegacyExpectedPriorSha256,
    mime: "application/json",
    expiresAt,
  });
  const found = await getArtifactFn({ ...artifactBinding, revision: saved.revision });
  return { session: found.metadata, state: await readState(found.content, maxBytes) };
}

const deleteOperationState = deleteOperationArtifacts;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    if (res.destroyed) return;
    return next(error);
  });
}

const rawArtifactBody = express.raw({ type: () => true, limit: MAX_STATE_BYTES });
const legacyJsonBody = express.json({ type: () => true, limit: LEGACY_JSON_BODY_BYTES });
const internalRateLimit = createInternalRateLimiter({
  limit: Number(process.env.CONVERTER_INTERNAL_WRITE_RATE_LIMIT || 120),
  maxEntries: Number(process.env.CONVERTER_INTERNAL_RATE_LIMIT_MAX_KEYS || 10_000),
  windowMs: Number(process.env.CONVERTER_INTERNAL_RATE_LIMIT_WINDOW_MS || 60_000),
});

function parseArtifactBody(req, res, next) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.includes("application/json")
    ? legacyJsonBody(req, res, next)
    : rawArtifactBody(req, res, next);
}

function decodeStateWrite(req) {
  const legacy = !Buffer.isBuffer(req.body);
  const source = legacy ? req.body : req.query;
  if (!source || typeof source !== "object") {
    throw artifactError(400, "Artifact state body is invalid", "INVALID_ARTIFACT_CONTENT");
  }
  let bytes;
  const hasLegacyBase64 = legacy && Object.hasOwn(source, "state_base64");
  const hasLegacyState = legacy && Object.hasOwn(source, "state");
  if (hasLegacyBase64 && hasLegacyState) {
    throw artifactError(400, "Legacy state must use one canonical representation", "INVALID_ARTIFACT_CONTENT");
  }
  if (hasLegacyBase64) {
    bytes = decodeLegacyBase64(source.state_base64, "Legacy state base64");
    let decodedState;
    try {
      decodedState = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw artifactError(400, "Legacy state payload is invalid", "INVALID_ARTIFACT_CONTENT");
    }
    if (!decodedState || typeof decodedState !== "object" || Array.isArray(decodedState)) {
      throw artifactError(400, "Legacy state payload is invalid", "INVALID_ARTIFACT_CONTENT");
    }
  } else if (hasLegacyState) {
    const state = source.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw artifactError(400, "Legacy state payload is invalid", "INVALID_ARTIFACT_CONTENT");
    }
    bytes = Buffer.from(JSON.stringify(state), "utf8");
  } else if (!legacy) {
    bytes = boundedBody(req);
  } else {
    throw artifactError(400, "Legacy state payload is invalid", "INVALID_ARTIFACT_CONTENT");
  }
  if (bytes.length > MAX_STATE_BYTES) {
    throw artifactError(413, "Artifact state exceeds the size limit", "ARTIFACT_TOO_LARGE");
  }
  const revision = Number(source.revision);
  const expectedPriorRevision = source.expected_revision == null
    ? revision - 1
    : Number(source.expected_revision);
  const computedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    runId: String(source.run_id || ""),
    revision,
    expectedPriorRevision,
    expectedPriorSha256: String(source.expected_sha256 || ""),
    expiresAt: source.expires_at,
    bytes,
    sha256: source.sha256 || computedSha256,
    legacy,
  };
}

function decodeArtifactWrite(req) {
  const legacy = !Buffer.isBuffer(req.body);
  const source = legacy ? req.body : req.query;
  if (!source || typeof source !== "object") {
    throw artifactError(400, "Artifact body is invalid", "INVALID_ARTIFACT_CONTENT");
  }
  let bytes;
  if (legacy) {
    bytes = decodeLegacyBase64(source.content_base64, "Legacy artifact base64");
  } else {
    bytes = boundedBody(req);
  }
  if (bytes.length > MAX_STATE_BYTES) {
    throw artifactError(413, "Artifact exceeds the size limit", "ARTIFACT_TOO_LARGE");
  }
  return {
    runId: String(source.run_id || ""),
    revision: Number(source.revision),
    contentType: source.content_type,
    expiresAt: source.expires_at,
    bytes,
    sha256: source.sha256 || crypto.createHash("sha256").update(bytes).digest("hex"),
    legacy,
  };
}

router.get("/protocol", authenticateInternalRequest, internalRateLimit, (_req, res) => res.json({
  preferred: "raw-v2",
  supported: ["raw-v2", "legacy-json-v1"],
  max_artifact_bytes: MAX_STATE_BYTES,
  legacy_json_state_encoding: "base64",
  legacy_json_max_body_bytes: LEGACY_JSON_BODY_BYTES,
}));

router.put("/:sessionId/state", authenticateInternalRequest, internalRateLimit, parseArtifactBody, asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const decoded = decodeStateWrite(req);
  const runId = decoded.runId;
  const claims = internalContext(req, sessionId, runId);
  return res.json(await putOperationState({
    claims,
    sessionId,
    runId,
    revision: decoded.revision,
    expectedPriorRevision: decoded.expectedPriorRevision,
    expectedPriorSha256: decoded.expectedPriorSha256,
    expiresAt: decoded.expiresAt,
    bytes: decoded.bytes,
    sha256: decoded.sha256,
    allowLegacyExpectedPriorSha256: decoded.legacy,
  }));
}));

router.get("/:sessionId/state", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.query.run_id || "");
  const claims = internalContext(req, sessionId, runId);
  const found = await getArtifact({ ...binding(claims, sessionId, runId, "state", req.query.revision) });
  return res.json({ session: found.metadata, state: await readState(found.content) });
}));

router.delete("/:sessionId/state", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.query.run_id || "");
  const claims = internalContext(req, sessionId, runId);
  return res.json(await deleteOperationState({
    claims,
    sessionId,
    runId,
  }));
}));

router.delete("/:sessionId/artifacts", asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const runId = String(req.query.run_id || "");
  const claims = internalContext(req, sessionId, runId);
  return res.json(await deleteOperationArtifacts({ claims, sessionId, runId }));
}));

router.put("/:sessionId/artifacts/:kind", authenticateInternalRequest, internalRateLimit, parseArtifactBody, asyncRoute(async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const decoded = decodeArtifactWrite(req);
  const runId = decoded.runId;
  const claims = internalContext(req, sessionId, runId);
  const saved = await putArtifact({
    ...binding(claims, sessionId, runId, req.params.kind, decoded.revision),
    bytes: decoded.bytes,
    sha256: decoded.sha256,
    mime: decoded.contentType,
    expiresAt: decoded.expiresAt,
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
module.exports.asyncRoute = asyncRoute;
module.exports.authenticateInternalRequest = authenticateInternalRequest;
module.exports.createInternalRateLimiter = createInternalRateLimiter;
module.exports.decodeArtifactWrite = decodeArtifactWrite;
module.exports.decodeStateWrite = decodeStateWrite;
module.exports.deleteOperationArtifacts = deleteOperationArtifacts;
module.exports.deleteOperationState = deleteOperationState;
module.exports.legacyJsonBodyLimit = legacyJsonBodyLimit;
module.exports.putOperationState = putOperationState;
module.exports.readState = readState;
