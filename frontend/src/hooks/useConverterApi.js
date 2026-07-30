import { useCallback, useEffect, useState } from "react";
import api from "../services/api.js";
import {
  DEFAULT_OPERATION_CAPABILITIES,
  intersectOperationCapabilities,
  normalizeOperationCapabilities,
} from "../utils/operationSession.js";
import { mergeImportRepairWorkspacePage } from "../utils/importRepairUx.js";
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

export function normalizeMisaImportRepairCapability(payload) {
  const source = payload?.misa_import_repair;
  return {
    enabled: source?.enabled === true,
    phase: Number(source?.phase || 0),
    adapter: source?.adapter || null,
  };
}

function gatewayRequestError(error, fallback) {
  const payload = error.response?.data;
  const wrapped = new Error(formatApiError(payload, fallback));
  wrapped.payload = payload;
  wrapped.status = error.response?.status;
  return wrapped;
}

function withExpectedVersion(payload = {}) {
  return {
    ...payload,
    expected_version: payload.expected_version ?? payload.expectedVersion,
  };
}

function buildUploadFormData(file, targetTemplateId, conversionContextToken = null) {
  const formData = new FormData();
  formData.append("file", file);
  if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
  if (conversionContextToken) {
    formData.append("conversion_context_token", conversionContextToken);
  }
  return formData;
}

export function buildImportRepairFormData(conversionRunId, file, artifactType = "failed_rows") {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conversion_run_id", conversionRunId);
  formData.append("artifact_type", artifactType);
  return formData;
}

export async function createImportRepairRequest(
  requestImportRepair,
  conversionRunId,
  file,
  artifactType = "failed_rows",
  idempotencyKey,
) {
  const response = await requestImportRepair(
    "POST",
    "/converter/import-repairs",
    buildImportRepairFormData(conversionRunId, file, artifactType),
    "Không thể tải file lỗi MISA.",
    { headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined },
  );
  return { ...response.data, inspection: response.data?.workbook || null };
}

async function readApiResponse(request, fallback) {
  try {
    const response = await request;
    return response.data;
  } catch (error) {
    const payload = error.response?.data;
    const wrapped = new Error(formatApiError(payload, fallback));
    wrapped.payload = payload;
    wrapped.status = error.response?.status;
    throw wrapped;
  }
}

