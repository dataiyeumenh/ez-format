const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const router = require("../routes/internalConverterSessions");

function response({ headersSent = false, destroyed = false } = {}) {
  const target = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  target.headersSent = headersSent;
  if (destroyed) target.destroy();
  target.status = () => {
    throw new Error("ERR_HTTP_HEADERS_SENT");
  };
  target.json = () => {
    throw new Error("ERR_HTTP_HEADERS_SENT");
  };
  return target;
}

test("asyncRoute delegates a source error before headers to Express error middleware", async () => {
  const sourceError = new Error("artifact source failed before headers");
  const res = response();
  let delegated;
  const handler = router.asyncRoute(async () => {
    throw sourceError;
  });

  await handler({}, res, (error) => {
    delegated = error;
  });

  assert.equal(delegated, sourceError);
});

test("asyncRoute does not write JSON after a mid-response source error", async () => {
  const sourceError = new Error("artifact source failed mid-response");
  const res = response();
  const originalWrite = res._write;
  res._write = function write(chunk, encoding, callback) {
    this.headersSent = true;
    return originalWrite.call(this, chunk, encoding, callback);
  };
  let delegated = false;
  const handler = router.asyncRoute(async (_req, responseStream) => {
    await pipeline(
      Readable.from((async function* () {
        yield Buffer.from("partial artifact");
        throw sourceError;
      })()),
      responseStream,
    );
  });

  await handler({}, res, () => {
    delegated = true;
  });

  assert.equal(res.destroyed, true);
  assert.equal(delegated, false);
});

test("remote operation-session purge is owner-bound and verifies all artifacts are gone", async () => {
  let deletedBinding;
  const result = await router.deleteOperationArtifacts({
    claims: {
      owner_scope: "user:user-1",
      user_id: "user-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
    },
    sessionId: "session-1",
    runId: "student:session-1",
    purgeArtifactsFn: async (input) => {
      deletedBinding = input;
      return {
        success: true,
        purgeScope: "all_artifacts",
        deletedArtifacts: 4,
        remainingMetadata: 0,
        remainingBytes: 0,
      };
    },
  });

  assert.deepEqual(deletedBinding, {
    ownerScope: "user:user-1",
    userId: "user-1",
    sessionId: "session-1",
    runId: "student:session-1",
    uploadId: "upload-1",
    targetTemplateId: "bsn_sales",
  });
  assert.deepEqual(result, {
    success: true,
    session_id: "session-1",
    run_id: "student:session-1",
    purge_scope: "all_artifacts",
    deleted_artifacts: 4,
    remaining_metadata: 0,
    remaining_bytes: 0,
    remote_operation_session_deleted: true,
  });
});

test("remote operation-session purge fails closed on 404 without zero proof", async () => {
  await assert.rejects(
    router.deleteOperationArtifacts({
      claims: {
        owner_scope: "user:user-1",
        user_id: "user-1",
        upload_id: "upload-1",
        target_template_id: "bsn_sales",
      },
      sessionId: "session-1",
      runId: "student:session-1",
      purgeArtifactsFn: async () => {
        const error = new Error("artifact not found");
        error.statusCode = 404;
        throw error;
      },
    }),
    /artifact not found/,
  );
});

test("remote operation-session purge rejects deletion_pending or nonzero residue", async () => {
  await assert.rejects(
    router.deleteOperationArtifacts({
      claims: {
        owner_scope: "user:user-1",
        user_id: "user-1",
        upload_id: "upload-1",
        target_template_id: "bsn_sales",
      },
      sessionId: "session-1",
      runId: "student:session-1",
      purgeArtifactsFn: async () => ({
        success: false,
        purgeScope: "all_artifacts",
        status: "deletion_pending",
        remainingMetadata: 1,
        remainingBytes: 1,
      }),
    }),
    (error) => error.code === "OPERATION_ARTIFACT_PURGE_INCOMPLETE" && error.statusCode === 503,
  );
});
