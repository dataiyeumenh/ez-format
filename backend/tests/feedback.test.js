const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Feedback = require("../models/Feedback");
const {
  RATING_LABELS,
  STATUS_LABELS,
  VALID_RATINGS,
  VALID_STATUSES,
  buildFeedbackFilter,
  serializeFeedback,
  summarizeFeedback,
} = require("../services/feedbackService");
const {
  getMyFeedback,
  rateFeedback,
  updateFeedbackStatus,
} = require("../controllers/feedbackController");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

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
  assert.equal(feedback.status, "new");
  assert.equal(feedback.validateSync(), undefined);
});

test("feedback status model and metadata expose the approved workflow", () => {
  assert.deepEqual([...VALID_STATUSES], [
    "new",
    "received",
    "in_progress",
    "resolved",
    "rejected",
  ]);
  assert.equal(STATUS_LABELS.resolved, "Đã giải quyết");

  const feedback = new Feedback({
    user: new mongoose.Types.ObjectId(),
    category: "feature",
    message: "Thêm lịch sử góp ý",
    status: "unsupported",
  });
  assert.match(feedback.validateSync().message, /unsupported/);
});

test("feedback rating model exposes the approved satisfaction choices", () => {
  assert.deepEqual([...VALID_RATINGS], [
    "satisfied",
    "very_satisfied",
    "dissatisfied",
  ]);
  assert.equal(RATING_LABELS.very_satisfied, "Vô cùng hài lòng");

  const valid = new Feedback({
    user: new mongoose.Types.ObjectId(),
    category: "feature",
    message: "Tính năng đã tốt hơn",
    status: "resolved",
    rating: "satisfied",
  });
  assert.equal(valid.validateSync(), undefined);

  valid.rating = "unsupported";
  assert.match(valid.validateSync().message, /rating/);
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
  assert.equal(payload.status, "new");
  assert.equal(payload.statusLabel, "Mới");
});

test("feedback serializer exposes status audit fields", () => {
  const updatedAt = new Date("2026-08-04T09:00:00.000Z");
  const payload = serializeFeedback({
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    category: "bug",
    message: "Đã sửa",
    status: "resolved",
    statusUpdatedAt: updatedAt,
  });

  assert.equal(payload.status, "resolved");
  assert.equal(payload.statusLabel, "Đã giải quyết");
  assert.equal(payload.statusUpdatedAt, updatedAt);
});

