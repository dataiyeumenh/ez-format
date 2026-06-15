const crypto = require("crypto");

const RESET_TTL_MS = 30 * 60 * 1000; // link đặt lại mật khẩu hết hạn sau 30 phút

// Hash token để LƯU vào DB (không lưu token thô — token thô chỉ nằm trong email).
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function generateResetToken(now = new Date()) {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
  };
}

// Token hợp lệ khi: user có hash + chưa hết hạn + hash khớp.
function isResetTokenValid(user, token, now = new Date()) {
  if (!user || !user.resetPasswordTokenHash || !user.resetPasswordExpires) return false;
  if (new Date(user.resetPasswordExpires).getTime() <= now.getTime()) return false;
  return hashToken(token) === user.resetPasswordTokenHash;
}

module.exports = {
  RESET_TTL_MS,
  hashToken,
  generateResetToken,
  isResetTokenValid,
};
