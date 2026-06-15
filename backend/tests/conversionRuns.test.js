const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const ConversionRun = require("../models/ConversionRun");
const {
  buildConversionRunFilter,
  formatBytes,
  serializeConversionRun,
  summarizeConversionRuns,
} = require("../services/conversionRunService");

test("conversion run model stores metadata only and defaults to MISA processing", () => {
  const run = new ConversionRun({
    user: new mongoose.Types.ObjectId(),
    userNameSnapshot: "Hoàng Anh",
    userEmailSnapshot: "hoanganh@example.com",
    fileName: "raw.xlsx",
    fileSizeBytes: 1234567,
  });

  assert.equal(run.outputFormat, "MISA");
  assert.equal(run.status, "processing");
  assert.equal(run.fileName, "raw.xlsx");
  assert.equal(run.fileSizeBytes, 1234567);
  assert.equal(run.uploadBlob, undefined);
  assert.equal(run.validateSync(), undefined);
});

test("conversion run status enum rejects unsupported status", () => {
  const run = new ConversionRun({
    user: new mongoose.Types.ObjectId(),
    fileName: "raw.xlsx",
    fileSizeBytes: 1,
    status: "done",
  });

  assert.match(run.validateSync().message, /`done` is not a valid enum value/);
});

test("conversion run serializer formats admin row", () => {
  const userId = new mongoose.Types.ObjectId();
  const run = {
    _id: new mongoose.Types.ObjectId(),
    user: { _id: userId, name: "Current Name", email: "new@example.com" },
    userNameSnapshot: "Old Name",
    userEmailSnapshot: "old@example.com",
    fileName: "Chi tiết bán hàng.xlsx",
    fileSizeBytes: 1048576,
    outputFormat: "MISA",
    status: "completed",
    createdAt: new Date("2026-06-15T08:30:00.000Z"),
    startedAt: new Date("2026-06-15T08:30:00.000Z"),
    completedAt: new Date("2026-06-15T08:31:00.000Z"),
  };

  const payload = serializeConversionRun(run);

  assert.equal(payload.user.name, "Old Name");
  assert.equal(payload.user.email, "old@example.com");
  assert.equal(payload.fileName, "Chi tiết bán hàng.xlsx");
  assert.equal(payload.format, "MISA");
  assert.equal(payload.size, "1 MB");
  assert.equal(payload.status, "completed");
});

test("conversion run stats count statuses", () => {
  const stats = summarizeConversionRuns([
    { status: "completed" },
    { status: "completed" },
    { status: "failed" },
    { status: "processing" },
    { status: "cancelled" },
  ]);

  assert.deepEqual(stats, {
    total: 5,
    completed: 2,
    failed: 1,
    processing: 1,
    cancelled: 1,
  });
});

test("conversion run filter supports status and date range", () => {
  const filter = buildConversionRunFilter({
    status: "failed",
    from: "2026-06-01",
    to: "2026-06-15",
  });

  assert.equal(filter.status, "failed");
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(filter.createdAt.$lte.toISOString(), "2026-06-15T23:59:59.999Z");
});

test("formatBytes uses compact MB display", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1048576 * 4.2), "4.2 MB");
});
