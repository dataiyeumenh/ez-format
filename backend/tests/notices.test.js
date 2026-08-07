const assert = require("node:assert/strict");
const test = require("node:test");

const Notice = require("../models/Notice");
const NoticeReadState = require("../models/NoticeReadState");
const mongoose = require("mongoose");
const {
  normalizeNoticePayload,
  serializeNotice,
} = require("../services/noticeService");
const {
  createNotice,
  buildVisibilityFilter,
  listNotices,
  markNoticesRead,
} = require("../controllers/noticeController");

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

test("notice model stores required title and description with timestamps", () => {
  const recipient = new mongoose.Types.ObjectId();
  const notice = new Notice({
    title: "  Bảo trì hệ thống  ",
    description: "  Hệ thống bảo trì lúc 22:00.  ",
    recipient,
  });

  assert.equal(notice.validateSync(), undefined);
  assert.equal(notice.title, "Bảo trì hệ thống");
  assert.equal(notice.description, "Hệ thống bảo trì lúc 22:00.");
  assert.equal(String(notice.recipient), String(recipient));
  assert.equal(Notice.schema.options.timestamps, true);
  assert.ok(
    Notice.schema
      .indexes()
      .some(([fields]) => fields.recipient === 1 && fields.createdAt === -1),
  );
});

test("notice model rejects missing and oversized content", () => {
  assert.match(new Notice({}).validateSync().message, /Tiêu đề.*bắt buộc/);
  assert.match(
    new Notice({ title: "A", description: "" }).validateSync().message,
    /Nội dung.*bắt buộc/,
  );
  assert.match(
    new Notice({ title: "A".repeat(121), description: "Nội dung" })
      .validateSync().message,
    /120 ký tự/,
  );
});

test("notice read state stores one durable cursor per user", () => {
  const state = new NoticeReadState({
    user: new mongoose.Types.ObjectId(),
    readThrough: new Date("2025-08-04T02:00:00.000Z"),
  });
  assert.equal(state.validateSync(), undefined);
  assert.ok(
    NoticeReadState.schema
      .indexes()
      .some(([fields, options]) => fields.user === 1 && options.unique === true),
  );
});

test("normalizes and serializes notice API payloads", () => {
  assert.deepEqual(
    normalizeNoticePayload({
      title: "  Cập nhật mới  ",
      description: "  Đã bổ sung mẫu nhập liệu.  ",
    }),
    {
      title: "Cập nhật mới",
      description: "Đã bổ sung mẫu nhập liệu.",
    },
  );
  assert.throws(
    () => normalizeNoticePayload({ title: "", description: "Nội dung" }),
    /Tiêu đề.*bắt buộc/,
  );
  assert.throws(
    () => normalizeNoticePayload({ title: { unsafe: true }, description: "Nội dung" }),
    /Tiêu đề.*văn bản/,
  );

  assert.deepEqual(
    serializeNotice({
      _id: "notice-id",
      title: "Cập nhật mới",
      description: "Đã bổ sung mẫu nhập liệu.",
      createdAt: new Date("2026-08-04T02:00:00.000Z"),
      updatedAt: new Date("2026-08-04T02:00:00.000Z"),
    }),
    {
      id: "notice-id",
      title: "Cập nhật mới",
      description: "Đã bổ sung mẫu nhập liệu.",
      createdAt: "2026-08-04T02:00:00.000Z",
      updatedAt: "2026-08-04T02:00:00.000Z",
    },
  );
});

test("admin notice serialization includes the targeted recipient", () => {
  assert.deepEqual(
    serializeNotice(
      {
        _id: "notice-id",
        title: "Đã xử lý góp ý",
        description: "Nội dung",
        recipient: {
          _id: "user-id",
          name: "Nguyễn Minh",
          email: "minh@example.com",
        },
      },
      { includeRecipient: true },
    ).recipient,
    {
      id: "user-id",
      name: "Nguyễn Minh",
      email: "minh@example.com",
    },
  );
});

test("admin notice scopes separate broadcast and targeted records", () => {
  const admin = { _id: "admin-id", role: "admin" };
  assert.deepEqual(buildVisibilityFilter(admin, "broadcast"), {
    recipient: null,
  });
  assert.deepEqual(buildVisibilityFilter(admin, "individual"), {
    recipient: { $exists: true, $ne: null },
  });
  assert.deepEqual(buildVisibilityFilter(admin, "unknown"), {});
});

test("lists only broadcast and recipient notices with a hard maximum of 50", async () => {
  const originalFind = Notice.find;
  const originalCountDocuments = Notice.countDocuments;
  const originalFindReadState = NoticeReadState.findOne;
  let requestedLimit = null;
  Notice.find = (filter) => ({
    sort(sort) {
      assert.deepEqual(filter, {
        $or: [{ recipient: null }, { recipient: "user-id" }],
      });
      assert.deepEqual(sort, { createdAt: -1 });
      return this;
    },
    limit(limit) {
      requestedLimit = limit;
      return Promise.resolve([
        {
          _id: "notice-id",
          title: "Thông báo",
          description: "Nội dung",
          createdAt: new Date("2026-08-04T02:00:00.000Z"),
          updatedAt: new Date("2026-08-04T02:00:00.000Z"),
        },
      ]);
    },
  });
  Notice.countDocuments = async (filter) => {
    assert.deepEqual(filter, {
      $and: [
        { $or: [{ recipient: null }, { recipient: "user-id" }] },
        { createdAt: { $gt: new Date("2025-08-03T02:00:00.000Z") } },
      ],
    });
    return 3;
  };
  NoticeReadState.findOne = async (filter) => {
    assert.equal(filter.user, "user-id");
    return { readThrough: new Date("2025-08-03T02:00:00.000Z") };
  };

  try {
    const res = createResponse();
    await listNotices(
      { query: { limit: "999" }, user: { _id: "user-id" } },
      res,
    );
    assert.equal(requestedLimit, 50);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.notices[0].id, "notice-id");
    assert.equal(res.body.notices[0].isRead, false);
    assert.equal(res.body.unreadCount, 3);
    assert.equal(res.body.readCursor, "2026-08-04T02:00:00.000Z");
  } finally {
    Notice.find = originalFind;
    Notice.countDocuments = originalCountDocuments;
    NoticeReadState.findOne = originalFindReadState;
  }
});

