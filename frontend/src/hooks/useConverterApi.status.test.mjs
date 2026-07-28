import assert from "node:assert/strict";
import test from "node:test";
import * as converterApi from "./useConverterApi.js";

import {
  buildOperationHeaders,
  buildExportRequestConfig,
  exportWithFreshRunContext,
  buildUploadFormData,
  buildSessionExportPayload,
  DEFAULT_CONVERTER_TEMPLATES,
  describeAiStatus,
  fetchConverterCapabilities,
  fetchConverterStatus,
  normalizeAiStatus,
} from "./useConverterApi.js";
import {
  DEFAULT_OPERATION_CAPABILITIES,
  intersectOperationCapabilities,
} from "../utils/operationSession.js";
import {
  CONVERTER_HEALTH_FIXTURE,
  NODE_CAPABILITIES_FIXTURE,
} from "../utils/converterContractFixtures.js";

function response(ok, payload, status = ok ? 200 : 500) {
  return { ok, status, async json() { return payload; } };
}

test("stale recovery fetches the active session revision with conversion context", async () => {
  assert.equal(typeof converterApi.fetchSessionRevisions, "function");
  const calls = [];
  const payload = { session_id: "session-1", active_revision: 2, state_hash: "state-2" };

  const result = await converterApi.fetchSessionRevisions(
    "session-1",
    "context-token",
    {
      async get(url, options) {
      calls.push({ url, options });
        return { data: payload };
      },
    },
  );

  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [
    {
      url: "/converter/sessions/session-1",
      options: {
        headers: { "X-Conversion-Context": "context-token" },
      },
    },
  ]);
});

test("JSON and export errors retain HTTP status and payload", async () => {
  assert.equal(typeof converterApi.readJsonResponse, "function");
  assert.equal(typeof converterApi.readExportResponse, "function");
  const payload = { detail: "Revision has changed" };

  await assert.rejects(
    () => converterApi.readJsonResponse(response(false, payload, 409), "fallback"),
    (error) => error.status === 409 && error.payload === payload,
  );
  await assert.rejects(
    () =>
      converterApi.readExportResponse(
        response(false, payload, 409),
        "fallback",
      ),
    (error) => error.status === 409 && error.payload === payload,
  );
});

function statusClient(capabilities, templates, templateError = null) {
  return {
    async get(url) {
      if (url === "/converter/capabilities") return { data: capabilities };
      if (templateError) throw templateError;
      assert.equal(url, "/converter/templates");
      return { data: templates };
    },
  };
}

test("converter status is online when gateway capabilities and templates are available", async () => {
  const apiClient = statusClient({ ai: "online" }, { items: [{ id: "bsn_sales" }] });

  const status = await fetchConverterStatus(apiClient);

  assert.equal(status.serviceOnline, true);
  assert.equal(status.aiOnline, true);
  assert.deepEqual(status.templates, [{ id: "bsn_sales" }]);
});

test("AI health separates gateway, model, and mapping states", async () => {
  const apiClient = statusClient(
    { ai: { gateway: "online", model: "unknown", mapping: "not_run" } },
    { items: [{ id: "bsn_sales" }] },
  );

  const status = await fetchConverterStatus(apiClient);

  assert.deepEqual(status.aiStatus, {
    gateway: "online",
    model: "unknown",
    mapping: "not_run",
  });
  assert.equal(status.aiOnline, true);
  assert.equal(status.aiStatus.mapping, "not_run");
  assert.equal(describeAiStatus(status.aiStatus), "AI Gateway online — chưa chạy AI mapping");
});

test("AI opt-in is explicit in the upload form and status copy stays truthful", () => {
  const formData = buildUploadFormData(new Blob(["xlsx"]), "bsn_sales", null, true);

  assert.equal(formData.get("use_ai"), "true");
  assert.equal(formData.get("ai_mapping_opt_in"), "true");
  assert.deepEqual(normalizeAiStatus("online"), {
    gateway: "online",
    model: "unknown",
    mapping: "not_run",
  });
  assert.equal(
    describeAiStatus({ gateway: "offline", model: "offline", mapping: "failed" }),
    "AI offline — đang dùng heuristic an toàn",
  );
  assert.equal(
    describeAiStatus({ gateway: "online", model: "available", mapping: "mixed" }),
    "AI mapping đã dùng",
  );
  assert.equal(
    describeAiStatus({ gateway: "online", model: "available", mapping: "failed" }),
    "AI mapping không đạt kiểm tra an toàn — đang dùng heuristic an toàn",
  );
});

test("converter status stays online when health succeeds but templates fail", async () => {
  const apiClient = statusClient({ ai: "online" }, null, new Error("offline"));

  const status = await fetchConverterStatus(apiClient);

  assert.equal(status.serviceOnline, true);
  assert.equal(status.aiOnline, true);
  assert.deepEqual(status.templates, DEFAULT_CONVERTER_TEMPLATES);
});

test("converter status is offline but keeps default templates when all status endpoints fail", async () => {
  const apiClient = { async get() { throw new Error("offline"); } };

  const status = await fetchConverterStatus(apiClient);

  assert.equal(status.serviceOnline, false);
  assert.equal(status.aiOnline, null);
  assert.deepEqual(status.templates, DEFAULT_CONVERTER_TEMPLATES);
});

