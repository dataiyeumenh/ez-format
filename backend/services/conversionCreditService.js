const crypto = require("node:crypto");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const User = require("../models/User");
const ConversionRun = require("../models/ConversionRun");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  entitlementError,
  entitlementFromUser,
  getCurrentConversionEntitlement,
} = require("./conversionEntitlementService");
const {
  getUserPlanCode,
  normalizeDailyFileCredit,
  normalizeSubscriptionState,
  deductConversionCredit,
} = require("./subscriptionService");

const ARTIFACT_KEY_PATTERN = /^conversion-([A-Za-z0-9_-]+)-([a-f0-9]{64})\.bin$/;
const ANALYSIS_ARTIFACT_KEY_PATTERN = /^analysis-([A-Za-z0-9_-]+)-([a-f0-9]{64})\.json$/;
const PERSISTENT_OUTPUT_ARTIFACT_KEY_PATTERN =
  /^sessions\/[A-Za-z0-9._-]+\/runs\/([A-Za-z0-9_-]+)\/output\/r\d+-([a-f0-9]{64})\.bin$/;
const DEFAULT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_ARTIFACT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILES = 1000;
const DEFAULT_ARTIFACT_SWEEP_MAX_FILES = 200;
const DEFAULT_ARTIFACT_LOCK_WAIT_MS = 2000;
const DEFAULT_ARTIFACT_LOCK_STALE_SECONDS = 30;
const ARTIFACT_LOCK_FILE = ".artifact-store.lock";

function objectStorageRequired(env = process.env) {
  return String(env.CONVERTER_OBJECT_STORAGE_REQUIRED || "").trim().toLowerCase() === "true";
}

function assertLocalArtifactAllowed(env = process.env) {
  if (objectStorageRequired(env)) {
    const error = artifactError(
      503,
      "Converter artifact storage chưa được cấu hình",
      "OBJECT_STORAGE_REQUIRED",
    );
    throw error;
  }
}

function artifactMaxBytes(env = process.env) {
  const configured = Number(env.CONVERTER_ARTIFACT_MAX_BYTES || DEFAULT_ARTIFACT_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_ARTIFACT_MAX_BYTES;
  return Math.min(configured, 512 * 1024 * 1024);
}

function artifactTtlSeconds(env = process.env) {
  const configured = Number(env.CONVERTER_ARTIFACT_TTL_SECONDS || DEFAULT_ARTIFACT_TTL_SECONDS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 31 * 24 * 60 * 60)
    : DEFAULT_ARTIFACT_TTL_SECONDS;
}

function artifactMaxFiles(env = process.env) {
  const configured = Number(env.CONVERTER_ARTIFACT_MAX_FILES || DEFAULT_ARTIFACT_MAX_FILES);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 100000)
    : DEFAULT_ARTIFACT_MAX_FILES;
}

function artifactSweepMaxFiles(env = process.env) {
  const configured = Number(
    env.CONVERTER_ARTIFACT_SWEEP_MAX_FILES || DEFAULT_ARTIFACT_SWEEP_MAX_FILES,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 10000)
    : DEFAULT_ARTIFACT_SWEEP_MAX_FILES;
}

function artifactLockWaitMs(env = process.env) {
  const configured = Number(env.CONVERTER_ARTIFACT_LOCK_WAIT_MS || DEFAULT_ARTIFACT_LOCK_WAIT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 10000)
    : DEFAULT_ARTIFACT_LOCK_WAIT_MS;
}

function artifactLockStaleSeconds(env = process.env) {
  const configured = Number(
    env.CONVERTER_ARTIFACT_LOCK_STALE_SECONDS || DEFAULT_ARTIFACT_LOCK_STALE_SECONDS,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 24 * 60 * 60)
    : DEFAULT_ARTIFACT_LOCK_STALE_SECONDS;
}

function artifactDirectory(env = process.env) {
  const configured = String(env.CONVERTER_ARTIFACT_DIR || "").trim();
  return path.resolve(
    configured || path.join(process.cwd(), ".artifacts", "conversion-outputs"),
  );
}

function artifactLockPath(env = process.env) {
  return path.join(artifactDirectory(env), ARTIFACT_LOCK_FILE);
}

