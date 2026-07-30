import { useCallback, useEffect, useState } from "react";
import api from "../services/api.js";
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

function buildUploadFormData(file, targetTemplateId, conversionContextToken = null) {
  const formData = new FormData();
  formData.append("file", file);
  if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
  if (conversionContextToken) {
    formData.append("conversion_context_token", conversionContextToken);
  }
  return formData;
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

  return {
    serviceOnline,
    aiOnline: health ? aiStatusFromHealth(health) : null,
    backendCapabilities: backend?.capabilities || null,
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

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = () => {
      fetchConverterStatus()
        .then(({ serviceOnline, aiOnline, backendCapabilities, templates }) => {
          if (cancelled) return;
          setServiceOnline(serviceOnline);
          setAiOnline(aiOnline);
          setBackendCapabilities(backendCapabilities);
          setTemplates(templates);
        })
        .catch(() => {
          if (cancelled) return;
          setServiceOnline(false);
          setAiOnline(false);
          setBackendCapabilities(null);
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
    analyzeFile,
    previewMapping,
    confirmMapping,
    checkReadiness,
    exportConfirmed,
  };
}
