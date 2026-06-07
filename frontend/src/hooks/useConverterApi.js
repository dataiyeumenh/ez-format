import { useCallback, useEffect, useState } from "react";

const viteEnv = import.meta.env || {};
const pythonBaseURL = viteEnv.VITE_PYTHON_API_URL
  ? `${viteEnv.VITE_PYTHON_API_URL}`
  : "/python-api";

const HEALTH_URL = `${pythonBaseURL}/healthz`;
const TEMPLATES_URL = `${pythonBaseURL}/api/v1/templates`;
const STATUS_REFRESH_MS = 15000;

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

function buildUploadFormData(file, targetTemplateId) {
  const formData = new FormData();
  formData.append("file", file);
  if (targetTemplateId) formData.append("target_template_id", targetTemplateId);
  return formData;
}

async function readJsonResponse(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatApiError(data, fallback));
  }
  return data;
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

export async function fetchConverterStatus(fetchImpl = fetch) {
  const [healthResult, templatesResult] = await Promise.allSettled([
    fetchJson(fetchImpl, HEALTH_URL),
    fetchJson(fetchImpl, TEMPLATES_URL),
  ]);

  const health =
    healthResult.status === "fulfilled" ? healthResult.value : null;
  const templatesData =
    templatesResult.status === "fulfilled" ? templatesResult.value : null;

  const serviceOnline = Boolean(health || templatesData);

  return {
    serviceOnline,
    aiOnline: health ? aiStatusFromHealth(health) : null,
    templates: templatesData?.items || [],
  };
}

export function useConverterApi() {
  const [templates, setTemplates] = useState([]);
  const [serviceOnline, setServiceOnline] = useState(null);
  const [aiOnline, setAiOnline] = useState(null); // null=loading, true=online, false=offline, "disabled"=không cấu hình

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = () => {
      fetchConverterStatus()
        .then(({ serviceOnline, aiOnline, templates }) => {
          if (cancelled) return;
          setServiceOnline(serviceOnline);
          setAiOnline(aiOnline);
          setTemplates(templates);
        })
        .catch(() => {
          if (cancelled) return;
          setServiceOnline(false);
          setAiOnline(false);
          setTemplates([]);
        });
    };

    refreshStatus();
    const refreshTimer = window.setInterval(refreshStatus, STATUS_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, []);

  const analyzeFile = useCallback(async (file, targetTemplateId) => {
    const response = await fetch(`${pythonBaseURL}/api/v1/uploads/analyze`, {
      method: "POST",
      body: buildUploadFormData(file, targetTemplateId),
    });
    return readJsonResponse(response, "Không thể phân tích file Excel.");
  }, []);

  const previewMapping = useCallback(async (payload) => {
    const response = await fetch(`${pythonBaseURL}/api/v1/mappings/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return readJsonResponse(response, "Không thể xem trước mapping MISA.");
  }, []);

  const confirmMapping = useCallback(async (payload) => {
    const response = await fetch(`${pythonBaseURL}/api/v1/mappings/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return readJsonResponse(response, "Không thể lưu setting mapping.");
  }, []);

  const exportConfirmed = useCallback(async (uploadId, profileId) => {
    const response = await fetch(`${pythonBaseURL}/api/v1/conversions/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id: uploadId, profile_id: profileId }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(formatApiError(errData, "Không thể tải file MISA."));
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";\n]+)"?/i);
    return { blob, filename: match ? match[1] : "Import misa.xls" };
  }, []);

  return {
    templates,
    serviceOnline,
    aiOnline,
    analyzeFile,
    previewMapping,
    confirmMapping,
    exportConfirmed,
  };
}
