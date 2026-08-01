const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const router = require("../routes/internalConverterSessions");

test("write routes authenticate and rate-limit before parsing request bodies", () => {
  for (const path of ["/:sessionId/state", "/:sessionId/artifacts/:kind"]) {
    const route = router.stack.find((layer) => layer.route?.path === path)?.route;
    assert.ok(route, `missing route ${path}`);
    assert.deepEqual(
      route.stack.slice(0, 3).map((layer) => layer.handle.name),
      ["authenticateInternalRequest", "internalRateLimit", "parseArtifactBody"],
    );
  }
});

test("internal rate limiter keeps authenticated key memory bounded", () => {
  let currentTime = 1_000;
  const limiter = router.createInternalRateLimiter({
    limit: 5,
    maxEntries: 2,
    now: () => currentTime,
    windowMs: 60_000,
  });
  for (const ownerScope of ["user:1", "user:2", "user:3"]) {
    const req = { converterClaims: { owner_scope: ownerScope }, ip: "127.0.0.1" };
    limiter(req, {}, (error) => assert.equal(error, undefined));
  }
  assert.equal(limiter.bucketCount(), 2);
  currentTime += 60_001;
  limiter(
    { converterClaims: { owner_scope: "user:4" }, ip: "127.0.0.1" },
    {},
    (error) => assert.equal(error, undefined),
  );
  assert.equal(limiter.bucketCount(), 1);
});

test("legacy state-object and raw operation writes decode to the same bytes", () => {
  const state = { schema_version: 1, state: "persist me" };
  const stateBytes = Buffer.from(JSON.stringify(state));
  const legacyState = router.decodeStateWrite({
    body: {
      run_id: "run-1",
      revision: 2,
      state,
      expires_at: "2030-01-01T00:00:00.000Z",
    },
    query: {},
  });
  const rawState = router.decodeStateWrite({
    body: stateBytes,
    query: {
      run_id: "run-1",
      revision: "2",
      expected_revision: "1",
      expected_sha256: "a".repeat(64),
      sha256: require("node:crypto").createHash("sha256").update(stateBytes).digest("hex"),
      expires_at: "2030-01-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(legacyState.bytes, rawState.bytes);
  assert.equal(legacyState.expectedPriorRevision, 1);
  assert.equal(legacyState.legacy, true);

  const artifact = Buffer.from("legacy artifact");
  assert.deepEqual(
    router.decodeArtifactWrite({
      body: {
        run_id: "run-1",
        revision: 1,
        content_base64: artifact.toString("base64"),
        content_type: "application/octet-stream",
        expires_at: "2030-01-01T00:00:00.000Z",
        sha256: require("node:crypto").createHash("sha256").update(artifact).digest("hex"),
      },
      query: {},
    }).bytes,
    artifact,
  );
});

test("legacy state base64 preserves the exact Python canonical bytes and SHA", () => {
  const canonicalBytes = Buffer.from('{"schema_version":1,"session":{"label":"dữ liệu","state_hash":"ccc"}}');
  const decoded = router.decodeStateWrite({
    body: {
      run_id: "run-1",
      revision: 2,
      state_base64: canonicalBytes.toString("base64"),
      sha256: require("node:crypto").createHash("sha256").update(canonicalBytes).digest("hex"),
      expires_at: "2030-01-01T00:00:00.000Z",
    },
    query: {},
  });

  assert.deepEqual(decoded.bytes, canonicalBytes);
  assert.equal(decoded.sha256, require("node:crypto").createHash("sha256").update(canonicalBytes).digest("hex"));
});

test("legacy state rejects duplicated object and canonical-byte representations", () => {
  const canonicalBytes = Buffer.from('{"schema_version":1,"session":{"label":"canonical"}}');

  assert.throws(
    () => router.decodeStateWrite({
      body: {
        run_id: "run-1",
        revision: 2,
        state: { schema_version: 1, session: { label: "canonical" } },
        state_base64: canonicalBytes.toString("base64"),
        sha256: require("node:crypto").createHash("sha256").update(canonicalBytes).digest("hex"),
        expires_at: "2030-01-01T00:00:00.000Z",
      },
      query: {},
    }),
    (error) => error.statusCode === 400 && error.code === "INVALID_ARTIFACT_CONTENT",
  );
});

test("legacy JSON parser budget covers one base64 representation plus bounded metadata", () => {
  const maxBytes = 64 * 1024 * 1024;
  const exactBase64Bytes = 4 * Math.ceil(maxBytes / 3);

  assert.equal(
    router.legacyJsonBodyLimit(maxBytes),
    exactBase64Bytes + 64 * 1024,
  );
  assert.equal(router.legacyJsonBodyLimit(1), 50 * 1024 * 1024);
});

test("legacy canonical bytes must match the exact candidate SHA before publication", async () => {
  const bytes = Buffer.from('{"schema_version":1,"state":"canonical"}');
  let published = false;

  await assert.rejects(
    router.putOperationState({
      claims: {
        owner_scope: "user:user-1",
        user_id: "user-1",
        upload_id: "upload-1",
        target_template_id: "bsn_sales",
      },
      sessionId: "session-1",
      runId: "run-1",
      revision: 1,
      expectedPriorRevision: 0,
      expectedPriorSha256: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bytes,
      sha256: "0".repeat(64),
      putArtifactFn: async () => {
        published = true;
      },
      maxBytes: bytes.length,
    }),
    (error) => error.statusCode === 409 && error.code === "ARTIFACT_CHECKSUM_MISMATCH",
  );
  assert.equal(published, false);
});

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

test("state reader uses the configured artifact limit above 2 MiB", async () => {
  const state = { value: "x".repeat(2 * 1024 * 1024 + 17) };
  const bytes = Buffer.from(JSON.stringify(state));

  assert.deepEqual(
    await router.readState(Readable.from([bytes]), bytes.length),
    state,
  );
  await assert.rejects(
    router.readState(Readable.from([bytes]), bytes.length - 1),
    (error) => error.statusCode === 413 && error.code === "ARTIFACT_TOO_LARGE",
  );
});

test("state publication returns bytes read back from the persisted artifact", async () => {
  const persistedState = { persisted: true, revision: 1 };
  const persistedBytes = Buffer.from(JSON.stringify(persistedState));
  const candidateBytes = Buffer.from('{"locallyGuessed":true}');
  const saved = {
    revision: 1,
    sha256: require("node:crypto").createHash("sha256").update(persistedBytes).digest("hex"),
  };
  let readBinding;

  const result = await router.putOperationState({
    claims: {
      owner_scope: "user:user-1",
      user_id: "user-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
    },
    sessionId: "session-1",
    runId: "run-1",
    revision: 1,
    expectedPriorRevision: 0,
    expectedPriorSha256: "",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bytes: candidateBytes,
    sha256: require("node:crypto").createHash("sha256").update(candidateBytes).digest("hex"),
    putArtifactFn: async () => saved,
    getArtifactFn: async (input) => {
      readBinding = input;
      return { metadata: saved, content: Readable.from([persistedBytes]) };
    },
    maxBytes: 3 * 1024 * 1024,
  });

  assert.equal(readBinding.revision, 1);
  assert.deepEqual(result, { session: saved, state: persistedState });
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
