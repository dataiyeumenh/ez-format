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
