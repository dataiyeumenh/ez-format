const MAPPING_MODES = ["mapped", "default", "formula"];

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function classifyMappingField(
  target,
  targetMapping = {},
  defaults = {},
  formulas = {},
) {
  const activeModes = [];
  if (hasValue(targetMapping[target])) activeModes.push("mapped");
  if (hasValue(defaults[target])) activeModes.push("default");
  if (hasValue(formulas[target])) activeModes.push("formula");

  const mode =
    activeModes.length === 0
      ? "unmapped"
      : activeModes.length > 1
        ? "mixed"
        : activeModes[0];
  const required = String(target).includes("(*)");

  return {
    target,
    mode,
    activeModes,
    required,
    requiredAttention: required && (mode === "unmapped" || mode === "mixed"),
  };
}

export function summarizeMappingFields(
  targetHeaders = [],
  targetMapping = {},
  defaults = {},
  formulas = {},
  backendIssues = [],
) {
  const blockerFields = new Set(
    backendIssues
      .filter((issue) => issue?.severity === "blocker" && hasValue(issue?.field))
      .map((issue) => String(issue.field)),
  );
  const items = targetHeaders.map((target) => {
    const item = classifyMappingField(target, targetMapping, defaults, formulas);
    const backendBlocker = item.required && blockerFields.has(target);
    return {
      ...item,
      backendBlocker,
      requiredAttention: item.requiredAttention || backendBlocker,
    };
  });
  const counts = {
    all: items.length,
    mapped: 0,
    default: 0,
    formula: 0,
    unmapped: 0,
    mixed: 0,
    requiredAttention: 0,
  };

  for (const item of items) {
    if (MAPPING_MODES.includes(item.mode) || item.mode === "unmapped" || item.mode === "mixed") {
      counts[item.mode] += 1;
    }
    if (item.requiredAttention) counts.requiredAttention += 1;
  }

  return { items, counts };
}

export function filterMappingItems(items = [], filter = "all") {
  if (filter === "all") return items;
  if (filter === "requiredAttention") {
    return items.filter((item) => item.requiredAttention);
  }
  return items.filter((item) => item.mode === filter);
}

export function getDownloadCtaState({
  hasAnalyzePayload = false,
  readinessReport = null,
  readinessLoading = false,
  acknowledgeWarnings = false,
  isDownloading = false,
  isSuccess = false,
} = {}) {
  if (!hasAnalyzePayload) {
    return { label: "", helper: "", action: "none", disabled: true, loading: false };
  }
  if (isDownloading) {
    return {
      label: "Đang tạo file MISA…",
      helper: "Bước 2/2: backend đang xác nhận lần cuối và tạo file MISA.",
      action: "none",
      disabled: true,
      loading: true,
    };
  }
  if (readinessLoading) {
    return {
      label: "Đang kiểm tra dữ liệu…",
      helper: "Bước 1/2: file lớn có thể cần thêm thời gian để kiểm tra.",
      action: "none",
      disabled: true,
      loading: true,
    };
  }
  if (!readinessReport) {
    return {
      label: "Kiểm tra trước khi tải",
      helper: "Bước 1/2: kiểm tra lỗi và cảnh báo trước khi tạo file MISA.",
      action: "validate",
      disabled: false,
      loading: false,
    };
  }

  const blockers = Number(readinessReport.summary?.blocker || 0);
  const warnings = Number(readinessReport.summary?.warning || 0);
  if (blockers > 0) {
    return {
      label: "Cần sửa lỗi trước khi tải",
      helper: `Còn ${blockers} lỗi chắc chắn cần sửa.`,
      action: "none",
      disabled: true,
      loading: false,
    };
  }
  if (warnings > 0 && !acknowledgeWarnings) {
    return {
      label: "Xác nhận cảnh báo để tải",
      helper: `Hãy rà soát và xác nhận ${warnings} cảnh báo trước khi tải.`,
      action: "none",
      disabled: true,
      loading: false,
    };
  }

  return {
    label: isSuccess ? "Tải lại file MISA" : "Tải file MISA",
    helper: "Bước 2/2: backend xác nhận lần cuối rồi điền dữ liệu vào template MISA.",
    action: "download",
    disabled: false,
    loading: false,
  };
}
