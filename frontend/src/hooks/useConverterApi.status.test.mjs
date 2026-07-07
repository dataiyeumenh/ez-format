import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONVERTER_TEMPLATES,
  fetchConverterStatus,
} from "./useConverterApi.js";

function response(ok, payload, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("converter status is online when health and templates are available", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/healthz")) return response(true, { ai: "online" });
    return response(true, { items: [{ id: "bsn_sales" }] });
  };

  const status = await fetchConverterStatus(fetchImpl);

  assert.equal(status.serviceOnline, true);
  assert.equal(status.aiOnline, true);
  assert.deepEqual(status.templates, [{ id: "bsn_sales" }]);
});

test("converter status stays online when health succeeds but templates fail", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/healthz")) return response(true, { ai: "online" });
    return response(false, {}, 503);
  };

  const status = await fetchConverterStatus(fetchImpl);

  assert.equal(status.serviceOnline, true);
  assert.equal(status.aiOnline, true);
  assert.deepEqual(status.templates, DEFAULT_CONVERTER_TEMPLATES);
});

test("converter status is offline but keeps default templates when all status endpoints fail", async () => {
  const fetchImpl = async () => response(false, {}, 503);

  const status = await fetchConverterStatus(fetchImpl);

  assert.equal(status.serviceOnline, false);
  assert.equal(status.aiOnline, null);
  assert.deepEqual(status.templates, DEFAULT_CONVERTER_TEMPLATES);
});