function artifactError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizedRunId(runId) {
  const value = String(runId || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw artifactError(400, "Conversion run id không hợp lệ", "INVALID_ARTIFACT_RUN");
  }
  return value;
}

function validateArtifactProof({ runId, artifactKey, outputSha256 }) {
  const safeRunId = normalizedRunId(runId);
  const sha = String(outputSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw artifactError(400, "Output SHA256 không hợp lệ", "INVALID_ARTIFACT_HASH");
  }
  const key = String(artifactKey || "").trim();
  const match =
    ARTIFACT_KEY_PATTERN.exec(key) ||
    ANALYSIS_ARTIFACT_KEY_PATTERN.exec(key) ||
    PERSISTENT_OUTPUT_ARTIFACT_KEY_PATTERN.exec(key);
  if (!match || match[1] !== safeRunId || match[2] !== sha) {
    throw artifactError(400, "Artifact key không hợp lệ", "INVALID_ARTIFACT_KEY");
  }
  return { runId: safeRunId, artifactKey: key, outputSha256: sha };
}

function validateExportArtifactProof(proof) {
  const normalized = validateArtifactProof(proof);
  if (
    !ARTIFACT_KEY_PATTERN.test(normalized.artifactKey) &&
    !PERSISTENT_OUTPUT_ARTIFACT_KEY_PATTERN.test(normalized.artifactKey)
  ) {
    throw artifactError(400, "Artifact export không hợp lệ", "INVALID_ARTIFACT_KEY");
  }
  return normalized;
}

function conversionArtifactKey(runId, outputSha256) {
  const safeRunId = normalizedRunId(runId);
  const sha = String(outputSha256 || "").trim().toLowerCase();
  const artifactKey = `conversion-${safeRunId}-${sha}.bin`;
  return validateArtifactProof({ runId: safeRunId, artifactKey, outputSha256: sha })
    .artifactKey;
}

function analysisArtifactKey(runId, analysisSha256) {
  const safeRunId = normalizedRunId(runId);
  const sha = String(analysisSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw artifactError(400, "Analysis SHA256 không hợp lệ", "INVALID_ARTIFACT_HASH");
  }
  return `analysis-${safeRunId}-${sha}.json`;
}

function artifactPath(proof, env = process.env) {
  validateArtifactProof(proof);
  const directory = artifactDirectory(env);
  const resolved = path.resolve(directory, proof.artifactKey);
  if (path.dirname(resolved) !== directory) {
    throw artifactError(400, "Artifact key không an toàn", "UNSAFE_ARTIFACT_KEY");
  }
  return resolved;
}

function unsafeArtifactError(code, message) {
  return artifactError(409, message, code);
}

function samePath(left, right) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

async function ensureArtifactDirectory(env = process.env, create = false) {
  assertLocalArtifactAllowed(env);
  const directory = artifactDirectory(env);
  try {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_DIRECTORY", "Artifact directory không an toàn");
    }
    const realDirectory = await fs.realpath(directory);
    if (!samePath(realDirectory, directory)) {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_DIRECTORY", "Artifact directory không an toàn");
    }
    if (create) await fs.chmod(directory, 0o700);
    return directory;
  } catch (error) {
    if (error?.code === "ENOENT" && !create) return null;
    throw error;
  }
}

async function assertRegularArtifactTarget(target) {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_TARGET", "Artifact target không an toàn");
    }
    if (!stats.isFile()) {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_TARGET", "Artifact target không an toàn");
    }
    return stats;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_TARGET", "Artifact target không an toàn");
    }
    throw error;
  }
}

