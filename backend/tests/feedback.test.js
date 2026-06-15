const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Feedback = require("../models/Feedback");
const {
  buildFeedbackFilter,
  serializeFeedback,
  summarizeFeedback,
} = require("../services/feedbackService");

test("feedback model requires category + message and stores user snapshot", () => {
  const feedback = new Feedback({
    user: new mongoose.Types.ObjectId(),
    userNameSnapshot: "Hoàng Anh",
    userEmailSnapshot: "hoanganh@example.com",
    category: "bug",
    message: "Nút tải file bị lỗi.",
  });

  assert.equal(feedback.category, "bug");
  assert.equal(feedback.message, "Nút tải file bị lỗi.");
  assert.equal(feedback.validateSync(), undefined);
});

test("feedback category enum rejects unsupported value", () => {
  const feedback = new Feedback({
    user: new mongoose.Types.ObjectId(),
    category: "spam",
    message: "abc",
  });

  assert.match(feedback.validateSync().message, /`spam` is not a valid enum value/);
});

test("feedback requires a message", () => {
  const feedback = new Feedback({
    user: new mongoose.Types.ObjectId(),
    category: "other",
  });

  assert.match(feedback.validateSync().message, /Nội dung góp ý là bắt buộc/);
});

test("feedback serializer falls back to snapshot and maps category label", () => {
  const userId = new mongoose.Types.ObjectId();
  const item = {
    _id: new mongoose.Types.ObjectId(),
    user: { _id: userId, name: "Current Name", email: "new@example.com" },
    userNameSnapshot: "Old Name",
    userEmailSnapshot: "old@example.com",
    category: "feature",
    message: "Mong có thêm dark mode.",
    createdAt: new Date("2026-06-16T08:30:00.000Z"),
  };

  const payload = serializeFeedback(item);

  assert.equal(payload.user.name, "Old Name");
  assert.equal(payload.user.email, "old@example.com");
  assert.equal(payload.category, "feature");
  assert.equal(payload.categoryLabel, "Tính năng");
  assert.equal(payload.message, "Mong có thêm dark mode.");
});

test("feedback serializer uses populated user when snapshot empty", () => {
  const item = {
    _id: new mongoose.Types.ObjectId(),
    user: { _id: new mongoose.Types.ObjectId(), name: "Live Name", email: "live@example.com" },
    userNameSnapshot: "",
    userEmailSnapshot: "",
    category: "ui",
    message: "x",
  };

  const payload = serializeFeedback(item);

  assert.equal(payload.user.name, "Live Name");
  assert.equal(payload.categoryLabel, "Giao diện");
});

test("feedback filter supports category and date range", () => {
  const filter = buildFeedbackFilter({
    category: "bug",
    from: "2026-06-01",
    to: "2026-06-16",
  });

  assert.equal(filter.category, "bug");
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(filter.createdAt.$lte.toISOString(), "2026-06-16T23:59:59.999Z");
});

test("feedback filter ignores unsupported category", () => {
  const filter = buildFeedbackFilter({ category: "spam" });
  assert.equal(filter.category, undefined);
});

test("feedback stats count categories", () => {
  const stats = summarizeFeedback([
    { category: "bug" },
    { category: "bug" },
    { category: "feature" },
    { category: "ui" },
    { category: "other" },
  ]);

  assert.deepEqual(stats, {
    total: 5,
    bug: 2,
    feature: 1,
    ui: 1,
    other: 1,
  });
});
