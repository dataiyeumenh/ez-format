const crypto = require("node:crypto");
const conversionArtifacts = require("../services/conversionArtifactService");
const conversionSessionStates = require("../services/conversionSessionStateService");
const {
  verifyConversionContextToken,
} = require("../services/conversionContextService");

const CONVERSION_WORKFLOW_SCOPES = [
  "analyze",
  "preview",
  "readiness",
  "confirm",
  "export",
];
const READ_SESSION_STATE_SCOPES = ["preview", "readiness", "confirm", "export"];
const READ_UPLOAD_ARTIFACT_SCOPES = ["preview", "readiness", "confirm", "export"];

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function authenticateInternalConversionRequest(
  req,
  {
    sessionId,
    runId,
    uploadId = "",
    targetTemplateId = "",
    requiredScopes = [],
    requireUploadBinding = false,
    requireTemplateBinding = false,
    allowAutoDetect = false,
  },
  env = process.env,
) {
  const expectedServiceToken = String(env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!expectedServiceToken) {
    throw httpError(503, "Converter service token is not configured", "SERVICE_TOKEN_NOT_CONFIGURED");
  }
  if (!secureTokenEquals(req.headers?.["x-converter-service-token"], expectedServiceToken)) {
    throw httpError(401, "Converter service token is invalid", "INVALID_SERVICE_TOKEN");
  }
  const contextToken = String(req.headers?.["x-conversion-context"] || "").trim();
  if (!contextToken) {
    throw httpError(401, "Signed conversion context is required", "SIGNED_CONTEXT_REQUIRED");
  }
  let claims;
  try {
    claims = verifyConversionContextToken(contextToken);
  } catch (_error) {
    throw httpError(401, "Signed conversion context is invalid", "SIGNED_CONTEXT_INVALID");
  }
  if (claims.purpose !== "misa_conversion") {
    throw httpError(401, "Signed conversion context is invalid", "SIGNED_CONTEXT_INVALID");
  }
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedSessionId || !normalizedRunId) {
    throw httpError(400, "Session and run bindings are required", "CONTEXT_BINDING_REQUIRED");
  }
  if (
    String(claims.operation_session_id || "") !== normalizedSessionId ||
    String(claims.conversion_run_id || "") !== normalizedRunId
  ) {
    throw httpError(403, "Signed context does not match this session", "CONTEXT_BINDING_MISMATCH");
  }
  if (!claims.owner_scope || !claims.user_id) {
    throw httpError(401, "Signed context is missing owner claims", "SIGNED_CONTEXT_INVALID");
  }
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (
    !Array.isArray(requiredScopes) ||
    requiredScopes.length === 0 ||
    !requiredScopes.some((scope) => scopes.includes(scope))
  ) {
    throw httpError(403, "Signed context scope is not allowed", "CONTEXT_SCOPE_MISMATCH");
  }
  const claimedUploadId = String(claims.upload_id || "").trim();
  const claimedTemplateId = String(claims.target_template_id || "").trim();
  const expectedUploadId = String(uploadId || "").trim();
  const expectedTemplateId = String(targetTemplateId || "").trim();
  const autoDetectAllowed = Boolean(allowAutoDetect && scopes.includes("analyze"));
  if (
    (expectedUploadId && claimedUploadId && claimedUploadId !== expectedUploadId) ||
    (expectedTemplateId && claimedTemplateId && claimedTemplateId !== expectedTemplateId) ||
    (!claimedTemplateId && !autoDetectAllowed) ||
    (requireUploadBinding && !claimedUploadId) ||
    (requireTemplateBinding && !claimedTemplateId) ||
    (!claimedUploadId && !scopes.includes("analyze"))
  ) {
    throw httpError(403, "Signed context binding does not match", "CONTEXT_BINDING_MISMATCH");
  }
  return claims;
}

function decodeBase64(value) {
  const normalized = String(value || "").trim();
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw httpError(400, "Artifact content_base64 is invalid", "INVALID_ARTIFACT_CONTENT");
  }
  const content = Buffer.from(normalized, "base64");
  if (content.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw httpError(400, "Artifact content_base64 is invalid", "INVALID_ARTIFACT_CONTENT");
  }
  return content;
}

function contextOwner(claims) {
  return {
    ownerScope: String(claims.owner_scope),
    userId: String(claims.user_id),
    workspaceId: claims.workspace_id == null ? null : String(claims.workspace_id),
  };
}

function contextSessionBinding(claims, state = null) {
  const stateSession = state && typeof state === "object" ? state.session : null;
  return {
    ...contextOwner(claims),
    targetTemplateId: String(
      claims.target_template_id || stateSession?.target_template_id || "",
    ).trim(),
    uploadId: String(claims.upload_id || stateSession?.upload_id || "").trim(),
  };
}

