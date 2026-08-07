const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const ConversionRun = require("../models/ConversionRun");
const {
  getUserConversionRuns,
} = require("../controllers/conversionRunController");

test("conversion history has a user-and-date index for newest-first queries", () => {
  const indexes = ConversionRun.schema.indexes();
  assert.ok(
    indexes.some(
      ([keys]) => keys.user === 1 && keys.createdAt === -1,
    ),
  );
});

test("user history returns only the authenticated user's conversion runs", async () => {
  assert.equal(typeof getUserConversionRuns, "function");

  const userId = new mongoose.Types.ObjectId();
  const originalUpdateMany = ConversionRun.updateMany;
  const originalCountDocuments = ConversionRun.countDocuments;
  const originalFind = ConversionRun.find;
  const countFilters = [];
  let staleFilter;
  let findFilter;

  ConversionRun.updateMany = async (filter) => {
    staleFilter = filter;
    return { modifiedCount: 0 };
  };
  ConversionRun.countDocuments = async (filter) => {
    countFilters.push(filter);
    if (filter.status === "completed") return 2;
    if (filter.status === "failed") return 1;
    if (filter.status === "processing") return 1;
    if (filter.status === "cancelled") return 0;
    return 4;
  };
  ConversionRun.find = (filter) => {
    findFilter = filter;
    const query = {
      sort() {
        return this;
      },
      skip() {
        return this;
      },
      limit() {
        return Promise.resolve([
          {
            _id: new mongoose.Types.ObjectId(),
            user: userId,
            fileName: "mua-vao.xlsx",
            fileSizeBytes: 2048,
            outputFormat: "MISA",
            status: "completed",
            createdAt: new Date("2026-08-08T01:00:00.000Z"),
          },
        ]);
      },
    };
    return query;
  };

  const req = {
    user: { _id: userId },
    query: { page: "2", limit: "5", status: "completed" },
  };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    await getUserConversionRuns(req, res);
  } finally {
    ConversionRun.updateMany = originalUpdateMany;
    ConversionRun.countDocuments = originalCountDocuments;
    ConversionRun.find = originalFind;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(String(staleFilter.user), String(userId));
  assert.equal(String(findFilter.user), String(userId));
  assert.equal(findFilter.status, "completed");
  assert.ok(countFilters.every((filter) => String(filter.user) === String(userId)));
  assert.equal(res.payload.page, 2);
  assert.equal(res.payload.limit, 5);
  assert.equal(res.payload.runs[0].fileName, "mua-vao.xlsx");
  assert.deepEqual(res.payload.stats, {
    total: 4,
    completed: 2,
    failed: 1,
    processing: 1,
    cancelled: 0,
  });
});
