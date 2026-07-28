import { useCallback, useEffect, useState } from "react";
import api from "../services/api.js";
import {
  DEFAULT_OPERATION_CAPABILITIES,
  intersectOperationCapabilities,
  normalizeOperationCapabilities,
} from "../utils/operationSession.js";
import {
  buildGatewayExportPayload,
  gatewayRequestError,
} from "../utils/converterOperations.js";

const STATUS_REFRESH_MS = 15000;

export const DEFAULT_CONVERTER_TEMPLATES = [
  { id: "bsn_sales", label: "BSN - Form import bán hàng" },
  { id: "bsn_purchase", label: "BSN - Form import mua hàng" },
  { id: "misa_purchase_domestic", label: "Mua hàng trong nước - MISA" },
  { id: "sales_goods", label: "Form bán hàng hóa" },
  { id: "sales_service", label: "Form bán hàng dịch vụ" },
  { id: "purchase_goods", label: "Form mua hàng hóa" },
  { id: "purchase_service", label: "Form mua dịch vụ" },
];

export function formatApiError(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.detail === "string") return payload.detail;
  if (Array.isArray(payload.detail)) {
    return payload.detail.map((d) => d.msg || String(d)).join("; ");
  }
  if (Array.isArray(payload.issues) && payload.issues.length) {
    return payload.issues.map((i) => i.message || String(i)).join("; ");
  }
  const issues = payload.errors || payload.report?.errors;
  if (Array.isArray(issues) && issues.length) {
    return issues.map((i) => i.message).join("; ");
  }
  return fallback;
}

export function buildUploadFormData(
  file,
  targetTemplateId,
  conversionContextToken = null,
  useAi = false,
) {
  const formData = new FormData();
  formData.append("file", file);
  if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
  if (conversionContextToken) {
    formData.append("conversion_context_token", conversionContextToken);
  }
  if (useAi === true) {
    formData.append("use_ai", "true");
    formData.append("ai_mapping_opt_in", "true");
  }
  return formData;
}

export async function readJsonResponse(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(formatApiError(data, fallback));
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export async function readExportResponse(response, fallback) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(formatApiError(data, fallback));
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return response.blob();
}

export function normalizeAiStatus(value) {
  if (value === "online") {
    return { gateway: "online", model: "unknown", mapping: "not_run" };
  }
  if (value === "offline" || value === "disabled") {
    return { gateway: "offline", model: "offline", mapping: "not_run" };
  }
  const source = value && typeof value === "object" ? value : {};
  const gateway = source.gateway === "online" ? "online" : "offline";
  const model = ["available", "unknown", "offline"].includes(source.model)
    ? source.model
    : gateway === "online"
      ? "unknown"
      : "offline";
  const mapping = ["not_run", "heuristic", "ai", "mixed", "failed"].includes(
    source.mapping,
  )
    ? source.mapping
    : "not_run";
  return { gateway, model, mapping };
}

export function describeAiStatus(status) {
  const normalized = normalizeAiStatus(status);
  if (["ai", "mixed"].includes(normalized.mapping)) return "AI mapping đã dùng";
  if (normalized.mapping === "failed" && normalized.gateway === "online") {
    return "AI mapping không đạt kiểm tra an toàn — đang dùng heuristic an toàn";
  }
  if (normalized.gateway === "offline") {
    return "AI offline — đang dùng heuristic an toàn";
  }
  return "AI Gateway online — chưa chạy AI mapping";
}

function aiStatusFromHealth(health) {
  if (!health || !Object.prototype.hasOwnProperty.call(health, "ai")) {
    return "disabled";
  }
  return normalizeAiStatus(health.ai);
}

export async function fetchConverterStatus(apiClient = api) {
  const [healthResult, templatesResult] = await Promise.allSettled([
    apiClient.get("/converter/capabilities"),
    apiClient.get("/converter/templates"),
  ]);

  const health = healthResult.status === "fulfilled" ? healthResult.value.data : null;
  const templatesData =
    templatesResult.status === "fulfilled" ? templatesResult.value.data : null;

  const serviceOnline = Boolean(health || templatesData);
  const healthAiStatus = health ? aiStatusFromHealth(health) : null;

  return {
    serviceOnline,
    aiOnline:
      healthAiStatus === "disabled"
        ? "disabled"
        : healthAiStatus
          ? healthAiStatus.gateway === "online"
          : null,
    aiStatus: healthAiStatus === "disabled" ? null : healthAiStatus,
    runtimeCapabilities: normalizeOperationCapabilities(health?.capabilities),
    templates: templatesData?.items?.length
      ? templatesData.items
      : DEFAULT_CONVERTER_TEMPLATES,
  };
}