function artifactScopes(method, kind) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "output") return ["export"];
  if (normalizedKind === "upload") {
    return method === "GET" ? READ_UPLOAD_ARTIFACT_SCOPES : ["analyze"];
  }
  if (normalizedKind === "state") return READ_SESSION_STATE_SCOPES;
  return [];
}

function createInternalConversionSessionController({
  artifactService = conversionArtifacts,
  sessionStateService = conversionSessionStates,
} = {}) {
  async function putState(req, res) {
    const runId = req.body?.run_id;
    const stateSession = req.body?.state?.session || {};
    const claims = authenticateInternalConversionRequest(req, {
      sessionId: req.params?.sessionId,
      runId,
      uploadId: stateSession.upload_id,
      targetTemplateId: stateSession.target_template_id,
      requiredScopes: CONVERSION_WORKFLOW_SCOPES,
      allowAutoDetect: true,
    });
    const session = await sessionStateService.putSessionState({
      sessionId: req.params.sessionId,
      runId,
      ...contextSessionBinding(claims, req.body?.state),
      revision: req.body?.revision,
      state: req.body?.state,
      expiresAt: req.body?.expires_at,
    });
    return res.status(201).json({ success: true, session });
  }

  async function getState(req, res) {
    const runId = req.query?.run_id;
    const claims = authenticateInternalConversionRequest(req, {
      sessionId: req.params?.sessionId,
      runId,
      requiredScopes: READ_SESSION_STATE_SCOPES,
      requireUploadBinding: true,
      requireTemplateBinding: true,
    });
    const result = await sessionStateService.getSessionState({
      sessionId: req.params.sessionId,
      runId,
      uploadId: req.query?.upload_id || claims.upload_id,
      targetTemplateId: req.query?.target_template_id || claims.target_template_id,
      ...contextSessionBinding(claims),
    });
    return res.json({ success: true, session: result.metadata, state: result.state });
  }

  async function putArtifact(req, res) {
    const runId = req.body?.run_id;
    const claims = authenticateInternalConversionRequest(req, {
      sessionId: req.params?.sessionId,
      runId,
      requiredScopes: artifactScopes("PUT", req.params.kind),
      allowAutoDetect: true,
    });
    const persistedBinding = await sessionStateService.resolveSessionArtifactBinding({
      sessionId: req.params.sessionId,
      runId,
      ...contextSessionBinding(claims),
    });
    const artifact = await artifactService.putArtifact({
      sessionId: req.params.sessionId,
      runId,
      ownerScope: persistedBinding.ownerScope,
      userId: persistedBinding.userId,
      workspaceId: persistedBinding.workspaceId,
      uploadId: persistedBinding.uploadId,
      targetTemplateId: persistedBinding.targetTemplateId,
      kind: req.params.kind,
      revision: req.body?.revision,
      content: decodeBase64(req.body?.content_base64),
      contentType: req.body?.content_type,
      expiresAt: req.body?.expires_at,
      sha256: req.body?.sha256,
    });
    return res.status(201).json({ success: true, artifact });
  }

  async function getArtifact(req, res) {
    const runId = req.query?.run_id;
    const claims = authenticateInternalConversionRequest(req, {
      sessionId: req.params?.sessionId,
      runId,
      uploadId: req.query?.upload_id,
      targetTemplateId: req.query?.target_template_id,
      requiredScopes: artifactScopes("GET", req.params.kind),
      requireUploadBinding: true,
      requireTemplateBinding: true,
    });
    const result = await artifactService.getArtifact({
      sessionId: req.params.sessionId,
      runId,
      ...contextSessionBinding(claims),
      kind: req.params.kind,
      revision: req.query?.revision,
    });
    res.setHeader("Content-Type", result.metadata.contentType);
    res.setHeader("Content-Length", String(result.content.length));
    res.setHeader("X-Artifact-SHA256", result.metadata.sha256);
    res.setHeader("X-Artifact-Revision", String(result.metadata.revision));
    return res.send(result.content);
  }

  async function deleteArtifact(req, res) {
    const runId = req.query?.run_id;
    const claims = authenticateInternalConversionRequest(req, {
      sessionId: req.params?.sessionId,
      runId,
      requiredScopes: artifactScopes("DELETE", req.params.kind),
    });
    const result = await artifactService.deleteArtifact({
      sessionId: req.params.sessionId,
      runId,
      ...contextSessionBinding(claims),
      kind: req.params.kind,
      revision: req.query?.revision,
    });
    return res.json({ success: true, ...result });
  }

  return { deleteArtifact, getArtifact, getState, putArtifact, putState };
}

module.exports = {
  authenticateInternalConversionRequest,
  createInternalConversionSessionController,
  httpError,
};
