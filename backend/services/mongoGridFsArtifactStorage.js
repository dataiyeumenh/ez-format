const crypto = require("node:crypto");
const { compose, Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const mongoose = require("mongoose");

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const SAFE_BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function artifactError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function configuredMaxBytes(env = process.env) {
  const value = Number(env.CONVERTER_ARTIFACT_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 512 * 1024 * 1024)
    : DEFAULT_MAX_BYTES;
}

function validateBucketName(bucketName) {
  const value = String(bucketName || "").trim();
  if (!SAFE_BUCKET_NAME.test(value)) {
    throw artifactError(503, "CONVERTER_MONGODB_GRIDFS_BUCKET is invalid", "INVALID_GRIDFS_BUCKET");
  }
  return value;
}

function toReadable(bytes) {
  if (Buffer.isBuffer(bytes)) return Readable.from([bytes]);
  if (bytes instanceof Uint8Array) return Readable.from([Buffer.from(bytes)]);
  if (bytes && typeof bytes[Symbol.asyncIterator] === "function") return Readable.from(bytes);
  if (bytes && typeof bytes.pipe === "function") return bytes;
  throw artifactError(400, "Artifact bytes are required", "INVALID_ARTIFACT_CONTENT");
}

function normalizeObjectId(objectId) {
  if (objectId == null || objectId === "") {
    throw artifactError(400, "GridFS object ID is required", "INVALID_GRIDFS_OBJECT_ID");
  }
  return objectId;
}

class MongoGridFsArtifactStorageAdapter {
  constructor({ db, bucketName, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date(), GridFSBucket } = {}) {
    if (!db || typeof db !== "object") {
      throw artifactError(503, "MongoDB connection is required", "GRIDFS_DB_UNAVAILABLE");
    }
    this.db = db;
    this.bucketName = validateBucketName(bucketName);
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    this.now = now;
    const Bucket = GridFSBucket || mongoose.mongo?.GridFSBucket;
    if (typeof Bucket !== "function") {
      throw artifactError(503, "MongoDB GridFS is unavailable", "GRIDFS_UNAVAILABLE");
    }
    this.bucket = new Bucket(db, { bucketName: this.bucketName, chunkSizeBytes: 255 * 1024 });
  }

  async putArtifact({ bytes, metadata = {} } = {}) {
    const input = toReadable(bytes);
    const upload = this.bucket.openUploadStream("temporary", {
      metadata: {
        ownerScope: String(metadata.ownerScope || "").trim(),
        userId: String(metadata.userId || "").trim(),
        sessionId: String(metadata.sessionId || "").trim(),
        runId: String(metadata.runId || "").trim(),
        uploadId: String(metadata.uploadId || "").trim(),
        targetTemplateId: String(metadata.targetTemplateId || "").trim(),
        kind: String(metadata.kind || "").trim(),
        revision: Number(metadata.revision),
        mime: String(metadata.mime || metadata.contentType || "application/octet-stream").trim(),
        createdAt: this.now(),
      },
    });
    const digest = crypto.createHash("sha256");
    let sizeBytes = 0;
    let sha256;
    const bounded = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > this.maxBytes) {
          const error = artifactError(413, "Artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
          callback(error);
          return;
        }
        digest.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      await pipeline(input, bounded, upload);
      sha256 = digest.digest("hex");
      const expectedSha256 = String(metadata.sha256 || "").trim().toLowerCase();
      const expectedSize = metadata.sizeBytes == null ? null : Number(metadata.sizeBytes);
      if ((expectedSha256 && expectedSha256 !== sha256) || (expectedSize != null && expectedSize !== sizeBytes)) {
        throw artifactError(409, "Artifact checksum or size mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
      }
      return { objectId: upload.id, sha256, sizeBytes, mime: upload.options?.metadata?.mime };
    } catch (error) {
      if (!sha256) sha256 = digest.digest("hex");
      const cleaned = await this._deleteQuietly(upload.id);
      if (!cleaned) {
        error.orphanedArtifact = {
          objectId: upload.id,
          sha256,
          sizeBytes,
          mime: upload.options?.metadata?.mime || "application/octet-stream",
        };
      }
      throw error;
    }
  }

  async getArtifact({ objectId } = {}) {
    const id = normalizeObjectId(objectId);
    const file = await this._findFile(id);
    if (!file) return null;
    const sizeBytes = Number(file.length);
    if (Number.isSafeInteger(sizeBytes) && sizeBytes > this.maxBytes) {
      throw artifactError(413, "Stored artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
    }
    const reader = this.bucket.openDownloadStream(id);
    let streamedBytes = 0;
    const bounded = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.from(chunk);
        streamedBytes += buffer.length;
        if (streamedBytes > this.maxBytes) {
          callback(artifactError(413, "Stored artifact exceeds size limit", "ARTIFACT_TOO_LARGE"));
          return;
        }
        callback(null, buffer);
      },
      flush: (callback) => {
        if (Number.isSafeInteger(sizeBytes) && streamedBytes !== sizeBytes) {
          callback(artifactError(409, "Stored artifact size is inconsistent", "ARTIFACT_SIZE_MISMATCH"));
          return;
        }
        callback();
      },
    });
    // Compose keeps GridFS reader errors attached to the returned stream.
    const stream = compose(reader, bounded);
    return {
      sizeBytes,
      mime: file.metadata?.mime || file.contentType || "application/octet-stream",
      objectId: id,
      metadata: file.metadata || {},
      stream,
    };
  }

  async deleteArtifact({ objectId } = {}) {
    const id = normalizeObjectId(objectId);
    try {
      await this.bucket.delete(id);
      return { deleted: true };
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === 26) return { deleted: false };
      throw artifactError(503, "GridFS artifact delete failed", "GRIDFS_DELETE_FAILED");
    }
  }

  async findArtifactsByBinding(binding, { limit = 100 } = {}) {
    if (typeof this.bucket.find !== "function") {
      throw artifactError(503, "GridFS artifact verification is unavailable", "GRIDFS_VERIFY_FAILED");
    }
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const files = await this.bucket.find({
      "metadata.ownerScope": String(binding.ownerScope || "").trim(),
      "metadata.runId": String(binding.runId || "").trim(),
    }).limit(boundedLimit).toArray();
    return files.map((file) => ({ objectId: file._id }));
  }

  async _findFile(objectId) {
    if (typeof this.bucket.find !== "function") return { metadata: {} };
    const files = await this.bucket.find({ _id: objectId }).limit(1).toArray();
    return files[0] || null;
  }

  async _deleteQuietly(objectId) {
    if (objectId == null) return true;
    try {
      await this.bucket.delete(objectId);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === 26) return true;
      return false;
    }
  }
}

