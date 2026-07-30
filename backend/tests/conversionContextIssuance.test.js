const assert = require("node:assert/strict");
const test = require("node:test");

const ConversionRun = require("../models/ConversionRun");
const { verifyConversionContextToken } = require("../services/conversionContextService");
const contextRouter = require("../routes/conversionContext");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function contextHandler() {
  const route = contextRouter.stack.find((layer) => layer.route?.path === "/");
  return route.route.stack.at(-1).handle;
}

test("personal context issuance binds an owned active run, upload, session, template, and TTL", async () => {
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  const originalFindOne = ConversionRun.findOne;
  process.env.CONVERSION_CONTEXT_SECRET = "task-9-context-secret-value-123456";
  const run = {
    _id: "507f1f77bcf86cd799439011",
    user: "507f1f77bcf86cd799439012",
    status: "processing",
    mode: "mapping",
    operationSessionId: "a52a3c60-df68-46e5-a6a5-4a7bb44828c5",
    converterUploadId: "e7270428-d19f-4fd9-bd86-1b4a5a632e0a",
    targetTemplateId: "bsn_sales",
    workspace: null,
    startedAt: new Date(),
  };
  ConversionRun.findOne = async (filter) => {
    assert.equal(String(filter._id), String(run._id));
    assert.equal(String(filter.user), String(run.user));
    assert.equal(filter.status, "processing");
    assert.equal(filter.mode, "mapping");
    return run;
  };

  try {
    const response = responseRecorder();
    await contextHandler()(
      {
        user: { _id: run.user },
        body: { conversion_run_id: run._id },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.conversionRunId, String(run._id));
    assert.equal(response.body.operationSessionId, run.operationSessionId);
    assert.equal(response.body.uploadId, run.converterUploadId);
    const claims = verifyConversionContextToken(response.body.contextToken);
    assert.equal(claims.owner_scope, `user:${run.user}`);
    assert.equal(claims.conversion_run_id, String(run._id));
    assert.equal(claims.operation_session_id, run.operationSessionId);
    assert.equal(claims.upload_id, run.converterUploadId);
    assert.equal(claims.target_template_id, run.targetTemplateId);
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));
    assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 10 * 60);
  } finally {
    ConversionRun.findOne = originalFindOne;
    if (previousSecret === undefined) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("context issuance returns opaque not-found for a foreign or expired run", async () => {
  const originalFindOne = ConversionRun.findOne;
  ConversionRun.findOne = async () => null;
  try {
    const response = responseRecorder();
    await contextHandler()(
      {
        user: { _id: "507f1f77bcf86cd799439012" },
        body: { conversion_run_id: "507f1f77bcf86cd799439099" },
      },
      response,
    );
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.contextToken, undefined);
  } finally {
    ConversionRun.findOne = originalFindOne;
  }
});
