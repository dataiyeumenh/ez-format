const crypto = require("node:crypto");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const ConversionArtifact = require("../models/ConversionArtifact");

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ARTIFACT_KINDS = new Set(["analysis", "upload", "output", "state"]);
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function storageError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function buffersEqual(left, right) {
  return Buffer.isBuffer(left) &&
    Buffer.isBuffer(right) &&
    left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

function normalizeArtifactKey(key) {
  const normalized = String(key || "").replace(/\\/g, "/").trim();
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 512 ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) => !SAFE_KEY_SEGMENT.test(segment))
  ) {
    throw storageError(400, "Artifact key is invalid", "INVALID_ARTIFACT_KEY");
  }
  return segments.join("/");
}

function localArtifactRoot(env = process.env) {
  const configured = String(env.CONVERTER_SESSION_ARTIFACT_DIR || "").trim();
  return path.resolve(
    configured || path.join(process.cwd(), ".artifacts", "converter-sessions"),
  );
}

async function regularFileOrNull(target) {
  try {
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw storageError(502, "Artifact target is unsafe", "UNSAFE_ARTIFACT_TARGET");
    }
    return stats;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

class LocalArtifactStorageAdapter {
  constructor({ rootDir } = {}) {
    this.rootDir = path.resolve(rootDir || localArtifactRoot());
  }

  targetPath(key) {
    const normalized = normalizeArtifactKey(key);
    const target = path.resolve(this.rootDir, ...normalized.split("/"));
    const rootPrefix = `${this.rootDir}${path.sep}`;
    if (!target.startsWith(rootPrefix)) {
      throw storageError(400, "Artifact key is invalid", "INVALID_ARTIFACT_KEY");
    }
    return target;
  }

  async putArtifact({ key, content }) {
    if (!Buffer.isBuffer(content)) {
      throw storageError(400, "Artifact content must be bytes", "INVALID_ARTIFACT_CONTENT");
    }
    const target = this.targetPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const existing = await regularFileOrNull(target);
    if (existing) {
      const current = await this.getArtifact({ key });
      if (buffersEqual(current, content)) {
        return { key: normalizeArtifactKey(key), created: false };
      }
      throw storageError(409, "Artifact key already exists", "ARTIFACT_KEY_CONFLICT");
    }

    const temporary = path.join(
      path.dirname(target),
      `.tmp-${process.pid}-${crypto.randomUUID()}`,
    );
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const current = await this.getArtifact({ key });
        if (!buffersEqual(current, content)) {
          throw storageError(409, "Artifact key already exists", "ARTIFACT_KEY_CONFLICT");
        }
        return { key: normalizeArtifactKey(key), created: false };
      }
      await fs.chmod(target, 0o600);
      return { key: normalizeArtifactKey(key), created: true };
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async getArtifact({ key }) {
    const target = this.targetPath(key);
    if (!(await regularFileOrNull(target))) return null;
    let handle;
    try {
      handle = await fs.open(
        target,
        nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0),
      );
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw storageError(502, "Artifact target is unsafe", "UNSAFE_ARTIFACT_TARGET");
      }
      return await handle.readFile();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async deleteArtifact({ key }) {
    const target = this.targetPath(key);
    if (!(await regularFileOrNull(target))) return { deleted: false };
    await fs.unlink(target);
    return { deleted: true };
  }
}

function objectStorageRequired(env = process.env) {
  return String(env.CONVERTER_OBJECT_STORAGE_REQUIRED || "").trim().toLowerCase() === "true";
}

function s3Configuration(env = process.env) {
  const config = {
    endpoint: String(env.CONVERTER_S3_ENDPOINT || "").trim(),
    region: String(env.CONVERTER_S3_REGION || "").trim(),
    bucket: String(env.CONVERTER_S3_BUCKET || "").trim(),
    accessKeyId: String(env.CONVERTER_S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.CONVERTER_S3_SECRET_ACCESS_KEY || "").trim(),
    sessionToken: String(env.CONVERTER_S3_SESSION_TOKEN || "").trim(),
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "sessionToken" && !value)
    .map(([key]) => key);
  return { config, missing };
}

function encodeS3Path(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class S3CompatibleArtifactStorageAdapter {
  constructor({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken = "",
    fetchImpl = global.fetch,
    now = () => new Date(),
    maxBytes = DEFAULT_MAX_BYTES,
    allowInsecureLocalhost = false,
  }) {
    this.endpoint = new URL(endpoint);
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxBytes = maxBytes;
    if (!["http:", "https:"].includes(this.endpoint.protocol) || !this.endpoint.hostname) {
      throw storageError(503, "S3 endpoint is invalid", "OBJECT_STORAGE_CONFIG_INVALID");
    }
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(
      this.endpoint.hostname.toLowerCase(),
    );
    if (
      this.endpoint.protocol !== "https:" &&
      !(allowInsecureLocalhost === true && isLoopback)
    ) {
      throw storageError(
        503,
        "S3 endpoint must use HTTPS",
        "OBJECT_STORAGE_INSECURE_ENDPOINT",
      );
    }
    if (typeof this.fetchImpl !== "function") {
      throw storageError(503, "Fetch is unavailable", "OBJECT_STORAGE_ADAPTER_UNAVAILABLE");
    }
  }

  requestUrl(key) {
    const normalized = normalizeArtifactKey(key);
    const url = new URL(this.endpoint.toString());
    const prefix = url.pathname.replace(/\/$/, "");
    url.pathname = `${prefix}/${encodeURIComponent(this.bucket)}/${encodeS3Path(normalized)}`;
    return url;
  }

  signedHeaders(method, url, content, contentType) {
    const instant = this.now();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
      throw storageError(503, "Storage signing clock is invalid", "OBJECT_STORAGE_SIGNING_FAILED");
    }
    const amzDate = instant.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(content || Buffer.alloc(0));
    const headers = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;
    if (this.sessionToken) headers["x-amz-security-token"] = this.sessionToken;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join("&");
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`;
    return { ...headers, Authorization: authorization };
  }

  async request(method, key, content = null, contentType = "") {
    const url = this.requestUrl(key);
    const headers = this.signedHeaders(method, url, content, contentType);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === "PUT" ? content : undefined,
      });
    } catch (_error) {
      throw storageError(503, "Object storage request failed", "OBJECT_STORAGE_UNAVAILABLE");
    }
    return response;
  }

  async putArtifact({ key, content, contentType = "application/octet-stream" }) {
    if (!Buffer.isBuffer(content)) {
      throw storageError(400, "Artifact content must be bytes", "INVALID_ARTIFACT_CONTENT");
    }
    const response = await this.request("PUT", key, content, contentType);
    if (!response.ok) {
      throw storageError(503, "Object storage write failed", "OBJECT_STORAGE_WRITE_FAILED");
    }
    return { key: normalizeArtifactKey(key), created: true };
  }

  async getArtifact({ key }) {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw storageError(503, "Object storage read failed", "OBJECT_STORAGE_READ_FAILED");
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > this.maxBytes) {
      throw storageError(502, "Stored artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > this.maxBytes) {
      throw storageError(502, "Stored artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
    }
    return content;
  }

  async deleteArtifact({ key }) {
    const response = await this.request("DELETE", key);
    if (response.status === 404) return { deleted: false };
    if (!response.ok) {
      throw storageError(503, "Object storage delete failed", "OBJECT_STORAGE_DELETE_FAILED");
    }
    return { deleted: true };
  }
}

function configuredMaxBytes(env = process.env) {
  const value = Number(env.CONVERTER_ARTIFACT_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 512 * 1024 * 1024)
    : DEFAULT_MAX_BYTES;
}

function configuredTombstoneRetentionMs(env = process.env) {
  const seconds = Number(env.CONVERTER_ARTIFACT_TOMBSTONE_TTL_SECONDS || 604800);
  const bounded = Number.isSafeInteger(seconds)
    ? Math.min(Math.max(seconds, 60), 31 * 24 * 60 * 60)
    : 604800;
  return bounded * 1000;
}

function configuredSweepLimit(env = process.env) {
  const value = Number(env.CONVERTER_ARTIFACT_SWEEP_MAX_FILES || 100);
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 1000) : 100;
}

function configuredSweepIntervalMs(env = process.env) {
  const seconds = Number(env.CONVERTER_ARTIFACT_SWEEP_INTERVAL_SECONDS || 300);
  const bounded = Number.isSafeInteger(seconds) ? Math.max(seconds, 60) : 300;
  return bounded * 1000;
}

function createArtifactStorageAdapter(env = process.env, dependencies = {}) {
  const driver = String(env.CONVERTER_ARTIFACT_STORAGE_DRIVER || "").trim().toLowerCase();
  const environment = String(env.NODE_ENV || "").trim().toLowerCase();
  const sharedStorageRequired = environment === "production" || objectStorageRequired(env);
  if (driver === "local" && sharedStorageRequired) {
    throw storageError(
      503,
      "Production converter artifacts require shared S3-compatible storage",
      "LOCAL_ARTIFACT_STORAGE_FORBIDDEN",
    );
  }
  const useS3 = driver === "s3" || (!driver && sharedStorageRequired);
  if (useS3) {
    const { config, missing } = s3Configuration(env);
    if (missing.length > 0) {
      throw storageError(
        503,
        `S3 artifact storage config is missing: ${missing.join(", ")}`,
        "OBJECT_STORAGE_CONFIG_MISSING",
      );
    }
    return new S3CompatibleArtifactStorageAdapter({
      ...config,
      fetchImpl: dependencies.fetchImpl || global.fetch,
      now: dependencies.now || (() => new Date()),
      maxBytes: configuredMaxBytes(env),
      allowInsecureLocalhost:
        ["development", "test"].includes(environment) &&
        String(env.CONVERTER_S3_ALLOW_INSECURE_LOCALHOST || "")
          .trim()
          .toLowerCase() === "true",
    });
  }
  if (driver && driver !== "local") {
    throw storageError(503, "Artifact storage driver is invalid", "INVALID_STORAGE_DRIVER");
  }
  const localAllowed =
    driver === "local" &&
    ["development", "test"].includes(environment) &&
    ["1", "true", "yes"].includes(
      String(env.CONVERTER_ALLOW_LOCAL_ARTIFACT_STORAGE || "")
        .trim()
        .toLowerCase(),
    );
  if (!localAllowed) {
    throw storageError(
      503,
      "Local artifact storage requires an explicit development/test override",
      "LOCAL_ARTIFACT_STORAGE_FORBIDDEN",
    );
  }
  return new LocalArtifactStorageAdapter({ rootDir: localArtifactRoot(env) });
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!SAFE_KEY_SEGMENT.test(normalized)) {
    throw storageError(400, `${label} is invalid`, "INVALID_ARTIFACT_BINDING");
  }
  return normalized;
}

function normalizeOwnerScope(value) {
  const normalized = String(value || "").trim();
  if (!/^(user|workspace):[A-Za-z0-9_-]{1,160}$/.test(normalized)) {
    throw storageError(400, "Artifact owner scope is invalid", "INVALID_ARTIFACT_OWNER");
  }
  return normalized;
}

function plainDocument(document) {
  if (!document) return null;
  return typeof document.toObject === "function" ? document.toObject() : document;
}

function createMongooseArtifactRepository(Model = ConversionArtifact) {
  return {
    async upsert(metadata) {
      let existing = await Model.findOne({
        sessionId: metadata.sessionId,
        kind: metadata.kind,
        revision: metadata.revision,
      });
      existing = plainDocument(existing);
      if (existing) {
        if (
          existing.sha256 !== metadata.sha256 ||
          existing.storageKey !== metadata.storageKey ||
          existing.ownerScope !== metadata.ownerScope ||
          existing.runId !== metadata.runId ||
          existing.uploadId !== metadata.uploadId ||
          existing.targetTemplateId !== metadata.targetTemplateId
        ) {
          throw storageError(409, "Artifact revision already exists", "ARTIFACT_REVISION_CONFLICT");
        }
        return existing;
      }
      try {
        return plainDocument(await Model.create(metadata));
      } catch (error) {
        if (error?.code !== 11000) throw error;
        existing = plainDocument(
          await Model.findOne({
            sessionId: metadata.sessionId,
            kind: metadata.kind,
            revision: metadata.revision,
          }),
        );
        if (
          !existing ||
          existing.sha256 !== metadata.sha256 ||
          existing.storageKey !== metadata.storageKey ||
          existing.ownerScope !== metadata.ownerScope ||
          existing.runId !== metadata.runId ||
          existing.uploadId !== metadata.uploadId ||
          existing.targetTemplateId !== metadata.targetTemplateId
        ) {
          throw storageError(409, "Artifact revision already exists", "ARTIFACT_REVISION_CONFLICT");
        }
        return existing;
      }
    },
    async findLatest({ sessionId, runId, kind, revision }) {
      const filter = { sessionId, runId, kind };
      if (revision != null) filter.revision = revision;
      return plainDocument(
        await Model.findOne(filter).sort({ revision: -1 }),
      );
    },
    async findExpired({ now, limit }) {
      const documents = await Model.find({
        $or: [
          { status: "deletion_pending" },
          { status: "available", expiresAt: { $lte: now } },
        ],
      })
        .sort({ expiresAt: 1 })
        .limit(limit);
      return documents.map(plainDocument);
    },
    async markStatus(storageKey, status, updates = {}) {
      const update = { $set: { status } };
      if (Object.hasOwn(updates, "purgeAt")) {
        if (updates.purgeAt == null) update.$unset = { purgeAt: 1 };
        else update.$set.purgeAt = updates.purgeAt;
      }
      await Model.updateOne({ storageKey }, update);
    },
  };
}

function createConversionArtifactService({
  repository = createMongooseArtifactRepository(),
  storageAdapter = createArtifactStorageAdapter(),
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_BYTES,
  tombstoneRetentionMs = DEFAULT_TOMBSTONE_RETENTION_MS,
} = {}) {
  function normalizeRequest(input) {
    const sessionId = normalizeIdentifier(input.sessionId, "Session id");
    const runId = normalizeIdentifier(input.runId, "Run id");
    const ownerScope = normalizeOwnerScope(input.ownerScope);
    const uploadId = normalizeIdentifier(input.uploadId, "Upload id");
    const targetTemplateId = normalizeIdentifier(input.targetTemplateId, "Target template id");
    const kind = String(input.kind || "").trim().toLowerCase();
    const revision = Number(input.revision);
    if (!ARTIFACT_KINDS.has(kind)) {
      throw storageError(400, "Artifact kind is invalid", "INVALID_ARTIFACT_KIND");
    }
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw storageError(400, "Artifact revision is invalid", "INVALID_ARTIFACT_REVISION");
    }
    return {
      sessionId,
      runId,
      ownerScope,
      uploadId,
      targetTemplateId,
      kind,
      revision,
    };
  }

  function purgeAt() {
    const retention = Number.isFinite(tombstoneRetentionMs)
      ? Math.max(60_000, tombstoneRetentionMs)
      : DEFAULT_TOMBSTONE_RETENTION_MS;
    return new Date(now().getTime() + retention);
  }

  function assertMetadataBinding(metadata, input) {
    if (metadata.ownerScope !== normalizeOwnerScope(input.ownerScope)) {
      throw storageError(403, "Artifact belongs to another owner", "ARTIFACT_OWNER_MISMATCH");
    }
    const expectedUploadId = normalizeIdentifier(input.uploadId, "Upload id");
    const expectedTemplateId = normalizeIdentifier(
      input.targetTemplateId,
      "Target template id",
    );
    if (
      metadata.uploadId !== expectedUploadId ||
      metadata.targetTemplateId !== expectedTemplateId
    ) {
      throw storageError(
        403,
        "Artifact binding does not match this conversion",
        "ARTIFACT_BINDING_MISMATCH",
      );
    }
  }

  async function retireArtifact(metadata, finalStatus) {
    try {
      const result = await storageAdapter.deleteArtifact({ key: metadata.storageKey });
      await repository.markStatus(metadata.storageKey, finalStatus, { purgeAt: purgeAt() });
      return { completed: true, deleted: Boolean(result?.deleted) };
    } catch (_error) {
      await repository.markStatus(metadata.storageKey, "deletion_pending", { purgeAt: null });
      return { completed: false, deleted: false };
    }
  }

  function assertRevisionMatch(existing, metadata) {
    if (
      existing.sha256 !== metadata.sha256 ||
      existing.storageKey !== metadata.storageKey ||
      existing.ownerScope !== metadata.ownerScope ||
      existing.runId !== metadata.runId ||
      existing.uploadId !== metadata.uploadId ||
      existing.targetTemplateId !== metadata.targetTemplateId
    ) {
      throw storageError(409, "Artifact revision already exists", "ARTIFACT_REVISION_CONFLICT");
    }
  }

  async function assertRevisionReusable(metadata) {
    if (metadata.status === "available" && new Date(metadata.expiresAt) > now()) return;
    const finalStatus = metadata.status === "available" ? "expired" : metadata.status;
    await retireArtifact(metadata, finalStatus);
    throw storageError(410, "Artifact revision has been retired", "ARTIFACT_REVISION_RETIRED");
  }

  async function putArtifact(input) {
    const binding = normalizeRequest(input);
    if (!Buffer.isBuffer(input.content)) {
      throw storageError(400, "Artifact content must be bytes", "INVALID_ARTIFACT_CONTENT");
    }
    if (input.content.length > maxBytes) {
      throw storageError(413, "Artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
    }
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now()) {
      throw storageError(400, "Artifact expiry is invalid", "INVALID_ARTIFACT_EXPIRY");
    }
    const digest = sha256(input.content);
    const expected = String(input.sha256 || digest).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || expected !== digest) {
      throw storageError(409, "Artifact checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
    }
    const suffix = binding.kind === "state" ? "json" : "bin";
    const storageKey = normalizeArtifactKey(
      `sessions/${binding.sessionId}/runs/${binding.runId}/${binding.kind}/r${binding.revision}-${digest}.${suffix}`,
    );
    const metadata = {
      ...binding,
      userId: normalizeIdentifier(input.userId, "User id"),
      workspaceId:
        input.workspaceId == null || String(input.workspaceId).trim() === ""
          ? null
          : normalizeIdentifier(input.workspaceId, "Workspace id"),
      storageKey,
      sha256: digest,
      sizeBytes: input.content.length,
      contentType: String(input.contentType || "application/octet-stream").trim(),
      expiresAt,
      status: "available",
    };
    const existing = await repository.findLatest({
      sessionId: binding.sessionId,
      runId: binding.runId,
      kind: binding.kind,
      revision: binding.revision,
    });
    if (existing) {
      assertRevisionMatch(existing, metadata);
      await assertRevisionReusable(existing);
    }
    await storageAdapter.putArtifact({
      key: storageKey,
      content: input.content,
      contentType: metadata.contentType,
      expiresAt,
    });
    try {
      const persisted = await repository.upsert(metadata);
      assertRevisionMatch(persisted, metadata);
      await assertRevisionReusable(persisted);
      return persisted;
    } catch (error) {
      await storageAdapter.deleteArtifact({ key: storageKey }).catch(() => {});
      throw error;
    }
  }

  async function getArtifact(input) {
    const sessionId = normalizeIdentifier(input.sessionId, "Session id");
    const runId = normalizeIdentifier(input.runId, "Run id");
    const kind = String(input.kind || "").trim().toLowerCase();
    const ownerScope = normalizeOwnerScope(input.ownerScope);
    const uploadId = normalizeIdentifier(input.uploadId, "Upload id");
    const targetTemplateId = normalizeIdentifier(input.targetTemplateId, "Target template id");
    if (!ARTIFACT_KINDS.has(kind)) {
      throw storageError(400, "Artifact kind is invalid", "INVALID_ARTIFACT_KIND");
    }
    let revision = null;
    if (input.revision != null && String(input.revision).trim() !== "") {
      revision = Number(input.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw storageError(400, "Artifact revision is invalid", "INVALID_ARTIFACT_REVISION");
      }
    }
    const metadata = await repository.findLatest({ sessionId, runId, kind, revision });
    if (!metadata) throw storageError(404, "Artifact was not found", "ARTIFACT_NOT_FOUND");
    assertMetadataBinding(metadata, { ownerScope, uploadId, targetTemplateId });
    if (metadata.status !== "available") {
      if (["expired", "deletion_pending"].includes(metadata.status)) {
        throw storageError(410, "Artifact has expired", "ARTIFACT_EXPIRED");
      }
      const statusCode = metadata.status === "corrupted" ? 409 : 410;
      throw storageError(statusCode, "Artifact is unavailable", "ARTIFACT_UNAVAILABLE");
    }
    if (new Date(metadata.expiresAt) <= now()) {
      const retirement = await retireArtifact(metadata, "expired");
      const error = storageError(410, "Artifact has expired", "ARTIFACT_EXPIRED");
      error.deleted = retirement.deleted;
      throw error;
    }
    const content = await storageAdapter.getArtifact({ key: metadata.storageKey });
    if (!content) {
      await repository.markStatus(metadata.storageKey, "missing", { purgeAt: purgeAt() });
      throw storageError(410, "Artifact bytes are unavailable", "ARTIFACT_GONE");
    }
    const digest = sha256(content);
    if (digest !== metadata.sha256 || content.length !== metadata.sizeBytes) {
      await retireArtifact(metadata, "corrupted");
      throw storageError(409, "Artifact checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
    }
    return { metadata, content };
  }

  async function deleteArtifact(input) {
    const found = await getArtifact(input);
    try {
      const result = await storageAdapter.deleteArtifact({ key: found.metadata.storageKey });
      await repository.markStatus(found.metadata.storageKey, "deleted", { purgeAt: purgeAt() });
      return result;
    } catch (error) {
      await repository.markStatus(found.metadata.storageKey, "deletion_pending", { purgeAt: null });
      throw error;
    }
  }

  async function sweepExpiredArtifacts({ limit = 100 } = {}) {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 100;
    const candidates = await repository.findExpired({ now: now(), limit: boundedLimit });
    let deleted = 0;
    let pending = 0;
    for (const metadata of candidates) {
      const retirement = await retireArtifact(metadata, "expired");
      if (retirement.completed) deleted += 1;
      else pending += 1;
    }
    return { scanned: candidates.length, deleted, pending };
  }

  return { deleteArtifact, getArtifact, putArtifact, sweepExpiredArtifacts };
}

let defaultService;

function activeService() {
  if (!defaultService) {
    defaultService = createConversionArtifactService({
      tombstoneRetentionMs: configuredTombstoneRetentionMs(),
    });
  }
  return defaultService;
}

function startConversionArtifactSweeper({
  service = activeService(),
  env = process.env,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  const limit = configuredSweepLimit(env);
  let running = null;
  const runOnce = () => {
    if (running) return running;
    running = Promise.resolve(service.sweepExpiredArtifacts({ limit }))
      .catch((error) => {
        logger.error?.(`[ARTIFACT_SWEEP] ${error?.message || "Sweep failed"}`);
        return { scanned: 0, deleted: 0, pending: 0, failed: true };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const ready = runOnce();
  const timer = setIntervalImpl(runOnce, configuredSweepIntervalMs(env));
  timer?.unref?.();
  return {
    ready,
    runOnce,
    stop() {
      clearIntervalImpl(timer);
    },
  };
}

function assertArtifactStorageConfigured(env = process.env) {
  createArtifactStorageAdapter(env);
  return true;
}

async function ensureConversionArtifactIndexes({ model = ConversionArtifact } = {}) {
  await model.createIndexes();
  const indexes = await model.collection.indexes();
  const legacyExpiryIndexes = indexes.filter((index) => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 &&
      index.key.expiresAt === 1 &&
      Object.hasOwn(index, "expireAfterSeconds");
  });
  for (const index of legacyExpiryIndexes) {
    await model.collection.dropIndex(index.name);
  }
  return { droppedIndexes: legacyExpiryIndexes.map((index) => index.name) };
}

module.exports = {
  LocalArtifactStorageAdapter,
  S3CompatibleArtifactStorageAdapter,
  assertArtifactStorageConfigured,
  createConversionArtifactService,
  createArtifactStorageAdapter,
  deleteArtifact: (...args) => activeService().deleteArtifact(...args),
  ensureConversionArtifactIndexes,
  getArtifact: (...args) => activeService().getArtifact(...args),
  localArtifactRoot,
  normalizeArtifactKey,
  objectStorageRequired,
  putArtifact: (...args) => activeService().putArtifact(...args),
  sweepExpiredArtifacts: (...args) => activeService().sweepExpiredArtifacts(...args),
  s3Configuration,
  startConversionArtifactSweeper,
  storageError,
};
