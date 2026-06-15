const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RESET_TTL_MS,
  hashToken,
  generateResetToken,
  isResetTokenValid,
} = require("../services/passwordResetService");

test("generateResetToken trả token thô + hash khác nhau + hạn 30 phút", () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { token, tokenHash, expiresAt } = generateResetToken(now);
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32);
  assert.notEqual(token, tokenHash); // DB lưu hash, không lưu token thô
  assert.equal(tokenHash, hashToken(token));
  assert.equal(expiresAt.getTime(), now.getTime() + RESET_TTL_MS);
});

test("hashToken ổn định", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.notEqual(hashToken("abc"), hashToken("abd"));
});

test("isResetTokenValid: token đúng + chưa hết hạn -> true", () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { token, tokenHash } = generateResetToken(now);
  const user = {
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: new Date(now.getTime() + 10 * 60 * 1000),
  };
  assert.equal(isResetTokenValid(user, token, now), true);
});

test("isResetTokenValid: hết hạn -> false", () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { token, tokenHash } = generateResetToken(now);
  const user = {
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: new Date(now.getTime() - 1000),
  };
  assert.equal(isResetTokenValid(user, token, now), false);
});

test("isResetTokenValid: token sai -> false", () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { tokenHash } = generateResetToken(now);
  const user = {
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: new Date(now.getTime() + 10 * 60 * 1000),
  };
  assert.equal(isResetTokenValid(user, "sai-token", now), false);
});

test("isResetTokenValid: user không có token -> false", () => {
  assert.equal(isResetTokenValid({}, "x"), false);
  assert.equal(isResetTokenValid(null, "x"), false);
});
