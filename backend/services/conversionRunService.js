const VALID_STATUSES = new Set(["processing", "completed", "failed", "cancelled"]);

// Run "processing" quá ngưỡng này mà chưa hoàn tất -> coi như user đã hủy.
const STALE_PROCESSING_MS = 5 * 60 * 60 * 1000; // 5 giờ

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = Math.round(size * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded} ${units[unitIndex]}`;
}

function startOfDay(value) {
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function endOfDay(value) {
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T23:59:59.999Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function buildConversionRunFilter(query = {}) {
  const filter = {};
  if (query.status && VALID_STATUSES.has(String(query.status))) {
    filter.status = String(query.status);
  }

  const from = query.from ? startOfDay(query.from) : null;
  const to = query.to ? endOfDay(query.to) : null;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  return filter;
}

function serializeConversionRun(run) {
  const user = run.user || {};
  const name = run.userNameSnapshot || user.name || "Không rõ";
  const email = run.userEmailSnapshot || user.email || "";
  const createdAt = run.createdAt || run.startedAt || null;

  return {
    id: String(run._id),
    user: {
      id: user._id ? String(user._id) : String(run.user || ""),
      name,
      email,
    },
    fileName: run.fileName,
    format: run.outputFormat || "MISA",
    fileSizeBytes: run.fileSizeBytes || 0,
    size: formatBytes(run.fileSizeBytes || 0),
    status: run.status,
    targetTemplateId: run.targetTemplateId || "",
    converterUploadId: run.converterUploadId || "",
    errorMessage: run.errorMessage || "",
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    createdAt,
    updatedAt: run.updatedAt || null,
  };
}

function summarizeConversionRuns(runs) {
  return runs.reduce(
    (stats, run) => {
      stats.total += 1;
      if (run.status === "completed") stats.completed += 1;
      else if (run.status === "failed") stats.failed += 1;
      else if (run.status === "processing") stats.processing += 1;
      else if (run.status === "cancelled") stats.cancelled += 1;
      return stats;
    },
    { total: 0, completed: 0, failed: 0, processing: 0, cancelled: 0 },
  );
}

module.exports = {
  VALID_STATUSES,
  STALE_PROCESSING_MS,
  buildConversionRunFilter,
  formatBytes,
  serializeConversionRun,
  summarizeConversionRuns,
};
