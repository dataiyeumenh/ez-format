export const CATALOG_LABELS = Object.freeze({
  account: "Hệ thống tài khoản",
  supplier: "Nhà cung cấp",
  customer: "Khách hàng",
  item: "Vật tư hàng hóa",
  warehouse: "Kho",
  unit: "Đơn vị tính",
  employee: "Nhân viên",
  bank_account: "Tài khoản ngân hàng",
});

export const PRIMARY_CATALOG_TYPES = [
  "account",
  "supplier",
  "customer",
  "item",
  "warehouse",
  "unit",
];

export const MASTER_DATA_PAGE_SIZE = 20;

const ACTION_REQUIRED_STATUSES = new Set(["suggested", "missing", "conflict"]);

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

export function summarizeMasterData(resolutions = []) {
  return resolutions.reduce(
    (summary, item) => {
      if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
        summary[item.status] += 1;
      }
      return summary;
    },
    { verified: 0, suggested: 0, missing: 0, conflict: 0, not_checked: 0 },
  );
}

export function groupMasterDataResolutions(resolutions = []) {
  const grouped = new Map();
  for (const item of resolutions) {
    const key = `${item.catalog_type || ""}|${item.field || ""}|${item.raw_value || ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.affected_rows += Number(item.affected_rows || 0);
      continue;
    }
    grouped.set(key, {
      ...item,
      affected_rows: Number(item.affected_rows || 0),
    });
  }
  return [...grouped.values()];
}

export function summarizeResolutionGroups(resolutions = []) {
  const grouped = groupMasterDataResolutions(resolutions);
  return grouped.reduce(
    (summary, item) => {
      if (ACTION_REQUIRED_STATUSES.has(item.status)) summary.actionRequired += 1;
      if (item.status === "not_checked") summary.notChecked += 1;
      if (item.status === "verified") summary.verified += 1;
      if (item.required && ["missing", "conflict"].includes(item.status)) {
        summary.requiredCritical += 1;
      }
      return summary;
    },
    {
      actionRequired: 0,
      notChecked: 0,
      verified: 0,
      requiredCritical: 0,
      total: grouped.length,
    },
  );
}

export function filterMasterDataResolutions(
  resolutions = [],
  { statusFilter = "all", query = "" } = {},
) {
  const normalizedQuery = normalizeSearchText(query);
  return resolutions.filter((item) => {
    if (
      statusFilter === "action_required" &&
      !ACTION_REQUIRED_STATUSES.has(item.status)
    ) {
      return false;
    }
    if (statusFilter !== "all" && statusFilter !== "action_required") {
      if (item.status !== statusFilter) return false;
    }
    if (!normalizedQuery) return true;

    const candidates = (item.candidates || []).flatMap((candidate) => [
      candidate.code,
      candidate.name,
      candidate.tax_code,
    ]);
    const searchable = [
      CATALOG_LABELS[item.catalog_type],
      item.catalog_type,
      item.field,
      item.raw_value,
      item.target_code,
      ...candidates,
    ];
    return searchable.some((value) =>
      normalizeSearchText(value).includes(normalizedQuery),
    );
  });
}

export function paginateMasterDataResolutions(
  resolutions = [],
  requestedPage = 0,
  pageSize = MASTER_DATA_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Number(pageSize) || MASTER_DATA_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(resolutions.length / safePageSize));
  const page = Math.min(
    totalPages - 1,
    Math.max(0, Math.trunc(Number(requestedPage) || 0)),
  );
  const offset = page * safePageSize;
  const items = resolutions.slice(offset, offset + safePageSize);
  return {
    items,
    page,
    totalPages,
    total: resolutions.length,
    start: resolutions.length ? offset + 1 : 0,
    end: offset + items.length,
  };
}

export function indexMasterDataSnapshots(snapshots = []) {
  const result = {};
  for (const snapshot of snapshots) {
    if (!result[snapshot.type]) {
      result[snapshot.type] = { active: null, ready: null, latest: snapshot };
    }
    if (snapshot.status === "active" && !result[snapshot.type].active) {
      result[snapshot.type].active = snapshot;
    }
    if (snapshot.status === "ready" && !result[snapshot.type].ready) {
      result[snapshot.type].ready = snapshot;
    }
  }
  return result;
}