test("admin notice list applies the selected scope and includes recipients", async () => {
  const originalFind = Notice.find;
  const originalCountDocuments = Notice.countDocuments;
  const originalFindReadState = NoticeReadState.findOne;

  Notice.find = (filter) => ({
    populate(path, fields) {
      assert.deepEqual(filter, { recipient: null });
      assert.equal(path, "recipient");
      assert.equal(fields, "name email");
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return Promise.resolve([]);
    },
  });
  Notice.countDocuments = async (filter) => {
    assert.deepEqual(filter, { recipient: null });
    return 0;
  };
  NoticeReadState.findOne = async () => null;

  try {
    const res = createResponse();
    await listNotices(
      {
        query: { scope: "broadcast" },
        user: { _id: "admin-id", role: "admin" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 0);
  } finally {
    Notice.find = originalFind;
    Notice.countDocuments = originalCountDocuments;
    NoticeReadState.findOne = originalFindReadState;
  }
});

test("marks notices read only for the authenticated user", async () => {
  const originalFindOneAndUpdate = NoticeReadState.findOneAndUpdate;
  const originalCountDocuments = Notice.countDocuments;
  const cursor = new Date("2025-08-04T02:00:00.000Z");

  NoticeReadState.findOneAndUpdate = async (filter, update, options) => {
    assert.deepEqual(filter, { user: "user-id" });
    assert.deepEqual(update, { $max: { readThrough: cursor } });
    assert.deepEqual(options, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    return { readThrough: cursor };
  };
  Notice.countDocuments = async (filter) => {
    assert.deepEqual(filter, {
      $and: [
        { $or: [{ recipient: null }, { recipient: "user-id" }] },
        { createdAt: { $gt: cursor } },
      ],
    });
    return 0;
  };

  try {
    const res = createResponse();
    await markNoticesRead(
      {
        body: { readThrough: cursor.toISOString() },
        user: { _id: "user-id" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, unreadCount: 0 });
  } finally {
    NoticeReadState.findOneAndUpdate = originalFindOneAndUpdate;
    Notice.countDocuments = originalCountDocuments;
  }
});

test("rejects an invalid notice read cursor", async () => {
  const res = createResponse();
  await markNoticesRead(
    { body: { readThrough: "not-a-date" }, user: { _id: "user-id" } },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /không hợp lệ/);
});

test("creates a validated notice", async () => {
  const originalCreate = Notice.create;
  Notice.create = async (payload) => ({
    _id: "new-notice",
    ...payload,
    createdAt: new Date("2026-08-04T02:00:00.000Z"),
    updatedAt: new Date("2026-08-04T02:00:00.000Z"),
  });

  try {
    const res = createResponse();
    await createNotice(
      { body: { title: "  Tin mới  ", description: "  Nội dung mới  " } },
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.notice.title, "Tin mới");
  } finally {
    Notice.create = originalCreate;
  }
});

test("does not expose unexpected persistence errors", async () => {
  const originalCreate = Notice.create;
  const originalConsoleError = console.error;
  Notice.create = async () => {
    throw new Error("mongodb://internal-host/notices");
  };
  console.error = () => {};

  try {
    const res = createResponse();
    await createNotice(
      { body: { title: "Tin mới", description: "Nội dung mới" } },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, "Không thể gửi thông báo");
    assert.doesNotMatch(JSON.stringify(res.body), /internal-host/);
  } finally {
    Notice.create = originalCreate;
    console.error = originalConsoleError;
  }
});

test("notice routes expose authenticated list and admin list/create only", () => {
  const publicRouter = require("../routes/notices");
  const publicRoutes = publicRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
      handlers: layer.route.stack.map((item) => item.handle.name),
    }));
  assert.deepEqual(publicRoutes, [
    {
      path: "/",
      methods: ["get"],
      handlers: ["protect", "requireDb", "listNotices"],
    },
    {
      path: "/read",
      methods: ["post"],
      handlers: ["protect", "requireDb", "markNoticesRead"],
    },
  ]);

  const adminRouter = require("../routes/admin");
  const adminMiddleware = adminRouter.stack
    .filter((layer) => !layer.route)
    .map((layer) => layer.handle.name);
  assert.deepEqual(adminMiddleware.slice(0, 3), [
    "protect",
    "adminOnly",
    "requireDb",
  ]);
  const adminRoutes = adminRouter.stack
    .filter((layer) => layer.route && layer.route.path.startsWith("/notices"))
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  assert.deepEqual(adminRoutes, [
    { path: "/notices", methods: ["get", "post"] },
  ]);
});
