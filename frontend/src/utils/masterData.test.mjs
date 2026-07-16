import assert from "node:assert/strict";
import test from "node:test";

import {
  CATALOG_LABELS,
  groupMasterDataResolutions,
  indexMasterDataSnapshots,
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