test("feedback serializer exposes the user's satisfaction rating", () => {
  const ratedAt = new Date("2026-08-04T10:00:00.000Z");
  const payload = serializeFeedback({
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    category: "feature",
    message: "Đã xử lý tốt",
    status: "resolved",
    rating: "very_satisfied",
    ratedAt,
  });

  assert.equal(payload.rating, "very_satisfied");
  assert.equal(payload.ratingLabel, "Vô cùng hài lòng");
  assert.equal(payload.ratedAt, ratedAt);
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

test("feedback filter supports status and treats legacy records as new", () => {
  assert.deepEqual(buildFeedbackFilter({ status: "resolved" }), {
    status: "resolved",
  });
  assert.deepEqual(buildFeedbackFilter({ status: "new" }), {
    $or: [
      { status: "new" },
      { status: { $exists: false } },
      { status: null },
    ],
  });
  assert.deepEqual(buildFeedbackFilter({ status: "unsupported" }), {});
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

test("user feedback history is scoped to the authenticated user", async () => {
  const userId = new mongoose.Types.ObjectId();
  const originalCount = Feedback.countDocuments;
  const originalFind = Feedback.find;
  let findFilter;

  Feedback.countDocuments = async (filter) => {
    assert.deepEqual(filter, { user: userId });
    return 1;
  };
  Feedback.find = (filter) => {
    findFilter = filter;
    return {
      sort() {
        return this;
      },
      skip() {
        return this;
      },
      async limit() {
        return [
          {
            _id: new mongoose.Types.ObjectId(),
            user: userId,
            category: "ui",
            message: "Cần cải thiện giao diện",
            status: "received",
            createdAt: new Date("2026-08-04T01:00:00.000Z"),
          },
        ];
      },
    };
  };

  try {
    const res = createResponse();
    await getMyFeedback({ user: { _id: userId }, query: {} }, res);
    assert.deepEqual(findFilter, { user: userId });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.feedback[0].status, "received");
  } finally {
    Feedback.countDocuments = originalCount;
    Feedback.find = originalFind;
  }
});

test("admin updates feedback status with audit metadata", async () => {
  const feedbackId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const originalUpdate = Feedback.findByIdAndUpdate;
  let capturedUpdate;

  Feedback.findByIdAndUpdate = (_id, update, options) => {
    assert.equal(String(_id), String(feedbackId));
    assert.deepEqual(options, { new: true, runValidators: true });
    capturedUpdate = update;
    return {
      async populate() {
        return {
          _id: feedbackId,
          user: new mongoose.Types.ObjectId(),
          category: "bug",
          message: "Nút tải lỗi",
          status: update.status,
          statusUpdatedAt: update.statusUpdatedAt,
        };
      },
    };
  };

  try {
    const res = createResponse();
    await updateFeedbackStatus(
      {
        params: { id: String(feedbackId) },
        body: { status: "resolved" },
        user: { _id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(capturedUpdate.status, "resolved");
    assert.equal(String(capturedUpdate.statusUpdatedBy), String(adminId));
    assert.ok(capturedUpdate.statusUpdatedAt instanceof Date);
    assert.equal(res.body.feedback.statusLabel, "Đã giải quyết");
  } finally {
    Feedback.findByIdAndUpdate = originalUpdate;
  }
});

test("admin rejects unsupported feedback status", async () => {
  const res = createResponse();
  await updateFeedbackStatus(
    {
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { status: "unsupported" },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Trạng thái.*không hợp lệ/);
});

test("user rates only their own resolved feedback", async () => {
  const feedbackId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const originalUpdate = Feedback.findOneAndUpdate;
  let capturedUpdate;

  Feedback.findOneAndUpdate = async (filter, update, options) => {
    assert.deepEqual(filter, {
      _id: String(feedbackId),
      user: userId,
      status: "resolved",
    });
    assert.deepEqual(options, { new: true, runValidators: true });
    capturedUpdate = update;
    return {
      _id: feedbackId,
      user: userId,
      category: "feature",
      message: "Đã xử lý",
      status: "resolved",
      rating: update.rating,
      ratedAt: update.ratedAt,
    };
  };

  try {
    const res = createResponse();
    await rateFeedback(
      {
        params: { id: String(feedbackId) },
        body: { rating: "very_satisfied" },
        user: { _id: userId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(capturedUpdate.rating, "very_satisfied");
    assert.ok(capturedUpdate.ratedAt instanceof Date);
    assert.equal(res.body.feedback.ratingLabel, "Vô cùng hài lòng");
  } finally {
    Feedback.findOneAndUpdate = originalUpdate;
  }
});

test("user cannot rate unresolved feedback or another user's feedback", async () => {
  const originalUpdate = Feedback.findOneAndUpdate;
  const originalExists = Feedback.exists;
  Feedback.findOneAndUpdate = async () => null;

  try {
    Feedback.exists = async () => ({ _id: "owned-feedback" });
    const unresolvedRes = createResponse();
    await rateFeedback(
      {
        params: { id: "owned-feedback" },
        body: { rating: "satisfied" },
        user: { _id: "owner" },
      },
      unresolvedRes,
    );
    assert.equal(unresolvedRes.statusCode, 409);
    assert.match(unresolvedRes.body.message, /Đã giải quyết/);

    Feedback.exists = async () => null;
    const forbiddenRes = createResponse();
    await rateFeedback(
      {
        params: { id: "other-feedback" },
        body: { rating: "dissatisfied" },
        user: { _id: "owner" },
      },
      forbiddenRes,
    );
    assert.equal(forbiddenRes.statusCode, 404);
  } finally {
    Feedback.findOneAndUpdate = originalUpdate;
    Feedback.exists = originalExists;
  }
});

test("user rating rejects unsupported values", async () => {
  const res = createResponse();
  await rateFeedback(
    {
      params: { id: "feedback-id" },
      body: { rating: "unsupported" },
      user: { _id: "owner" },
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Đánh giá.*không hợp lệ/);
});

test("feedback routes expose mine and admin-only status update", () => {
  const feedbackRouter = require("../routes/feedback");
  const middleware = feedbackRouter.stack
    .filter((layer) => !layer.route)
    .map((layer) => layer.handle.name);
  assert.deepEqual(middleware.slice(0, 2), ["protect", "requireDb"]);

  const routes = feedbackRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  assert.deepEqual(routes, [
    { path: "/mine", methods: ["get"] },
    { path: "/", methods: ["post"] },
    { path: "/:id/rating", methods: ["patch"] },
  ]);

  const adminRouter = require("../routes/admin");
  const adminRoute = adminRouter.stack.find(
    (layer) => layer.route?.path === "/feedback/:id/status",
  );
  assert.deepEqual(Object.keys(adminRoute.route.methods), ["patch"]);
});
