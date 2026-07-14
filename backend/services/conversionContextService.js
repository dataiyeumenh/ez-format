const jwt = require("jsonwebtoken");

function contextSecret() {
  const secret =
    process.env.CONVERSION_CONTEXT_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("CONVERSION_CONTEXT_SECRET chưa được cấu hình");
  return secret;
}

function createConversionContextToken({
  userId,
  workspaceId,
  snapshotSetHash,
  snapshotIds = [],
  masterDataRevision = 0,
  expiresIn = "10m",
}) {
  return jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: String(userId),
      workspace_id: String(workspaceId),
      snapshot_set_hash: String(snapshotSetHash),
      snapshot_ids: snapshotIds.map(String),
      master_data_revision: Number(masterDataRevision) || 0,
    },
    contextSecret(),
    { expiresIn },
  );
}

function verifyConversionContextToken(token) {
  const claims = jwt.verify(token, contextSecret());
  if (claims.purpose !== "misa_conversion") {
    throw new Error("Conversion context token không hợp lệ");
  }
  return claims;
}

module.exports = {
  createConversionContextToken,
  verifyConversionContextToken,
};
