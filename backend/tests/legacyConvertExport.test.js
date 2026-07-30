const assert = require("node:assert/strict");
const test = require("node:test");

const controllerPath = require.resolve("../controllers/convertController");
const gatewayServicePath = require.resolve("../services/converterGatewayService");
const writerPath = require.resolve("../utils/misaWriter");

function responseRecorder() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

async function withMockedController({ forwardBinary, buildMisaExcel }, run) {
  const previousController = require.cache[controllerPath];
  const previousGateway = require.cache[gatewayServicePath];
  const previousWriter = require.cache[writerPath];

  require.cache[gatewayServicePath] = {
    id: gatewayServicePath,
    filename: gatewayServicePath,
    loaded: true,
    exports: { forwardBinary },
  };
  require.cache[writerPath] = {
    id: writerPath,
    filename: writerPath,
    loaded: true,
    exports: {
      MISA_HEADERS: ["Ngày hạch toán"],
      buildMisaExcel,
    },
  };
  delete require.cache[controllerPath];

  try {
    await run(require(controllerPath));
  } finally {
    if (previousController) require.cache[controllerPath] = previousController;
    else delete require.cache[controllerPath];
    if (previousGateway) require.cache[gatewayServicePath] = previousGateway;
    else delete require.cache[gatewayServicePath];
    if (previousWriter) require.cache[writerPath] = previousWriter;
    else delete require.cache[writerPath];
  }
}

test("legacy rows-only export is gone and never invokes a workbook writer", async () => {
  let writerCalls = 0;
  let gatewayCalls = 0;

  await withMockedController(
    {
      buildMisaExcel() {
        writerCalls += 1;
        return Buffer.from("unsafe-generated-workbook");
      },
      async forwardBinary() {
        gatewayCalls += 1;
        throw new Error("gateway must not run");
      },
    },
    async ({ exportExcel }) => {
      const res = responseRecorder();
      await exportExcel({ body: { rows: [{ value: "legacy" }] }, headers: {} }, res);

      assert.equal(res.statusCode, 410);
      assert.equal(res.body.code, "LEGACY_MISA_EXPORT_RETIRED");
      assert.equal(res.body.migration_endpoint, "/api/converter/conversions/export");
    },
  );

  assert.equal(writerCalls, 0);
  assert.equal(gatewayCalls, 0);
});

test("partial canonical export binding fails with a migration contract and no file", async () => {
  let writerCalls = 0;
  let gatewayCalls = 0;

  await withMockedController(
    {
      buildMisaExcel() {
        writerCalls += 1;
        return Buffer.from("unsafe-generated-workbook");
      },
      async forwardBinary() {
        gatewayCalls += 1;
        throw new Error("gateway must not run");
      },
    },
    async ({ exportExcel }) => {
      const res = responseRecorder();
      await exportExcel(
        {
          body: {
            upload_id: "upload-1",
            profile_id: "profile-1",
            conversion_context_token: "context-token",
            rows: [{ value: "edited" }],
          },
          headers: {},
        },
        res,
      );

      assert.equal(res.statusCode, 422);
      assert.equal(res.body.code, "MISA_TEMPLATE_EXPORT_CONTEXT_REQUIRED");
      assert.deepEqual(res.body.missing_fields, ["conversion_run_id"]);
    },
  );

  assert.equal(writerCalls, 0);
  assert.equal(gatewayCalls, 0);
});

test("complete legacy request delegates only to the canonical real-template export", async () => {
  const workbook = Buffer.from("real-purchase-or-sales-template-workbook");
  const calls = [];
  let writerCalls = 0;

  await withMockedController(
    {
      buildMisaExcel() {
        writerCalls += 1;
        return Buffer.from("unsafe-generated-workbook");
      },
      async forwardBinary(request) {
        calls.push(request);
        return {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="Import MISA purchase.xls"',
            "content-type": "application/vnd.ms-excel",
          },
          data: workbook,
        };
      },
    },
    async ({ exportExcel }) => {
      const body = {
        upload_id: "upload-1",
        profile_id: "profile-1",
        conversion_run_id: "run-1",
        target_template_id: "purchase_goods",
        acknowledge_warnings: true,
      };
      const res = responseRecorder();

      await exportExcel(
        {
          body,
          headers: { "x-conversion-context": "context-token" },
          requestId: "request-1",
        },
        res,
      );

      assert.equal(res.statusCode, 200);
      assert.strictEqual(res.body, workbook);
      assert.equal(res.headers["content-type"], "application/vnd.ms-excel");
      assert.equal(
        res.headers["content-disposition"],
        'attachment; filename="Import MISA purchase.xls"',
      );
      assert.deepEqual(calls, [
        {
          path: "/api/v1/conversions/export",
          body,
          contextToken: "context-token",
          requestId: "request-1",
        },
      ]);
    },
  );

  assert.equal(writerCalls, 0);
});

test("legacy export route gates migration before canonical authentication", () => {
  delete require.cache[require.resolve("../routes/convert")];
  const router = require("../routes/convert");
  const exportRoute = router.stack.find((layer) => layer.route?.path === "/export");

  assert.ok(exportRoute);
  assert.deepEqual(
    exportRoute.route.stack.map((layer) => layer.handle.name),
    ["legacyExportMigrationGate", "requireDb", "protect", "exportExcel"],
  );
});

test("legacy writer exposes preview headers but no workbook-generation API", () => {
  const writer = require("../utils/misaWriter");

  assert.ok(Array.isArray(writer.MISA_HEADERS));
  assert.equal(writer.buildMisaExcel, undefined);
  assert.equal(writer.ensureTemplate, undefined);
});