export function buildOperationHeaders(conversionContextToken, headers = {}) {
  const token = String(conversionContextToken || "").trim();
  if (!token) throw new Error("Thiếu conversion context cho thao tác phiên dữ liệu.");
  return { ...headers, "X-Conversion-Context": token };
}

export function buildExportRequestConfig(
  conversionContextToken,
  idempotencyKey = null,
  allowConverterContextRefresh = false,
) {
  const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
  return {
    responseType: "blob",
    headers: buildOperationHeaders(conversionContextToken, headers),
    ...(allowConverterContextRefresh ? { allowConverterContextRefresh: true } : {}),
  };
}

async function requestRunExportContext({
  apiClient,
  runId,
  uploadId,
  targetTemplateId,
  operationSessionId,
}) {
  if (!runId || !uploadId || !targetTemplateId || !operationSessionId) {
    throw new Error("Thiếu liên kết run/upload/template/session để làm mới export context.");
  }
  const response = await apiClient.post(
    `/converter/runs/${encodeURIComponent(runId)}/context`,
    {
      upload_id: uploadId,
      target_template_id: targetTemplateId,
      operation_session_id: operationSessionId,
    },
  );
  const contextToken = String(response.data?.contextToken || "").trim();
  if (!contextToken) throw new Error("Gateway không trả export context hợp lệ.");
  return contextToken;
}

export async function exportWithFreshRunContext({
  apiClient = api,
  runId,
  uploadId,
  targetTemplateId,
  operationSessionId,
  payload,
  idempotencyKey,
}) {
  const contextRequest = {
    apiClient,
    runId,
    uploadId,
    targetTemplateId,
    operationSessionId,
  };
  const contextToken = await requestRunExportContext(contextRequest);
  try {
    return await apiClient.post(
      "/converter/conversions/export",
      payload,
      buildExportRequestConfig(contextToken, idempotencyKey, true),
    );
  } catch (error) {
    if (Number(error?.response?.status || error?.status) !== 401) throw error;
    const refreshedContextToken = await requestRunExportContext(contextRequest);
    return apiClient.post(
      "/converter/conversions/export",
      payload,
      buildExportRequestConfig(refreshedContextToken, idempotencyKey),
    );
  }
}

export function buildSessionExportPayload({
  runId,
  uploadId,
  profileId,
  profileVersion = null,
  profileStateHash = null,
  acknowledgeWarnings = false,
  idempotencyKey,
  session,
  requireSession = true,
}) {
  if (
    requireSession &&
    (!session?.sessionId ||
      !session?.stateHash ||
      !Number.isInteger(session?.revision))
  ) {
    throw new Error("Phiên dữ liệu chưa có revision hợp lệ để xuất file.");
  }
  return buildGatewayExportPayload({
    runId,
    uploadId,
    profileId,
    profileVersion,
    profileStateHash,
    sessionId: requireSession ? session?.sessionId : undefined,
    revision: requireSession ? session?.revision : undefined,
    stateHash: requireSession ? session?.stateHash : undefined,
    acknowledgeWarnings,
    idempotencyKey,
  });
}

export async function fetchConverterCapabilities(apiClient = api) {
  try {
    const response = await apiClient.get("/converter/capabilities");
    return {
      online: true,
      capabilities: normalizeOperationCapabilities(response.data),
      aiStatus: response.data?.ai ? normalizeAiStatus(response.data.ai) : null,
    };
  } catch {
    return { online: false, capabilities: DEFAULT_OPERATION_CAPABILITIES, aiStatus: null };
  }
}

