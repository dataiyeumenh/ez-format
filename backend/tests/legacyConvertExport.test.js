const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const { createConversionContextToken } = require("../services/conversionContextService");

const controllerPath = require.resolve("../controllers/convertController");
const gatewayServicePath = require.resolve("../services/converterGatewayService");
const writerPath = require.resolve("../utils/misaWriter");
const CONTEXT_SECRET = "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc";

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

  const gatewayService = require(gatewayServicePath);
  require.cache[gatewayServicePath] = {
    id: gatewayServicePath,
    filename: gatewayServicePath,
    loaded: true,
    exports: { ...gatewayService, forwardBinary },
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

async function withConversionContextSecret(run) {
  const previous = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERSION_CONTEXT_SECRET = CONTEXT_SECRET;
  try {
    return await run();
  } finally {
    if (previous == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previous;
  }
}

function completeExportBody() {
  return {
    upload_id: "upload-1",
    profile_id: "profile-1",
    conversion_run_id: "run-1",
    target_template_id: "purchase_goods",
    acknowledge_warnings: true,
  };
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

  await withConversionContextSecret(async () => {
    const contextToken = createConversionContextToken({
      userId: "user-1",
      workspaceId: "workspace-1",
    });

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
        const body = completeExportBody();
        const res = responseRecorder();

        await exportExcel(
          {
            body,
            headers: { "x-conversion-context": contextToken },
            requestId: "request-1",
            user: { _id: "user-1" },
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
            contextToken,
            requestId: "request-1",
          },
        ]);
      },
    );
  });

  assert.equal(writerCalls, 0);
});

test("bound legacy export rejects replayed, malformed, expired, and inconsistent contexts", async () => {
  await withConversionContextSecret(async () => {
    const signedClaims = {
      purpose: "misa_conversion",
      user_id: "user-1",
      workspace_id: "workspace-1",
      owner_scope: "workspace:workspace-1",
    };
    const cases = [
      {
        name: "cross-user replay",
        token: createConversionContextToken({ userId: "user-1", workspaceId: "workspace-1" }),
        user: { _id: "user-2" },
        status: 403,
        code: "CONVERSION_CONTEXT_USER_MISMATCH",
      },
      {
        name: "malformed token",
        token: "not-a-signed-context",
        user: { _id: "user-1" },
        status: 401,
        code: "INVALID_CONVERSION_CONTEXT",
      },
      {
        name: "expired token",
        token: createConversionContextToken({
          userId: "user-1",
          workspaceId: "workspace-1",
          expiresIn: -1,
        }),
        user: { _id: "user-1" },
        status: 401,
        code: "INVALID_CONVERSION_CONTEXT",
      },
      {
        name: "malformed workspace claim",
        token: jwt.sign(
          { ...signedClaims, workspace_id: " workspace-1" },
          CONTEXT_SECRET,
          { algorithm: "HS256", expiresIn: "10m" },
        ),
        user: { _id: "user-1" },
        status: 401,
        code: "INVALID_CONVERSION_CONTEXT",
      },
      {
        name: "owner mismatch",
        token: jwt.sign(
          { ...signedClaims, owner_scope: "user:user-1" },
          CONTEXT_SECRET,
          { algorithm: "HS256", expiresIn: "10m" },
        ),
        user: { _id: "user-1" },
        status: 401,
        code: "INVALID_CONVERSION_CONTEXT",
      },
    ];
    let gatewayCalls = 0;

    await withMockedController(
      {
        async forwardBinary() {
          gatewayCalls += 1;
          throw new Error("gateway must not run");
        },
      },
      async ({ exportExcel }) => {
        const previousConsoleError = console.error;
        console.error = () => {};
        try {
          for (const scenario of cases) {
            const res = responseRecorder();
            await exportExcel(
              {
                body: completeExportBody(),
                headers: { "x-conversion-context": scenario.token },
                requestId: "request-1",
                user: scenario.user,
              },
              res,
            );
            assert.equal(res.statusCode, scenario.status, scenario.name);
            assert.equal(res.body.code, scenario.code, scenario.name);
          }
        } finally {
          console.error = previousConsoleError;
        }
      },
    );

    assert.equal(gatewayCalls, 0);
  });
});

function loadConvertRouter() {
  delete require.cache[require.resolve("../routes/convert")];
  return require("../routes/convert");
}

test("legacy convert router is an unconditional all-method tombstone", () => {
  const router = loadConvertRouter();
  const routes = router.stack.filter((layer) => layer.route);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].route.path, "*");
  assert.equal(routes[0].route.methods._all, true);
  assert.deepEqual(
    routes[0].route.stack.map((layer) => layer.handle.name),
    ["legacyConvertGone"],
  );
});

test("anonymous 20 MiB legacy upload gets 410 without multipart conversion", async () => {
  const app = express();
  app.use("/api/convert", loadConvertRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/convert`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=never-closed" },
      body: Buffer.alloc(20 * 1024 * 1024, 0x41),
    });

    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      success: false,
      code: "LEGACY_CONVERT_GONE",
      message:
        "Legacy /api/convert is retired. Use the authenticated converter flow at /api/converter.",
      migration_endpoint: "/api/converter",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("production middleware tombstones malformed and oversized legacy JSON first", async () => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    const scenarios = [
      {
        method: "POST",
        path: "/api/convert/export",
        body: '{"rows":',
      },
      {
        method: "PUT",
        path: "/api/convert/retired/nested",
        body: Buffer.alloc(50 * 1024 * 1024 + 1, 0x20),
      },
    ];

    for (const scenario of scenarios) {
      const response = await fetch(`http://127.0.0.1:${port}${scenario.path}`, {
        method: scenario.method,
        headers: { "content-type": "application/json" },
        body: scenario.body,
      });

      assert.equal(response.status, 410, `${scenario.method} ${scenario.path}`);
      assert.equal((await response.json()).code, "LEGACY_CONVERT_GONE");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("production legacy GET and OPTIONS keep CORS and request IDs", async () => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    const origin = "http://localhost:5173";
    const scenarios = [
      { method: "GET", requestId: "legacy-get-request" },
      { method: "OPTIONS", requestId: "legacy-options-request" },
    ];

    for (const scenario of scenarios) {
      const headers = {
        origin,
        "x-request-id": scenario.requestId,
      };
      if (scenario.method === "OPTIONS") {
        headers["access-control-request-method"] = "POST";
        headers["access-control-request-headers"] = "content-type,x-request-id";
      }
      const response = await fetch(
        `http://127.0.0.1:${port}/api/convert/retired/nested`,
        { method: scenario.method, headers },
      );

      assert.equal(response.status, 410, scenario.method);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.match(
        response.headers.get("access-control-expose-headers") || "",
        /(?:^|,\s*)X-Request-ID(?:\s*,|$)/i,
      );
      assert.equal(response.headers.get("x-request-id"), scenario.requestId);
      assert.equal((await response.json()).code, "LEGACY_CONVERT_GONE");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("legacy writer exposes preview headers but no workbook-generation API", () => {
  const writer = require("../utils/misaWriter");

  assert.ok(Array.isArray(writer.MISA_HEADERS));
  assert.equal(writer.buildMisaExcel, undefined);
  assert.equal(writer.ensureTemplate, undefined);
});
