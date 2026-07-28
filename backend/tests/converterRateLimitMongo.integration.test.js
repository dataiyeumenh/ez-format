const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const mongoose = require("mongoose");

const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");

const mongoUri = String(
  process.env.CONVERTER_RATE_LIMIT_TEST_MONGO_URI || "",
).trim();
const backendRoot = path.resolve(__dirname, "..");
const childScript = `
const mongoose = require("mongoose");
const { consumeConverterRateLimit } = require("./middleware/converterRateLimit");
(async () => {
  await mongoose.connect(process.env.CONVERTER_RATE_LIMIT_TEST_MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  const options = JSON.parse(process.env.CONVERTER_RATE_LIMIT_TEST_OPTIONS);
  const calls = Number(process.env.CONVERTER_RATE_LIMIT_TEST_CALLS);
  const results = await Promise.all(
    Array.from({ length: calls }, () => consumeConverterRateLimit(options)),
  );
  process.stdout.write(JSON.stringify({
    allowed: results.filter((result) => result.allowed).length,
  }));
  await mongoose.disconnect();
})().catch(async (error) => {
  process.stderr.write(String(error && error.message || error));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
`;

function runGatewayInstance(options, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", childScript], {
      cwd: backendRoot,
      env: {
        ...process.env,
        CONVERTER_RATE_LIMIT_TEST_MONGO_URI: mongoUri,
        CONVERTER_RATE_LIMIT_TEST_OPTIONS: JSON.stringify(options),
        CONVERTER_RATE_LIMIT_TEST_CALLS: String(calls),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Gateway test process failed: ${stderr || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Gateway test process returned invalid JSON: ${error.message}`));
      }
    });
  });
}

test(
  "real Mongo keeps two gateway instances atomic and enforces unique TTL buckets",
  {
    skip: mongoUri ? false : "set CONVERTER_RATE_LIMIT_TEST_MONGO_URI",
    timeout: 30000,
  },
  async () => {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    try {
      await ConverterRateLimitBucket.syncIndexes();
      await ConverterRateLimitBucket.deleteMany({});

      const indexes = await ConverterRateLimitBucket.collection.indexes();
      assert.ok(
        indexes.some(
          (index) =>
            index.unique === true &&
            index.key.userId === 1 &&
            index.key.operation === 1 &&
            index.key.bucketStart === 1,
        ),
      );
      assert.ok(
        indexes.some(
          (index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0,
        ),
      );

      const now = Date.now();
      const windowMs = 60 * 1000;
      const options = {
        userId: `mongo-concurrency-${now}`,
        operation: "analyze",
        limit: 25,
        windowMs,
        now,
      };
      const instances = await Promise.all([
        runGatewayInstance(options, 20),
        runGatewayInstance(options, 20),
      ]);
      assert.equal(
        instances.reduce((total, instance) => total + instance.allowed, 0),
        25,
      );

      const bucketStart = new Date(Math.floor(now / windowMs) * windowMs);
      const bucket = await ConverterRateLimitBucket.findOne({
        userId: options.userId,
        operation: options.operation,
        bucketStart,
      }).lean();
      assert.equal(bucket.count, 40);
      assert.equal(
        bucket.expiresAt.getTime(),
        bucketStart.getTime() + windowMs,
      );
      assert.equal(
        await ConverterRateLimitBucket.countDocuments({
          userId: options.userId,
          operation: options.operation,
          bucketStart,
        }),
        1,
      );
      await assert.rejects(
        ConverterRateLimitBucket.create({
          userId: options.userId,
          operation: options.operation,
          bucketStart,
          count: 1,
          expiresAt: new Date(now + windowMs),
        }),
        (error) => error?.code === 11000,
      );

    } finally {
      await ConverterRateLimitBucket.deleteMany({}).catch(() => {});
      await mongoose.disconnect();
    }
  },
);