function assertMongoGridFsConfigured(env = process.env) {
  const enabled = String(env.CONVERTER_PUBLIC_PROXY_ENABLED || "false").toLowerCase() === "true" &&
    String(env.CONVERTER_GATEWAY_USAGE_READY || "false").toLowerCase() === "true";
  if (!enabled) return false;
  const missing = ["MONGO_URI", "CONVERTER_MONGODB_GRIDFS_BUCKET"].filter(
    (name) => !String(env[name] || "").trim(),
  );
  if (String(env.CONVERTER_ARTIFACT_STORAGE_DRIVER || "").trim().toLowerCase() !== "mongodb") {
    missing.push("CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb");
  }
  if (missing.length) {
    throw artifactError(503, `MongoDB/GridFS config is missing: ${missing.join(", ")}`, "GRIDFS_CONFIG_MISSING");
  }
  validateBucketName(env.CONVERTER_MONGODB_GRIDFS_BUCKET);
  return true;
}

function createMongoGridFsArtifactStorage({ env = process.env, connection = mongoose.connection, now } = {}) {
  assertMongoGridFsConfigured(env);
  const db = connection?.db;
  if (!db) throw artifactError(503, "MongoDB connection is required", "GRIDFS_DB_UNAVAILABLE");
  return new MongoGridFsArtifactStorageAdapter({
    db,
    bucketName: env.CONVERTER_MONGODB_GRIDFS_BUCKET,
    maxBytes: configuredMaxBytes(env),
    now,
  });
}

module.exports = {
  MongoGridFsArtifactStorageAdapter,
  assertMongoGridFsConfigured,
  configuredMaxBytes,
  createMongoGridFsArtifactStorage,
};
