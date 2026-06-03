import { useCallback, useEffect, useState } from "react";

const pythonBaseURL = import.meta.env.VITE_PYTHON_API_URL
  ? `${import.meta.env.VITE_PYTHON_API_URL}`
  : "/python-api";

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

export function useConverterApi() {
  const [templates, setTemplates] = useState([]);
  const [serviceOnline, setServiceOnline] = useState(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(`${pythonBaseURL}/healthz`).then((r) => r.ok),
      fetch(`${pythonBaseURL}/api/v1/templates`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error("templates unavailable")),
      ),
    ])
      .then(([online, data]) => {
        if (cancelled) return;
        setServiceOnline(online);
        setTemplates(data.items || []);
      })
      .catch(() => {
        if (cancelled) return;
        setServiceOnline(false);
        setTemplates([]);
      });

    return () => {
      cancelled = true;
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
    analyzeFile,
    previewMapping,
    confirmMapping,
    exportConfirmed,
  };
}