function aiStatusFromHealth(health) {
  const ai = health?.ai;
  if (ai === "online") return true;
  if (ai === "offline") return false;
  return "disabled";
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchConverterStatus(client = api) {
  const [backendResult, healthResult, templatesResult] = typeof client === "function"
    ? await Promise.allSettled([
        fetchJson(client, "/api/health"),
        fetchJson(client, "/api/healthz"),
        fetchJson(client, "/api/converter/templates"),
      ])
    : await Promise.allSettled([
        client.get("/health"),
        client.get("/converter/capabilities"),
        client.get("/converter/templates"),
      ]);

  const backend = backendResult.status === "fulfilled"
    ? (typeof client === "function" ? backendResult.value : backendResult.value.data)
    : null;
  const health = healthResult.status === "fulfilled"
    ? (typeof client === "function" ? healthResult.value : healthResult.value.data)
    : null;
  const templatesData =
    templatesResult.status === "fulfilled"
      ? (typeof client === "function" ? templatesResult.value : templatesResult.value.data)
      : null;

  const serviceOnline = Boolean(health || templatesData);
  const nodeCapabilities = normalizeOperationCapabilities(
    backend?.capabilities?.operations,
  );
  const converterCapabilities = normalizeOperationCapabilities(health);

  return {
    serviceOnline,
    aiOnline: health ? aiStatusFromHealth(health) : null,
    backendCapabilities: backend?.capabilities || null,
    capabilities: intersectOperationCapabilities(
      nodeCapabilities,
      converterCapabilities,
    ),
    capabilitiesOnline: Boolean(backend && health),
    misaImportRepair: normalizeMisaImportRepairCapability(
      backend?.capabilities || backend || health,
    ),
    templates: templatesData?.items?.length
      ? templatesData.items
      : DEFAULT_CONVERTER_TEMPLATES,
  };
}

export function useConverterApi() {
  const [templates, setTemplates] = useState(DEFAULT_CONVERTER_TEMPLATES);
  const [serviceOnline, setServiceOnline] = useState(null);
  const [aiOnline, setAiOnline] = useState(null); // null=loading, true=online, false=offline, "disabled"=không cấu hình
  const [backendCapabilities, setBackendCapabilities] = useState(null);
  const [capabilities, setCapabilities] = useState(
    DEFAULT_OPERATION_CAPABILITIES,
  );
  const [capabilitiesOnline, setCapabilitiesOnline] = useState(null);
  const [misaImportRepair, setMisaImportRepair] = useState(
    normalizeMisaImportRepairCapability(null),
  );

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = () => {
      fetchConverterStatus()
        .then(({ serviceOnline, aiOnline, backendCapabilities, capabilities, capabilitiesOnline, misaImportRepair, templates }) => {
          if (cancelled) return;
          setServiceOnline(serviceOnline);
          setAiOnline(aiOnline);
          setBackendCapabilities(backendCapabilities);
          setCapabilities(capabilities);
          setCapabilitiesOnline(capabilitiesOnline);
          setMisaImportRepair(misaImportRepair);
          setTemplates(templates);
        })
        .catch(() => {
          if (cancelled) return;
          setServiceOnline(false);
          setAiOnline(false);
          setBackendCapabilities(null);
          setCapabilities(DEFAULT_OPERATION_CAPABILITIES);
          setCapabilitiesOnline(false);
          setMisaImportRepair(normalizeMisaImportRepairCapability(null));
          setTemplates(DEFAULT_CONVERTER_TEMPLATES);
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
    async (file, targetTemplateId, conversionContextToken = null) => {
      return readApiResponse(
        api.post("/converter/uploads/analyze", buildUploadFormData(file, targetTemplateId, conversionContextToken), {
          headers: conversionContextToken ? { "X-Conversion-Context": conversionContextToken } : undefined,
        }),
        "Không thể phân tích file Excel.",
      );
    },
    [],
  );

  const requestImportRepair = useCallback(async (method, url, data, fallback, config = {}) => {
    try {
      return await api.request({ method, url, data, ...config });
    } catch (error) {
      throw gatewayRequestError(error, fallback);
    }
  }, []);

  const createImportRepair = useCallback(
    (conversionRunId, file, artifactType, idempotencyKey) => createImportRepairRequest(
      requestImportRepair,
      conversionRunId,
      file,
      artifactType || "failed_rows",
      idempotencyKey,
    ),
    [requestImportRepair],
  );

  const submitImportResultSchema = useCallback(
    async (repairId, payload) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/schema`,
      withExpectedVersion(payload),
      "Không thể ghép cột file lỗi MISA.",
    )).data,
    [requestImportRepair],
  );

  const getImportRepair = useCallback(async (repairId) => {
    const pageFromResponse = (response) => ({
      ...response.data?.session,
      issues: response.data?.issues || [],
      documentGroupStatuses:
        response.data?.documentGroups || response.data?.session?.documentGroupStatuses || [],
      nextCursor: response.data?.nextCursor || null,
      nextGroupCursor: response.data?.nextGroupCursor || null,
      readiness: response.data?.readiness
        ? {
            ...response.data.readiness,
            hash: response.data.readiness.hash || response.data.readiness.readiness_hash || "",
          }
        : null,
      retryGate: response.data?.retryGate || null,
    });
    const fetchPage = async ({ cursor, groupCursor, limit = 100, groupLimit = 100 } = {}) => {
      const query = new URLSearchParams({
        limit: String(limit),
        group_limit: String(groupLimit),
      });
      if (cursor) query.set("cursor", cursor);
      if (groupCursor) query.set("group_cursor", groupCursor);
      return requestImportRepair(
        "GET",
        `/converter/import-repairs/${encodeURIComponent(repairId)}?${query.toString()}`,
        undefined,
        "Không thể tải phiên sửa lỗi import.",
      );
    };

    let merged = pageFromResponse(await fetchPage());
    let issueCursor = merged.nextCursor;
    let groupCursor = merged.nextGroupCursor;
    let issueDone = !issueCursor;
    let groupDone = !groupCursor;
    let pageCount = 1;
    const maxPages = 110;
    while ((!issueDone || !groupDone) && pageCount < maxPages) {
      const response = await fetchPage({
        cursor: issueDone ? null : issueCursor,
        groupCursor: groupDone ? null : groupCursor,
        limit: issueDone ? 1 : 100,
        groupLimit: groupDone ? 1 : 100,
      });
      const page = pageFromResponse(response);
      merged = mergeImportRepairWorkspacePage(merged, page);
      if (!issueDone) {
        if (page.nextCursor && page.nextCursor === issueCursor) {
          throw Object.assign(new Error("Issue cursor không tiến triển."), { status: 422 });
        }
        issueCursor = page.nextCursor;
        issueDone = !issueCursor;
      }
      if (!groupDone) {
        if (page.nextGroupCursor && page.nextGroupCursor === groupCursor) {
          throw Object.assign(new Error("Document group cursor không tiến triển."), { status: 422 });
        }
        groupCursor = page.nextGroupCursor;
        groupDone = !groupCursor;
      }
      pageCount += 1;
    }
    if (!issueDone || !groupDone) {
      throw Object.assign(new Error("Phiên sửa lỗi vượt giới hạn phân trang an toàn."), {
        status: 422,
      });
    }
    return { ...merged, nextCursor: null, nextGroupCursor: null };
  }, [requestImportRepair]);

  const issueImportRepairConfirmation = useCallback(
    async (repairId, action, payload, issueId = null, groupId = null) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/human-confirmations`,
      { action, payload, ...(issueId ? { issue_id: issueId } : {}), ...(groupId ? { group_id: groupId } : {}) },
      "Không thể tạo xác nhận thao tác sửa lỗi.",
    )).data,
    [requestImportRepair],
  );

  const confirmImportIssueMatch = useCallback(
    async (repairId, issueId, payload, confirmationToken) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/issues/${encodeURIComponent(issueId)}/confirm-match`,
      withExpectedVersion(payload),
      "Không thể xác nhận chứng từ cho lỗi import.",
      { headers: { "X-Human-Confirmation-Token": confirmationToken } },
    )).data,
    [requestImportRepair],
  );

  const setDocumentImportStatus = useCallback(
    async (repairId, groupId, payload, confirmationToken) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/document-groups/${encodeURIComponent(groupId)}/import-status`,
      withExpectedVersion(payload),
      "Không thể lưu trạng thái import chứng từ.",
      { headers: { "X-Human-Confirmation-Token": confirmationToken } },
    )).data,
    [requestImportRepair],
  );

  const resolveImportIssue = useCallback(
    async (repairId, issueId, payload, confirmationToken) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/issues/${encodeURIComponent(issueId)}/resolve`,
      withExpectedVersion(payload),
      "Không thể áp dụng cách sửa lỗi import.",
      { headers: { "X-Human-Confirmation-Token": confirmationToken } },
    )).data,
    [requestImportRepair],
  );

  const simulateBulkRepair = useCallback(
    async (repairId, payload) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/bulk-actions/simulate`,
      withExpectedVersion(payload),
      "Không thể kiểm tra trước thay đổi hàng loạt.",
    )).data,
    [requestImportRepair],
  );

  const applyBulkRepair = useCallback(
    async (repairId, payload, confirmationToken) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/bulk-actions/apply`,
      withExpectedVersion(payload),
      "Không thể áp dụng sửa hàng loạt.",
      { headers: { "X-Human-Confirmation-Token": confirmationToken } },
    )).data,
    [requestImportRepair],
  );

  const createRetryBatch = useCallback(
    async (repairId, payload, confirmationToken, idempotencyKey) => (await requestImportRepair(
      "POST",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/retry-batches`,
      withExpectedVersion(payload),
      "Không thể tạo file xuất lại.",
      { headers: { "X-Human-Confirmation-Token": confirmationToken, "Idempotency-Key": idempotencyKey } },
    )).data,
    [requestImportRepair],
  );

  const downloadRetryBatch = useCallback(async (repairId, batchId) => {
    const response = await requestImportRepair(
      "GET",
      `/converter/import-repairs/${encodeURIComponent(repairId)}/retry-batches/${encodeURIComponent(batchId)}/download`,
      undefined,
      "Không thể tải file xuất lại.",
      { responseType: "blob" },
    );
    const disposition = response.headers?.["content-disposition"] || "";
    const match = disposition.match(/filename="?([^";\n]+)"?/i);
    return { blob: response.data, filename: match ? match[1] : "MISA-retry.xls" };
  }, [requestImportRepair]);

  const previewMapping = useCallback(async (payload) => {
    return readApiResponse(api.post("/converter/mappings/preview", payload), "Không thể xem trước mapping MISA.");
  }, []);

  const confirmMapping = useCallback(async (payload) => {
    return readApiResponse(api.post("/converter/mappings/confirm", payload), "Không thể lưu setting mapping.");
  }, []);

  const checkReadiness = useCallback(async (payload) => {
    return readApiResponse(api.post("/converter/mappings/readiness", payload), "Không kiểm tra được trạng thái sẵn sàng import MISA.");
  }, []);

  const exportConfirmed = useCallback(
    async (
      uploadId,
      profileId,
      rows,
      acknowledgeWarnings = false,
      conversionContextToken = null,
    ) => {
      const payload = {
        upload_id: uploadId,
        profile_id: profileId,
        acknowledge_warnings: acknowledgeWarnings,
        conversion_context_token: conversionContextToken,
      };
      if (Array.isArray(rows) && rows.length > 0) {
        payload.rows = rows;
      }
      const response = await api.post("/converter/conversions/export", payload, {
        responseType: "blob",
        headers: conversionContextToken ? { "X-Conversion-Context": conversionContextToken } : undefined,
      });
      const blob = response.data;
      const disposition = response.headers["content-disposition"] || "";
      const match = disposition.match(/filename="?([^";\n]+)"?/i);
      return { blob, filename: match ? match[1] : "Import misa.xls" };
    },
    [],
  );

  return {
    templates,
    serviceOnline,
    aiOnline,
    backendCapabilities,
    capabilities,
    capabilitiesOnline,
    misaImportRepair,
    analyzeFile,
    createImportRepair,
    submitImportResultSchema,
    getImportRepair,
    issueImportRepairConfirmation,
    confirmImportIssueMatch,
    setDocumentImportStatus,
    resolveImportIssue,
    simulateBulkRepair,
    applyBulkRepair,
    createRetryBatch,
    downloadRetryBatch,
    previewMapping,
    confirmMapping,
    checkReadiness,
    exportConfirmed,
  };
}
