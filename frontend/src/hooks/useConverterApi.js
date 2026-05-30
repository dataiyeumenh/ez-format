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
  const issues = payload.errors || payload.report?.errors;
  if (Array.isArray(issues) && issues.length) {
    return issues.map((i) => i.message).join("; ");
  }
  return fallback;
}

function buildUploadFormData(file, conversionType, options) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("conversion_type", conversionType);
  if (options && Object.keys(options).length > 0) {
    formData.append("options", JSON.stringify(options));
  }
  return formData;
}

export function useConverterApi() {
  const [conversionTypes, setConversionTypes] = useState([]);
  const [serviceOnline, setServiceOnline] = useState(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(`${pythonBaseURL}/healthz`).then((r) => r.ok),
      fetch(`${pythonBaseURL}/api/v1/conversion-types`).then((r) =>
        r.ok ? r.json() : Promise.reject(),
      ),
    ])
      .then(([online, data]) => {
        if (cancelled) return;
        setServiceOnline(online);
        setConversionTypes(data.items || []);
      })
      .catch(() => {
        if (cancelled) return;
        setServiceOnline(false);
        setConversionTypes([
          { id: "bsn_sales", label: "BSN - Form import bán hàng" },
          { id: "bsn_purchase", label: "BSN - Form import mua hàng" },
        ]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const validateAndPreview = useCallback(async (file, conversionType, options) => {
    const validateRes = await fetch(`${pythonBaseURL}/api/v1/conversions/validate`, {
      method: "POST",
      body: buildUploadFormData(file, conversionType, options),
    });
    const validateData = await validateRes.json().catch(() => ({}));
    if (!validateRes.ok || !validateData.ok) {
      throw new Error(
        formatApiError(validateData, "Dữ liệu không hợp lệ để chuyển đổi."),
      );
    }

    const previewOptions =
      options ||
      (validateData.warnings?.length
        ? { allow_calculation_warnings: true }
        : undefined);

    const previewRes = await fetch(`${pythonBaseURL}/api/v1/conversions/preview`, {
      method: "POST",
      body: buildUploadFormData(file, conversionType, previewOptions),
    });
    const previewData = await previewRes.json().catch(() => ({}));
    if (!previewRes.ok) {
      throw new Error(
        formatApiError(previewData, `Không thể xem trước (HTTP ${previewRes.status})`),
      );
    }

    return {
      headers: previewData.headers || [],
      rows: previewData.rows || [],
      warnings: validateData.warnings || [],
    };
  }, []);

  const exportRows = useCallback(async (conversionType, rows, options) => {
    const response = await fetch(`${pythonBaseURL}/api/v1/conversions/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversion_type: conversionType,
        rows,
        options: options || undefined,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(
        formatApiError(errData, `Không thể tải file (HTTP ${response.status})`),
      );
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";\n]+)"?/i);
    return { blob, filename: match ? match[1] : "MISA_Import.xls" };
  }, []);

  return {
    conversionTypes,
    serviceOnline,
    validateAndPreview,
    exportRows,
  };
}
