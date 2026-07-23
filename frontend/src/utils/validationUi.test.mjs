import assert from "node:assert/strict";
import test from "node:test";

import {
  VALIDATION_PAGE_SIZE,
  filterValidationIssues,
  paginateValidationIssues,
  summarizeValidationIssues,
} from "./validationUi.js";

test("validation summary keeps every severity count", () => {
  assert.deepEqual(
    summarizeValidationIssues([
      { severity: "blocker" },
      { severity: "warning" },
      { severity: "warning" },
      { severity: "info" },
    ]),
    { all: 4, blocker: 1, warning: 2, info: 1 },
  );
});

test("validation filters search accounting context without changing issue objects", () => {
  const issues = [
    {
      severity: "blocker",
      row: 25,
      field: "Tiền thuế GTGT",
      invoice: "HD001",
      message: "Tiền thuế không khớp",
      actual: 10000,
      expected: 8000,
    },
    {
      severity: "warning",
      row: null,
      field: "Mã khách hàng",
      message: "Chưa đối chiếu danh mục",
    },
  ];

  const filtered = filterValidationIssues(issues, {
    severity: "blocker",
    query: "thue hd001 25",
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0], issues[0]);
});

test("validation pagination limits each page to twenty five issues", () => {
  const issues = Array.from({ length: 61 }, (_, index) => ({ code: `issue-${index}` }));
  const page = paginateValidationIssues(issues, 2);

  assert.equal(VALIDATION_PAGE_SIZE, 25);
  assert.equal(page.items.length, 11);
  assert.equal(page.totalPages, 3);
  assert.equal(page.start, 51);
  assert.equal(page.end, 61);
});