async function syncDirectory(directory, fsApi = fs) {
  let handle;
  try {
    handle = await fsApi.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !(
        process.platform === "win32" &&
        error?.code === "EPERM" &&
        error?.syscall === "fsync"
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (left.dev != null && right.dev != null && left.ino != null && right.ino != null) {
    if (left.dev !== right.dev || left.ino !== right.ino) return false;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function removeIfUnchanged(target, expectedStats) {
  const current = await assertRegularArtifactTarget(target);
  if (!current || !sameFileIdentity(current, expectedStats)) return false;
  try {
    await fs.unlink(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readLockFile(lockPath) {
  let stats;
  try {
    stats = await fs.lstat(lockPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    const raw = await fs.readFile(lockPath, "utf8");
    let info = null;
    try {
      info = JSON.parse(raw);
    } catch {
      info = {};
    }
    return { stats, info: info && typeof info === "object" ? info : {} };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function lockProcessAlive(info) {
  const pid = Number(info?.pid);
  const hostname = String(info?.hostname || "");
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (hostname && hostname !== osHostname()) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function osHostname() {
  return os.hostname();
}

function lockIsStale(lock, env = process.env) {
  if (!lock) return false;
  const age = Date.now() - Number(lock.stats?.mtimeMs || 0);
  if (age < artifactLockStaleSeconds(env) * 1000) return false;
  return !lockProcessAlive(lock.info);
}

async function removeStaleLock(lockPath, env = process.env) {
  const lock = await readLockFile(lockPath);
  if (!lock || !lockIsStale(lock, env)) return false;
  return removeIfUnchanged(lockPath, lock.stats);
}

async function acquireArtifactLock(env = process.env) {
  const directory = await ensureArtifactDirectory(env, true);
  const lockPath = artifactLockPath(env);
  const deadline = Date.now() + artifactLockWaitMs(env);
  const token = crypto.randomUUID();
  let handle;
  while (true) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.chmod(0o600).catch(() => {});
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          hostname: osHostname(),
          token,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = null;
      return {
        async release() {
          const current = await readLockFile(lockPath);
          if (current?.info?.token === token) {
            await removeIfUnchanged(lockPath, current.stats);
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath, env);
      if (Date.now() >= deadline) {
        throw artifactError(503, "Artifact storage đang bận", "ARTIFACT_LOCK_TIMEOUT");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function sweepConversionArtifactsUnlocked(env = process.env) {
  const directory = await ensureArtifactDirectory(env, false);
  if (!directory) return { removed: 0 };
  const cutoff = Date.now() - artifactTtlSeconds(env) * 1000;
  const limit = artifactSweepMaxFiles(env);
  let scanned = 0;
  let removed = 0;
  const entries = await fs.opendir(directory);
  try {
    for await (const entry of entries) {
      if (scanned >= limit) break;
      scanned += 1;
      if (entry.name === ARTIFACT_LOCK_FILE) {
        await removeStaleLock(path.join(directory, entry.name), env);
        continue;
      }
      if (!entry.isFile() && !entry.name.startsWith(".tmp-")) continue;
      if (
        !entry.name.startsWith(".tmp-") &&
        !ARTIFACT_KEY_PATTERN.test(entry.name) &&
        !ANALYSIS_ARTIFACT_KEY_PATTERN.test(entry.name)
      ) continue;
      const target = path.join(directory, entry.name);
      const stats = await assertRegularArtifactTarget(target).catch(() => null);
      if (stats && stats.mtimeMs <= cutoff) {
        if (await removeIfUnchanged(target, stats)) removed += 1;
      }
    }
  } finally {
    await entries.close().catch(() => {});
  }
  return { removed };
}

async function sweepConversionArtifacts(env = process.env) {
  assertLocalArtifactAllowed(env);
  return sweepConversionArtifactsUnlocked(env);
}

async function artifactStorageUsage(env = process.env) {
  const directory = await ensureArtifactDirectory(env, false);
  if (!directory) return { count: 0, totalBytes: 0, scanLimitExceeded: false };
  const scanLimit = Math.min(
    artifactMaxFiles(env) + artifactSweepMaxFiles(env) + 1,
    100001,
  );
  let scanned = 0;
  let count = 0;
  let totalBytes = 0;
  const entries = await fs.opendir(directory);
  try {
    for await (const entry of entries) {
      scanned += 1;
      if (scanned > scanLimit) {
        return { count, totalBytes, scanLimitExceeded: true };
      }
      const isArtifact =
        ARTIFACT_KEY_PATTERN.test(entry.name) ||
        ANALYSIS_ARTIFACT_KEY_PATTERN.test(entry.name);
      const isTemporary = entry.name.startsWith(".tmp-");
      if (!isArtifact && !isTemporary) continue;
      const stats = await assertRegularArtifactTarget(path.join(directory, entry.name));
      if (!stats) continue;
      if (isArtifact) count += 1;
      totalBytes += stats.size;
      if (count >= artifactMaxFiles(env) || totalBytes >= artifactMaxBytes(env)) break;
    }
  } finally {
    await entries.close().catch(() => {});
  }
  return { count, totalBytes, scanLimitExceeded: false };
}

async function readConversionArtifact(proof, env = process.env) {
  assertLocalArtifactAllowed(env);
  const normalized = validateArtifactProof(proof);
  const directory = await ensureArtifactDirectory(env, false);
  if (!directory) return null;
  const target = artifactPath(normalized, env);
  const stats = await assertRegularArtifactTarget(target);
  if (!stats) return null;
  const cutoff = Date.now() - artifactTtlSeconds(env) * 1000;
  if (stats.mtimeMs <= cutoff) {
    await removeIfUnchanged(target, stats);
    return null;
  }
  if (!stats.isFile() || stats.size > artifactMaxBytes(env)) {
    throw artifactError(502, "Artifact conversion vượt giới hạn", "ARTIFACT_TOO_LARGE");
  }
  let bytes;
  let handle;
  try {
    const noFollow = nativeFs.constants.O_NOFOLLOW || 0;
    handle = await fs.open(target, nativeFs.constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    if (!sameFileIdentity(stats, openedStats)) return null;
    if (openedStats.mtimeMs <= cutoff) {
      await handle.close();
      handle = null;
      await removeIfUnchanged(target, openedStats);
      return null;
    }
    if (!openedStats.isFile() || openedStats.size > artifactMaxBytes(env)) {
      throw artifactError(502, "Artifact conversion vượt giới hạn", "ARTIFACT_TOO_LARGE");
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw unsafeArtifactError("UNSAFE_ARTIFACT_TARGET", "Artifact target không an toàn");
    }
    if (error?.statusCode) throw error;
    throw artifactError(503, "Không thể đọc artifact conversion", "ARTIFACT_READ_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
  if (bytes.length > artifactMaxBytes(env)) {
    throw artifactError(502, "Artifact conversion vượt giới hạn", "ARTIFACT_TOO_LARGE");
  }
  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== normalized.outputSha256) {
    throw artifactError(409, "Artifact conversion không khớp checksum", "ARTIFACT_CHECKSUM_MISMATCH");
  }
  return bytes;
}

async function writeConversionArtifact({ runId, artifactKey, outputSha256, bytes }, env = process.env) {
  assertLocalArtifactAllowed(env);
  const normalized = validateArtifactProof({ runId, artifactKey, outputSha256 });
  if (!Buffer.isBuffer(bytes)) {
    throw artifactError(400, "Artifact conversion không hợp lệ", "INVALID_ARTIFACT_BYTES");
  }
  if (bytes.length > artifactMaxBytes(env)) {
    throw artifactError(413, "Artifact conversion vượt giới hạn", "ARTIFACT_TOO_LARGE");
  }
  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== normalized.outputSha256) {
    throw artifactError(409, "Artifact conversion không khớp checksum", "ARTIFACT_CHECKSUM_MISMATCH");
  }
  const directory = await ensureArtifactDirectory(env, true);
  const lock = await acquireArtifactLock(env);
  try {
    const target = artifactPath(normalized, env);
    const existingTarget = await assertRegularArtifactTarget(target);
    if (existingTarget) {
      const existing = await readConversionArtifact(normalized, env);
      if (existing) return { key: normalized.artifactKey, created: false };
      if (await assertRegularArtifactTarget(target)) {
        throw artifactError(409, "Artifact conversion không khớp checksum", "ARTIFACT_CHECKSUM_MISMATCH");
      }
    }
    await sweepConversionArtifactsUnlocked(env);
    const usage = await artifactStorageUsage(env);
    if (
      usage.scanLimitExceeded ||
      usage.count >= artifactMaxFiles(env) ||
      usage.totalBytes > artifactMaxBytes(env) - bytes.length
    ) {
      const racedTarget = await assertRegularArtifactTarget(target);
      if (racedTarget && await readConversionArtifact(normalized, env)) {
        return { key: normalized.artifactKey, created: false };
      }
      throw artifactError(507, "Artifact storage đã vượt quota", "ARTIFACT_QUOTA_EXCEEDED");
    }
    const temporary = path.join(
      directory,
      `.tmp-${process.pid}-${crypto.randomUUID()}`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await fs.link(temporary, target);
        await fs.chmod(target, 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await readConversionArtifact(normalized, env);
        if (existing) return { key: normalized.artifactKey, created: false };
        if (await assertRegularArtifactTarget(target)) {
          throw artifactError(409, "Artifact conversion không khớp checksum", "ARTIFACT_CHECKSUM_MISMATCH");
        }
        await fs.link(temporary, target);
        await fs.chmod(target, 0o600);
      }
      await syncDirectory(directory);
      return { key: normalized.artifactKey, created: true };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.statusCode) throw error;
      throw artifactError(503, "Không thể lưu artifact conversion", "ARTIFACT_WRITE_FAILED");
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  } finally {
    await lock.release();
  }
}

function hasConversionCredit(user) {
  return entitlementFromUser(user).allowed;
}

function queryWithSession(query, session) {
  if (session && typeof query?.session === "function") return query.session(session);
  return query;
}

function ownerId(value) {
  return String(value?._id || value || "").trim();
}

function planFilterValue(user) {
  const plan = user?.plan;
  if (plan && typeof plan === "object") return plan._id || plan.id || null;
  return plan || null;
}

function idempotencyConflictError() {
  const error = new Error("Idempotency key đã được dùng cho conversion run khác");
  error.statusCode = 409;
  error.code = "CONVERSION_IDEMPOTENCY_CONFLICT";
  return error;
}

function artifactRunMismatchError() {
  const error = new Error("Artifact không thuộc conversion run");
  error.statusCode = 409;
  error.code = "ARTIFACT_RUN_MISMATCH";
  return error;
}

function cancelledRunError() {
  const error = new Error("Conversion run đã bị hủy");
  error.statusCode = 409;
  error.code = "CONVERSION_RUN_CANCELLED";
  return error;
}

function transactionUnavailableError() {
  const error = new Error("Conversion usage chưa sẵn sàng");
  error.statusCode = 503;
  error.code = "CONVERSION_USAGE_UNAVAILABLE";
  return error;
}

function resultForChargedRun(run) {
  return {
    charged: false,
    idempotent: true,
    creditChargedAt: run.creditChargedAt || null,
    usageState: run.usageState || "charged",
    exportArtifactKey: run.exportArtifactKey || "",
    inputSha256: run.inputSha256 || "",
    outputSha256: run.outputSha256 || "",
    run,
  };
}

async function findConversionRun(runId, session) {
  let query = ConversionRun.findById(runId);
  return queryWithSession(query, session);
}

async function findRunByIdempotencyKey(idempotencyKey, session = null) {
  if (!idempotencyKey) return null;
  let query = ConversionRun.findOne({ usageIdempotencyKey: idempotencyKey });
  return queryWithSession(query, session);
}

async function markChargeFailed(runId, userId) {
  if (!runId || typeof ConversionRun.updateOne !== "function") return;
  try {
    await ConversionRun.updateOne(
      {
        _id: runId,
        user: userId,
        status: { $ne: "cancelled" },
        exportArtifactKey: { $in: ["", null] },
        usageState: { $in: ["chargeable", "charge_failed", null] },
      },
      { $set: { usageState: "charge_failed" } },
    );
  } catch {
    // The original charge error is safer than exposing a persistence failure.
  }
}

function chargeUpdateForEntitlement(entitlement, user) {
  const today = entitlement.dailyFileCreditDate;
  const plan = planFilterValue(user);
  const filter = { _id: user._id, isActive: { $ne: false } };
  if (plan) filter.plan = plan;

  if (entitlement.planCode === "free") {
    if (entitlement.dailyCredit <= 0) throw entitlementError();
    return {
      filter: { ...filter, dailyFileCreditDate: today, dailyFileCredit: { $gt: 0 } },
      update: { $inc: { dailyFileCredit: -1 } },
    };
  }

  if (entitlement.planCode === "perfile") {
    if (entitlement.dailyCredit > 0) {
      return {
        filter: { ...filter, dailyFileCreditDate: today, dailyFileCredit: { $gt: 0 } },
        update: { $inc: { dailyFileCredit: -1 } },
      };
    }
    if (entitlement.fileCredit > 0) {
      return {
        filter: { ...filter, fileCredits: { $gt: 0 } },
        update: { $inc: { fileCredits: -1 } },
      };
    }
  }

  throw entitlementError();
}

async function updateUserCreditAtomically(entitlement, session) {
  if (!entitlement.metered) {
    const plan = planFilterValue(entitlement.user);
    if (!plan) throw entitlementError();
    const filter = {
      _id: entitlement.user._id,
      plan,
      isActive: { $ne: false },
      planExpiresAt: entitlement.user.planExpiresAt || null,
    };
    let query = User.findOneAndUpdate(
      filter,
      { $set: { planExpiresAt: entitlement.user.planExpiresAt || null } },
      { new: true, session, runValidators: true },
    );
    const confirmedUser = await queryWithSession(query, session);
    if (!confirmedUser) throw entitlementError();
    return false;
  }
  const { filter, update } = chargeUpdateForEntitlement(entitlement, entitlement.user);
  let query = User.findOneAndUpdate(filter, update, {
    new: true,
    session,
    runValidators: true,
  });
  const updatedUser = await queryWithSession(query, session);
  if (!updatedUser) throw entitlementError();
  return true;
}

async function updateRunUsageAtomically(
  run,
  userId,
  idempotencyKey,
  chargedAt,
  session,
  artifact = {},
) {
  const filter = {
    _id: run._id,
    user: userId,
    status: { $ne: "cancelled" },
    usageState: { $in: ["chargeable", "charge_failed", null] },
    $or: [
      { usageIdempotencyKey: idempotencyKey },
      { usageIdempotencyKey: { $exists: false } },
      { usageIdempotencyKey: "" },
    ],
  };
  const update = {
    $set: {
      usageState: "charged",
      creditChargedAt: chargedAt,
    },
  };
  if (artifact.outputSha256) {
    update.$set.outputSha256 = artifact.outputSha256;
    update.$set.exportArtifactKey = artifact.artifactKey || "";
    update.$set.status = "completed";
    update.$set.completedAt = chargedAt;
  }
  if (!run.usageIdempotencyKey) update.$set.usageIdempotencyKey = idempotencyKey;
  let query = ConversionRun.findOneAndUpdate(filter, update, {
    new: true,
    session,
    runValidators: true,
  });
  return queryWithSession(query, session);
}

async function chargeCompletedConversion({
  runId,
  userId,
  idempotencyKey = "",
  artifactKey = "",
  outputSha256 = "",
}) {
  const normalizedUserId = ownerId(userId);
  const normalizedRunId = ownerId(runId);
  const normalizedKey = String(idempotencyKey || "").trim().slice(0, 256);
  if (!normalizedRunId) {
    const error = new Error("Conversion run là bắt buộc");
    error.statusCode = 400;
    throw error;
  }
  const artifactProof = validateExportArtifactProof({
    runId: normalizedRunId,
    artifactKey,
    outputSha256,
  });
  if (
    typeof mongoose.connection.transaction !== "function" ||
    mongoose.connection.readyState !== 1
  ) {
    throw transactionUnavailableError();
  }

  let result;
  try {
    await mongoose.connection.transaction(async (session) => {
      let run = normalizedRunId
        ? await findConversionRun(normalizedRunId, session)
        : null;
      if (!run && normalizedKey) run = await findRunByIdempotencyKey(normalizedKey, session);
      if (!run) {
        const error = new Error("Không tìm thấy conversion run");
        error.statusCode = 404;
        throw error;
      }
      if (ownerId(run.user) !== normalizedUserId) {
        const error = new Error("Conversion run không thuộc người dùng này");
        error.statusCode = 403;
        throw error;
      }
      if (artifactProof.runId !== String(run._id)) throw artifactRunMismatchError();
      if (run.status === "cancelled") throw cancelledRunError();
      if (run.status === "failed") {
        const error = new Error("Conversion run không sẵn sàng để export");
        error.statusCode = 409;
        error.code = "CONVERSION_RUN_NOT_EXPORTABLE";
        throw error;
      }
      if (run.usageState === "charged") {
        if (
          !run.exportArtifactKey ||
          !run.outputSha256 ||
          run.exportArtifactKey !== artifactProof.artifactKey ||
          run.outputSha256 !== artifactProof.outputSha256
        ) {
          throw artifactRunMismatchError();
        }
        result = resultForChargedRun(run);
        return;
      }
      if (run.usageState === "not_chargeable") {
        const error = new Error("Conversion run không được tính usage");
        error.statusCode = 409;
        throw error;
      }
      if (run.usageIdempotencyKey && normalizedKey && run.usageIdempotencyKey !== normalizedKey) {
        throw idempotencyConflictError();
      }

      const entitlement = await getCurrentConversionEntitlement({
        userId: normalizedUserId,
        session,
      });
      const charged = await updateUserCreditAtomically(entitlement, session);
      const chargedAt = new Date();
      const updatedRun = await updateRunUsageAtomically(
        run,
        normalizedUserId,
        normalizedKey || run.usageIdempotencyKey || `conversion:${String(run._id)}`,
        chargedAt,
        session,
        artifactProof,
      );
      if (!updatedRun) {
        const error = new Error("Conversion usage race; retry the same request");
        error.statusCode = 409;
        error.code = "CONVERSION_USAGE_RACE";
        throw error;
      }
      result = {
        charged,
        idempotent: false,
        creditChargedAt: chargedAt,
        usageState: "charged",
        exportArtifactKey: updatedRun.exportArtifactKey || "",
        inputSha256: updatedRun.inputSha256 || "",
        outputSha256: updatedRun.outputSha256 || "",
        run: updatedRun,
      };
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const existing = normalizedKey
        ? await findRunByIdempotencyKey(normalizedKey)
        : null;
      if (
        existing &&
        String(existing._id) === normalizedRunId &&
        ownerId(existing.user) === normalizedUserId &&
        existing.usageIdempotencyKey === normalizedKey &&
        existing.usageState === "charged" &&
        existing.outputSha256 === artifactProof.outputSha256 &&
        existing.exportArtifactKey === artifactProof.artifactKey
      ) {
        return resultForChargedRun(existing);
      }
      throw idempotencyConflictError();
    }
    if (error?.code === "CONVERSION_CREDIT_UNAVAILABLE") {
      await markChargeFailed(normalizedRunId, normalizedUserId);
    }
    throw error;
  }
}

async function deductCreditForCompletedRun(userId, reconstructionRunId = null) {
  if (!reconstructionRunId) {
    const error = new Error("Conversion run là bắt buộc để charge usage");
    error.statusCode = 409;
    throw error;
  }

  let result = { charged: false, creditChargedAt: null, idempotent: false };
  await mongoose.connection.transaction(async (session) => {
    let query = VoucherReconstructionRun.findById(reconstructionRunId);
    const run = await queryWithSession(query, session);
    if (!run) {
      const error = new Error("Không tìm thấy phiên tái tạo chứng từ");
      error.statusCode = 404;
      throw error;
    }
    if (run.creditChargedAt) {
      result = {
        charged: false,
        creditChargedAt: run.creditChargedAt,
        idempotent: true,
      };
      return;
    }
    let userQuery = User.findById(userId);
    if (typeof userQuery?.populate === "function") userQuery = userQuery.populate("plan");
    const user = await queryWithSession(userQuery, session);
    if (!user) {
      const error = new Error("Không tìm thấy người dùng");
      error.statusCode = 404;
      throw error;
    }
    normalizeDailyFileCredit(user);
    normalizeSubscriptionState(user);
    if (!hasConversionCredit(user)) throw entitlementError();
    const metered = ["free", "perfile"].includes(getUserPlanCode(user));
    if (metered) deductConversionCredit(user);
    const chargedAt = new Date();
    run.creditChargedAt = chargedAt;
    await Promise.all([user.save({ session }), run.save({ session })]);
    result = { charged: metered, creditChargedAt: chargedAt, idempotent: false };
  });
  return result;
}

module.exports = {
  analysisArtifactKey,
  artifactDirectory,
  artifactMaxBytes,
  artifactMaxFiles,
  artifactSweepMaxFiles,
  artifactTtlSeconds,
  chargeCompletedConversion,
  conversionArtifactKey,
  deductCreditForCompletedRun,
  hasConversionCredit,
  readConversionArtifact,
  sweepConversionArtifacts,
  syncDirectory,
  validateArtifactProof,
  writeConversionArtifact,
};