function sessionUrl(sessionId, suffix = "") {
  return `/converter/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function requestData(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function requestSessionJson(
  sessionId,
  suffix,
  options,
  fallback,
  conversionContextToken,
) {
  try {
    const response = await api.request({
      url: sessionUrl(sessionId, suffix),
      method: options?.method || "GET",
      data: requestData(options?.body),
      signal: options?.signal,
      headers: buildOperationHeaders(conversionContextToken, options?.headers),
    });
    return response.data;
  } catch (error) {
    throw gatewayRequestError(error, fallback);
  }
}

export async function fetchSessionRevisions(
  sessionId,
  conversionContextToken,
  apiClient = api,
) {
  try {
    const response = await apiClient.get(sessionUrl(sessionId), {
      headers: buildOperationHeaders(conversionContextToken),
    });
    return response.data;
  } catch (error) {
    throw gatewayRequestError(error, "Không thể tải phiên bản dữ liệu mới.");
  }
}

export function useConverterApi() {
  const [templates, setTemplates] = useState(DEFAULT_CONVERTER_TEMPLATES);
  const [serviceOnline, setServiceOnline] = useState(null);
  const [aiOnline, setAiOnline] = useState(null); // null=loading, true=online, false=offline, "disabled"=không cấu hình
  const [aiStatus, setAiStatus] = useState(null);
  const [capabilities, setCapabilities] = useState(DEFAULT_OPERATION_CAPABILITIES);
  const [capabilitiesOnline, setCapabilitiesOnline] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = () => {
      Promise.all([fetchConverterStatus(), fetchConverterCapabilities()])
        .then(([status, nodeCapabilities]) => {
          if (cancelled) return;
          setServiceOnline(status.serviceOnline);
          const nextAiStatus = status.aiStatus || nodeCapabilities.aiStatus;
          setAiOnline(
            nextAiStatus ? nextAiStatus.gateway === "online" : status.aiOnline,
          );
          setAiStatus(nextAiStatus);
          setTemplates(status.templates);
          setCapabilitiesOnline(nodeCapabilities.online && status.serviceOnline);
          setCapabilities(
            intersectOperationCapabilities(
              nodeCapabilities.capabilities,
              status.runtimeCapabilities,
            ),
          );
        })
        .catch(() => {
          if (cancelled) return;
          setServiceOnline(false);
          setAiOnline(false);
          setAiStatus(normalizeAiStatus("offline"));
          setTemplates(DEFAULT_CONVERTER_TEMPLATES);
          setCapabilitiesOnline(false);
          setCapabilities(DEFAULT_OPERATION_CAPABILITIES);
        });
    };

    refreshStatus();
    const refreshTimer = window.setInterval(refreshStatus, STATUS_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, []);

  const analyzeFile = useCallback(
    async (
      file,
      targetTemplateId,
      conversionContextToken = null,
      useAi = false,
      idempotencyKey = null,
    ) => {
      try {
        const response = await api.post(
          "/converter/uploads/analyze",
          buildUploadFormData(file, targetTemplateId, conversionContextToken, useAi),
          { headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined },
        );
        return response.data;
      } catch (error) {
        throw gatewayRequestError(error, "Không thể phân tích file Excel.");
      }
    },
    [],
  );

  const postGatewayJson = useCallback(async (url, payload, fallback) => {
    try {
      const response = await api.post(url, payload);
      return response.data;
    } catch (error) {
      throw gatewayRequestError(error, fallback);
    }
  }, []);

  const previewMapping = useCallback(
    (payload) =>
      postGatewayJson("/converter/mappings/preview", payload, "Không thể xem trước mapping MISA."),
    [postGatewayJson],
  );

  const confirmMapping = useCallback(
    (payload) =>
      postGatewayJson("/converter/mappings/confirm", payload, "Không thể lưu setting mapping."),
    [postGatewayJson],
  );

  const syncMappingSession = useCallback(
    (payload) =>
      postGatewayJson("/converter/sessions", payload, "Không thể đồng bộ mapping với phiên dữ liệu."),
    [postGatewayJson],
  );

  const checkReadiness = useCallback(
    (payload) =>
      postGatewayJson(
        "/converter/mappings/readiness",
        payload,
        "Không kiểm tra được trạng thái sẵn sàng import MISA.",
      ),
    [postGatewayJson],
  );

  const exportConfirmed = useCallback(
    async (
      uploadId,
      profileId,
      acknowledgeWarnings = false,
      session = null,
      requireSession = true,
      profileBinding = null,
      runId = null,
      idempotencyKey = null,
      targetTemplateId = null,
    ) => {
      const payload = buildSessionExportPayload({
        runId,
        uploadId,
        profileId,
        profileVersion: profileBinding?.version,
        profileStateHash: profileBinding?.stateHash,
        acknowledgeWarnings,
        session,
        requireSession,
        idempotencyKey,
      });
      try {
        const response = await exportWithFreshRunContext({
          apiClient: api,
          runId,
          uploadId,
          targetTemplateId,
          operationSessionId: session?.sessionId,
          payload,
          idempotencyKey,
        });
        const disposition = response.headers?.["content-disposition"] || "";
        const match = disposition.match(/filename="?([^";\n]+)"?/i);
        return { blob: response.data, filename: match ? match[1] : "Import misa.xls" };
      } catch (error) {
        throw gatewayRequestError(error, "Không thể tải file MISA.");
      }
    },
    [],
  );

  const detectAnomalies = useCallback(
    (sessionId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        "/anomalies/detect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể kiểm tra bất thường dữ liệu.",
        conversionContextToken,
      ),
    [],
  );

  const reviewAnomaly = useCallback(
    (sessionId, anomalyId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        `/anomalies/${encodeURIComponent(anomalyId)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể lưu trạng thái rà soát.",
        conversionContextToken,
      ),
    [],
  );

  const proposeCorrections = useCallback(
    (sessionId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        "/corrections/propose",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể tạo đề xuất sửa hàng loạt.",
        conversionContextToken,
      ),
    [],
  );

  const simulateCorrections = useCallback(
    (sessionId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        "/corrections/simulate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể xem trước thay đổi.",
        conversionContextToken,
      ),
    [],
  );

  const applyCorrections = useCallback(
    (sessionId, payload, conversionContextToken, idempotencyKey) =>
      requestSessionJson(
        sessionId,
        "/corrections/apply",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
        "Không thể áp dụng thay đổi.",
        conversionContextToken,
      ),
    [],
  );

  const undoCorrections = useCallback(
    (sessionId, payload, conversionContextToken, idempotencyKey) =>
      requestSessionJson(
        sessionId,
        "/corrections/undo",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
        "Không thể hoàn tác correction.",
        conversionContextToken,
      ),
    [],
  );

  const activateRevision = useCallback(
    (sessionId, revision, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        `/revisions/${encodeURIComponent(revision)}/activate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể hoàn tác phiên bản dữ liệu.",
        conversionContextToken,
      ),
    [],
  );

  const getSessionRevisions = useCallback(
    (sessionId, conversionContextToken) =>
      fetchSessionRevisions(sessionId, conversionContextToken),
    [],
  );

  const addComparisonFile = useCallback(
    (sessionId, file, role, mutationContext, conversionContextToken) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("role", role);
      formData.append("revision", String(mutationContext?.revision ?? ""));
      formData.append("state_hash", mutationContext?.state_hash || "");
      return requestSessionJson(
        sessionId,
        "/comparison-files",
        { method: "POST", body: formData },
        "Không thể tải file đối chiếu.",
        conversionContextToken,
      );
    },
    [],
  );

  const removeComparisonFile = useCallback(
    (sessionId, fileId, payload, conversionContextToken) => {
      const query = new URLSearchParams({
        revision: String(payload?.revision ?? ""),
        state_hash: String(payload?.state_hash || ""),
      });
      return requestSessionJson(
        sessionId,
        `/comparison-files/${encodeURIComponent(fileId)}?${query.toString()}`,
        {
          method: "DELETE",
        },
        "Không thể bỏ file đối chiếu.",
        conversionContextToken,
      );
    },
    [],
  );

  const runReconciliation = useCallback(
    (sessionId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        "/reconciliation/run",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể chạy đối chiếu.",
        conversionContextToken,
      ),
    [],
  );

  const confirmReconciliationMatch = useCallback(
    (sessionId, reportId, matchId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        `/reconciliation/${encodeURIComponent(reportId)}/matches/${encodeURIComponent(matchId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể xác nhận chứng từ đối chiếu.",
        conversionContextToken,
      ),
    [],
  );

  const askAccountingQuestion = useCallback(
    (sessionId, payload, conversionContextToken) =>
      requestSessionJson(
        sessionId,
        "/questions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Không thể trả lời câu hỏi về file này.",
        conversionContextToken,
      ),
    [],
  );

  return {
    templates,
    serviceOnline,
    aiOnline,
    aiStatus,
    capabilities,
    capabilitiesOnline,
    analyzeFile,
    previewMapping,
    syncMappingSession,
    confirmMapping,
    checkReadiness,
    exportConfirmed,
    detectAnomalies,
    reviewAnomaly,
    proposeCorrections,
    simulateCorrections,
    applyCorrections,
    undoCorrections,
    activateRevision,
    getSessionRevisions,
    addComparisonFile,
    removeComparisonFile,
    runReconciliation,
    confirmReconciliationMatch,
    askAccountingQuestion,
  };
}