test("runtime capabilities are normalized from the Node backend", async () => {
  const apiClient = {
    async get(url) {
      assert.equal(url, "/converter/capabilities");
      return {
        data: {
          mapping_profile_v2: true,
          anomaly_detection: true,
          reconciliation: true,
          limits: { comparison_files: 2 },
        },
      };
    },
  };

  const result = await fetchConverterCapabilities(apiClient);

  assert.equal(result.online, true);
  assert.equal(result.capabilities.mapping_profile_v2, true);
  assert.equal(result.capabilities.bulk_correction, false);
  assert.equal(result.capabilities.limits.comparison_files, 2);
});

test("runtime capabilities fail closed when the optional Node endpoint is offline", async () => {
  const result = await fetchConverterCapabilities({
    async get() {
      throw new Error("offline");
    },
  });

  assert.equal(result.online, false);
  assert.deepEqual(result.capabilities, DEFAULT_OPERATION_CAPABILITIES);
});

test("capabilities are enabled only when Node and FastAPI both enable them", () => {
  const result = intersectOperationCapabilities(
    NODE_CAPABILITIES_FIXTURE,
    CONVERTER_HEALTH_FIXTURE.capabilities,
  );
  assert.equal(result.mapping_profile_v2, true);
  assert.equal(result.bulk_correction, false);
  assert.equal(result.reconciliation, true);
  assert.equal(result.limits.comparison_files, 2);
});

test("every operation request requires and forwards conversion context", () => {
  assert.deepEqual(
    buildOperationHeaders("context-token", { Accept: "application/json" }),
    {
      Accept: "application/json",
      "X-Conversion-Context": "context-token",
    },
  );
  assert.throws(() => buildOperationHeaders(""), /conversion context/i);
});

test("export request forwards a run-bound context and idempotency key", () => {
  assert.deepEqual(buildExportRequestConfig("run-export-context", "export-1", true), {
    responseType: "blob",
    headers: {
      "Idempotency-Key": "export-1",
      "X-Conversion-Context": "run-export-context",
    },
    allowConverterContextRefresh: true,
  });
  assert.throws(() => buildExportRequestConfig("", "export-1"), /conversion context/i);
});

test("long-running export gets a fresh run-bound context immediately before export", async () => {
  const calls = [];
  const apiClient = {
    async post(url, data, config) {
      calls.push({ url, data, config });
      if (url === "/converter/runs/run-1/context") {
        return { data: { contextToken: "fresh-export-context" } };
      }
      return { data: "binary", headers: {} };
    },
  };

  const response = await exportWithFreshRunContext({
    apiClient,
    runId: "run-1",
    uploadId: "upload-1",
    targetTemplateId: "template-1",
    operationSessionId: "session-1",
    payload: { run_id: "run-1", upload_id: "upload-1" },
    idempotencyKey: "export-1",
  });

  assert.equal(response.data, "binary");
  assert.deepEqual(calls, [
    {
      url: "/converter/runs/run-1/context",
      data: {
        upload_id: "upload-1",
        target_template_id: "template-1",
        operation_session_id: "session-1",
      },
      config: undefined,
    },
    {
      url: "/converter/conversions/export",
      data: { run_id: "run-1", upload_id: "upload-1" },
      config: {
        responseType: "blob",
        headers: {
          "Idempotency-Key": "export-1",
          "X-Conversion-Context": "fresh-export-context",
        },
        allowConverterContextRefresh: true,
      },
    },
  ]);
});

test("expired export context refreshes once and retries with the new token", async () => {
  const exportConfigs = [];
  let contextRequests = 0;
  const apiClient = {
    async post(url, _data, config) {
      if (url.includes("/context")) {
        contextRequests += 1;
        return { data: { contextToken: `fresh-${contextRequests}` } };
      }
      exportConfigs.push(config);
      if (exportConfigs.length === 1) throw { response: { status: 401 } };
      return { data: "binary", headers: {} };
    },
  };

  const response = await exportWithFreshRunContext({
    apiClient,
    runId: "run-1",
    uploadId: "upload-1",
    targetTemplateId: "template-1",
    operationSessionId: "session-1",
    payload: { run_id: "run-1" },
    idempotencyKey: "export-1",
  });

  assert.equal(response.data, "binary");
  assert.equal(contextRequests, 2);
  assert.equal(exportConfigs[0].headers["X-Conversion-Context"], "fresh-1");
  assert.equal(exportConfigs[0].allowConverterContextRefresh, true);
  assert.equal(exportConfigs[1].headers["X-Conversion-Context"], "fresh-2");
  assert.equal("allowConverterContextRefresh" in exportConfigs[1], false);
});

test("session export contains revision binding and never accepts client rows", () => {
  const payload = buildSessionExportPayload({
    runId: "run-1",
    uploadId: "upload-1",
    profileId: "profile-1",
    acknowledgeWarnings: true,
    idempotencyKey: "export-1",
    session: { sessionId: "session-1", revision: 3, stateHash: "state-3" },
  });
  assert.deepEqual(payload, {
    upload_id: "upload-1",
    profile_id: "profile-1",
    acknowledge_warnings: true,
    run_id: "run-1",
    session_id: "session-1",
    revision: 3,
    state_hash: "state-3",
    idempotency_key: "export-1",
  });
  assert.equal("rows" in payload, false);
});

test("legacy export omits operation-session binding when extended features are disabled", () => {
  const payload = buildSessionExportPayload({
    uploadId: "upload-legacy",
    profileId: "profile-legacy",
    acknowledgeWarnings: true,
    session: null,
    requireSession: false,
  });

  assert.deepEqual(payload, {
    upload_id: "upload-legacy",
    profile_id: "profile-legacy",
    acknowledge_warnings: true,
  });
  assert.equal("session_id" in payload, false);
});
