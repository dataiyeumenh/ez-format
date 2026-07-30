const jwt = require("jsonwebtoken");

const MAX_STUDENT_CONTEXT_LIFETIME_SECONDS = 24 * 60 * 60;
const MIN_PRODUCTION_CONTEXT_SECRET_LENGTH = 32;
const STUDENT_ASSISTANCE_SCOPES = new Set([
  "analyze",
  "explain",
  "ask",
  "accounting_map",
  "reconcile",
  "export",
]);

function contextSecret(env = process.env) {
  const dedicated = String(env.CONVERSION_CONTEXT_SECRET || "").trim();
  if (dedicated) return dedicated;
  const environment = String(env.NODE_ENV || "").trim().toLowerCase();
  const fallbackAllowed = ["development", "test"].includes(environment) &&
    ["1", "true", "yes"].includes(String(env.CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK || "").trim().toLowerCase());
  const fallback = String(env.JWT_SECRET || "").trim();
  if (fallbackAllowed && fallback) return fallback;
  throw new Error("CONVERSION_CONTEXT_SECRET chưa được cấu hình");
}

function assertConversionContextConfig(env = process.env) {
  const secret = contextSecret(env);
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production" && secret.length < MIN_PRODUCTION_CONTEXT_SECRET_LENGTH) {
    throw new Error("CONVERSION_CONTEXT_SECRET must be at least 32 characters in production");
  }
  return true;
}

function createConversionContextToken({
  userId,
  workspaceId,
  ownerScope,
  snapshotSetHash,
  snapshotIds = [],
  masterDataRevision = 0,
  conversionContextId = "",
  conversionRunId = "",
  operationSessionId = "",
  uploadId = "",
  targetTemplateId = "",
  scopes = [],
  expiresIn = "10m",
}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) throw new Error("Conversion context thiếu user");
  const normalizedWorkspaceId = workspaceId == null || String(workspaceId).trim() === "" ? null : String(workspaceId).trim();
  const expectedOwnerScope = normalizedWorkspaceId ? `workspace:${normalizedWorkspaceId}` : `user:${normalizedUserId}`;
  if (ownerScope != null && String(ownerScope).trim() !== expectedOwnerScope) throw new Error("Conversion context owner scope không hợp lệ");
  return jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: normalizedUserId,
      owner_scope: expectedOwnerScope,
      workspace_id: normalizedWorkspaceId,
      snapshot_set_hash: snapshotSetHash == null ? null : String(snapshotSetHash),
      snapshot_ids: snapshotIds.map(String),
      master_data_revision: Number(masterDataRevision) || 0,
      conversion_context_id: String(conversionContextId || ""),
      conversion_run_id: String(conversionRunId || ""),
      operation_session_id: String(operationSessionId || ""),
      upload_id: String(uploadId || ""),
      target_template_id: String(targetTemplateId || ""),
      scopes: scopes.map(String),
    },
    contextSecret(),
    { expiresIn },
  );
}

function verifyConversionContextToken(token) {
  const claims = jwt.verify(token, contextSecret(), { algorithms: ["HS256"] });
  if (!["misa_conversion", "misa_reconstruction"].includes(claims.purpose)) {
    throw new Error("Conversion context token không hợp lệ");
  }
  return claims;
}

function createReconstructionContextToken({
  userId,
  runId,
  workspaceId = "",
  snapshotSetHash = "",
  snapshotIds = [],
  masterDataRevision = 0,
  scopes = ["analyze", "review", "approve", "export"],
  expiresIn = "24h",
}) {
  return jwt.sign(
    {
      purpose: "misa_reconstruction",
      user_id: String(userId),
      run_id: String(runId),
      workspace_id: String(workspaceId || ""),
      snapshot_set_hash: String(snapshotSetHash || ""),
      snapshot_ids: snapshotIds.map(String),
      master_data_revision: Number(masterDataRevision) || 0,
      scopes: scopes.map(String),
    },
    contextSecret(),
    { expiresIn },
  );
}

function verifyReconstructionContextToken(token, requiredScope = null) {
  const claims = jwt.verify(token, contextSecret());
  if (claims.purpose !== "misa_reconstruction") {
    throw new Error("Reconstruction context token không hợp lệ");
  }
  if (requiredScope && !(claims.scopes || []).includes(requiredScope)) {
    throw new Error(`Reconstruction context thiếu quyền ${requiredScope}`);
  }
  return claims;
}

