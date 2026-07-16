import assert from "node:assert/strict";
import test from "node:test";

import {
  filenameFromDisposition,
  flattenValidationIssues,
  hasActiveCatalog,
  reconstructionTypeLabel,
} from "./reconstruction.js";

test("reconstruction type labels mixed and service drafts", () => {
  assert.equal(
    reconstructionTypeLabel({ direction: "purchase", nature: "service" }),
    "Mua dịch vụ",
  );
  assert.equal(
    reconstructionTypeLabel({ direction: "sales", nature: "mixed" }),
    "Bán hỗn hợp",
  );
});

test("validation issues retain template id", () => {
  const issues = flattenValidationIssues({
    templates: {
      purchase_goods: { issues: [{ code: "required_value_blank" }] },
    },
  });
  assert.deepEqual(issues, [
    { code: "required_value_blank", templateId: "purchase_goods" },
  ]);
});

test("download filename is parsed from content disposition", () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="Import MISA purchase.xls"'),
    "Import MISA purchase.xls",
  );
});

test("catalog search only runs for active workspace catalogs", () => {
  const workspace = {
    activeSnapshots: [{ type: "supplier" }, { type: "item" }],
  };
  assert.equal(hasActiveCatalog(workspace, "item"), true);
  assert.equal(hasActiveCatalog(workspace, "unit"), false);
  assert.equal(hasActiveCatalog(null, "item"), false);
});
