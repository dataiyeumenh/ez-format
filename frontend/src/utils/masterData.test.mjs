import assert from "node:assert/strict";
import test from "node:test";

import {
  CATALOG_LABELS,
  MASTER_DATA_PAGE_SIZE,
  filterMasterDataResolutions,
  groupMasterDataResolutions,
  indexMasterDataSnapshots,
  paginateMasterDataResolutions,
  summarizeResolutionGroups,
  summarizeMasterData,
} from "./masterData.js";

test("catalog labels are user friendly", () => {
  assert.equal(CATALOG_LABELS.supplier, "Nhà cung cấp");
  assert.equal(CATALOG_LABELS.account, "Hệ thống tài khoản");
});

test("resolutions are grouped by catalog, field and raw value", () => {
  const grouped = groupMasterDataResolutions([
    {
      catalog_type: "supplier",
      field: "Mã nhà cung cấp",
      raw_value: "BAE",
      status: "suggested",
      affected_rows: 2,
    },
    {
      catalog_type: "supplier",
      field: "Mã nhà cung cấp",
      raw_value: "BAE",
      status: "suggested",
      affected_rows: 3,
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].affected_rows, 5);
});

test("summary counts resolution statuses", () => {
  assert.deepEqual(
    summarizeMasterData([
      { status: "verified" },
      { status: "verified" },
      { status: "missing" },
      { status: "suggested" },
    ]),
    { verified: 2, suggested: 1, missing: 1, conflict: 0, not_checked: 0 },
  );
});

test("ready snapshot remains visible next to the active snapshot", () => {
  const indexed = indexMasterDataSnapshots([
    { id: "ready-new", type: "item", status: "ready" },
    { id: "active-old", type: "item", status: "active" },
  ]);

  assert.equal(indexed.item.ready.id, "ready-new");
  assert.equal(indexed.item.active.id, "active-old");
});

test("resolution summary groups duplicates before counting statuses", () => {
  const summary = summarizeResolutionGroups([
    {
      catalog_type: "item",
      field: "Mã hàng (*)",
      raw_value: "SP01",
      status: "missing",
      required: true,
      affected_rows: 2,
    },
    {
      catalog_type: "item",
      field: "Mã hàng (*)",
      raw_value: "SP01",
      status: "missing",
      required: true,
      affected_rows: 3,
    },
    { catalog_type: "account", field: "TK Nợ", raw_value: "131", status: "not_checked" },
    { catalog_type: "customer", field: "Mã khách hàng", raw_value: "KH01", status: "verified" },
  ]);

  assert.deepEqual(summary, {
    actionRequired: 1,
    notChecked: 1,
    verified: 1,
    requiredCritical: 1,
    total: 3,
  });
});

test("resolution filters support status and accent-insensitive search", () => {
  const resolutions = [
    {
      catalog_type: "supplier",
      field: "Mã nhà cung cấp",
      raw_value: "BAE",
      status: "suggested",
      candidates: [{ code: "NCC01", name: "Công ty Bách Á" }],
    },
    {
      catalog_type: "item",
      field: "Mã hàng (*)",
      raw_value: "SP01",
      status: "verified",
      target_code: "HH01",
    },
  ];

  assert.equal(
    filterMasterDataResolutions(resolutions, {
      statusFilter: "action_required",
      query: "bach a",
    }).length,
    1,
  );
  assert.equal(
    filterMasterDataResolutions(resolutions, { statusFilter: "verified", query: "HH01" })[0]
      .raw_value,
    "SP01",
  );
});

test("resolution pagination never exposes more than twenty rows", () => {
  const resolutions = Array.from({ length: 45 }, (_, index) => ({ raw_value: `M${index}` }));
  const result = paginateMasterDataResolutions(resolutions, 2);

  assert.equal(MASTER_DATA_PAGE_SIZE, 20);
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 3);
  assert.equal(result.items.length, 5);
  assert.equal(result.start, 41);
  assert.equal(result.end, 45);
});