function parseStudentContextLifetime(expiresIn) {
  if (typeof expiresIn === "number" && Number.isSafeInteger(expiresIn)) {
    if (Math.abs(expiresIn) <= MAX_STUDENT_CONTEXT_LIFETIME_SECONDS) {
      return expiresIn;
    }
  } else if (typeof expiresIn === "string") {
    const match = /^(-?\d+)([smhd])$/.exec(expiresIn);
    if (match) {
      const unitSeconds = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };
      const lifetimeSeconds = Number(match[1]) * unitSeconds[match[2]];
      if (
        Number.isSafeInteger(lifetimeSeconds) &&
        Math.abs(lifetimeSeconds) <= MAX_STUDENT_CONTEXT_LIFETIME_SECONDS
      ) {
        return lifetimeSeconds;
      }
    }
  }

  throw new Error("Student context lifetime không hợp lệ");
}

function normalizeStudentContextScopes(scopes) {
  if (!Array.isArray(scopes)) {
    throw new Error("Student context scopes không hợp lệ");
  }
  const normalized = scopes.map((scope) => String(scope).trim());
  const unsupported = normalized.find(
    (scope) => !scope || !STUDENT_ASSISTANCE_SCOPES.has(scope),
  );
  if (unsupported) {
    throw new Error(`Student context scope không được hỗ trợ: ${unsupported}`);
  }
  return normalized;
}

function createStudentContextToken({
  sessionId,
  userId,
  ownerScope,
  workspaceId = null,
  snapshotSetHash = null,
  allowedScopes = [],
  expiresIn = "10m",
  retentionExpiresAt = null,
}) {
  const normalizedOwnerScope = String(ownerScope ?? "").trim();
  if (!normalizedOwnerScope) {
    throw new Error("Student owner scope là bắt buộc");
  }
  const lifetimeSeconds = parseStudentContextLifetime(expiresIn);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const retentionSeconds = parseStudentRetentionBoundary(
    retentionExpiresAt,
    nowSeconds,
    lifetimeSeconds,
  );
  const normalizedScopes = normalizeStudentContextScopes(allowedScopes);

  return jwt.sign(
    {
      iat: nowSeconds,
      purpose: "student_file_session",
      session_id: String(sessionId),
      user_id: String(userId),
      owner_scope: normalizedOwnerScope,
      workspace_id: workspaceId == null ? null : String(workspaceId),
      snapshot_set_hash: snapshotSetHash == null ? null : String(snapshotSetHash),
      allowed_scopes: normalizedScopes,
      retention_expires_at: retentionSeconds,
    },
    contextSecret(),
    { expiresIn: lifetimeSeconds },
  );
}

function parseStudentRetentionBoundary(value, nowSeconds, lifetimeSeconds) {
  if (value == null || value === "") return nowSeconds + lifetimeSeconds;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Student retention boundary không hợp lệ");
  }
  const retentionSeconds = Math.floor(milliseconds / 1000);
  if (retentionSeconds <= nowSeconds) {
    throw new Error("Student retention boundary phải là thời điểm tương lai");
  }
  if (retentionSeconds - nowSeconds > MAX_STUDENT_CONTEXT_LIFETIME_SECONDS) {
    throw new Error("Student retention boundary không được vượt quá 24 giờ");
  }
  return retentionSeconds;
}

function verifyStudentContextToken(token, requiredScope) {
  const normalizedRequiredScope = String(requiredScope ?? "").trim();
  if (!normalizedRequiredScope) {
    throw new Error("Student context required scope là bắt buộc");
  }

  const claims = jwt.verify(token, contextSecret(), { algorithms: ["HS256"] });
  if (claims.purpose !== "student_file_session") {
    throw new Error("Student context token không hợp lệ");
  }
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Student context exp phải là thời điểm tương lai");
  }
  if (!Array.isArray(claims.allowed_scopes)) {
    throw new Error("Student context scopes không hợp lệ");
  }
  claims.allowed_scopes = normalizeStudentContextScopes(claims.allowed_scopes);
  if (!claims.allowed_scopes.includes(normalizedRequiredScope)) {
    throw new Error(`Student context thiếu quyền ${normalizedRequiredScope}`);
  }
  return claims;
}

module.exports = {
  assertConversionContextConfig,
  createStudentContextToken,
  createConversionContextToken,
  createReconstructionContextToken,
  verifyStudentContextToken,
  verifyConversionContextToken,
  verifyReconstructionContextToken,
};
