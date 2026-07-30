export const RECONSTRUCTION_TYPE_LABELS = {
  purchase_goods: "Mua hàng hóa",
  purchase_services: "Mua dịch vụ",
  sales_goods: "Bán hàng hóa",
  sales_services: "Bán dịch vụ",
  purchase_mixed: "Mua hỗn hợp",
  sales_mixed: "Bán hỗn hợp",
  unknown: "Chưa xác định",
};

export const RECONSTRUCTION_STATUS = {
  ready: {
    label: "Sẵn sàng",
    className: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  },
  needs_review: {
    label: "Cần kiểm tra",
    className: "bg-amber-100 text-amber-900 ring-amber-200",
  },
  blocked: {
    label: "Bị chặn",
    className: "bg-red-100 text-red-800 ring-red-200",
  },
};

export function reconstructionTypeKey(draft) {
  if (!draft || draft.direction === "unknown" || draft.nature === "unknown") {
    return "unknown";
  }
  if (draft.nature === "mixed") return `${draft.direction}_mixed`;
  return `${draft.direction}_${draft.nature === "service" ? "services" : "goods"}`;
}

export function reconstructionTypeLabel(draft) {
  return RECONSTRUCTION_TYPE_LABELS[reconstructionTypeKey(draft)] || "Chưa xác định";
}

export function flattenValidationIssues(validation) {
  return Object.entries(validation?.templates || {}).flatMap(([templateId, report]) =>
    (report?.issues || []).map((issue) => ({ ...issue, templateId })),
  );
}

export function filenameFromDisposition(disposition, fallback = "Import MISA.xls") {
  const match = String(disposition || "").match(/filename="?([^";\n]+)"?/i);
  return match?.[1] || fallback;
}

export function getReconstructionAvailability({ featureEnabled, backendCapabilities }) {
  if (!featureEnabled) {
    return { enabled: false, reason: "Tính năng tái tạo chứng từ chưa được bật." };
  }
  if (!backendCapabilities?.voucherReconstruction) {
    return { enabled: false, reason: "Tính năng tái tạo chứng từ chưa sẵn sàng trên máy chủ." };
  }
  if (!backendCapabilities.converterGateway) {
    return { enabled: false, reason: "Đường phân tích tái tạo chưa sẵn sàng trên máy chủ." };
  }
  return { enabled: true, reason: "" };
}

export function fieldDisplayValue(field) {
  if (!field || field.value === null || field.value === undefined) return "";
  return String(field.value);
}

export function hasActiveCatalog(workspace, type) {
  return Boolean(
    type && workspace?.activeSnapshots?.some((snapshot) => snapshot.type === type),
  );
}
