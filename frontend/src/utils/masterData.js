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
