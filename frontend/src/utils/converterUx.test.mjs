import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMappingField,
  filterMappingItems,
  getDownloadCtaState,
  summarizeMappingFields,
} from "./converterUx.js";

test("classifies each mapping mode without hiding mixed configurations", () => {
  assert.equal(classifyMappingField("A", { A: "Raw" }, {}, {}).mode, "mapped");
  assert.equal(classifyMappingField("A", {}, { A: "Default" }, {}).mode, "default");
  assert.equal(classifyMappingField("A", {}, {}, { A: "${B}" }).mode, "formula");
  assert.equal(classifyMappingField("A", {}, {}, {}).mode, "unmapped");
  assert.equal(
    classifyMappingField("A", { A: "Raw" }, { A: "Fallback" }, {}).mode,
    "mixed",
  );
});

test("marks required fields and required attention independently of backend severity", () => {
  const missing = classifyMappingField("Mã hàng (*)", {}, {}, {});
  const mixed = classifyMappingField(
    "Ngày chứng từ (*)",
    { "Ngày chứng từ (*)": "Ngày" },
    { "Ngày chứng từ (*)": "01/01/2026" },
    {},
  );

  assert.equal(missing.required, true);
  assert.equal(missing.requiredAttention, true);
  assert.equal(mixed.required, true);
  assert.equal(mixed.requiredAttention, true);
});

test("summary accounts for every target header", () => {
  const summary = summarizeMappingFields(
    ["A (*)", "B", "C", "D", "E"],
    { "A (*)": "Raw A", E: "Raw E" },
    { B: "Default", E: "Fallback" },
    { C: "${A (*)}" },
  );

  assert.deepEqual(summary.counts, {
    all: 5,
    mapped: 1,
    default: 1,
    formula: 1,
    unmapped: 1,
    mixed: 1,
    requiredAttention: 0,
  });
  assert.deepEqual(
    filterMappingItems(summary.items, "mixed").map((item) => item.target),
    ["E"],
  );
});

test("required attention includes deterministic backend blockers after readiness", () => {
  const summary = summarizeMappingFields(
    ["Mã hàng (*)", "Tên hàng"],
    { "Mã hàng (*)": "Mã hàng" },
    {},
    {},
    [
      {
        severity: "blocker",
        code: "required_value_blank",
        field: "Mã hàng (*)",
      },
    ],
  );

  assert.equal(summary.counts.requiredAttention, 1);
  assert.equal(summary.items[0].backendBlocker, true);
});

test("CTA starts with validation instead of pretending to download", () => {
  assert.deepEqual(
    getDownloadCtaState({ hasAnalyzePayload: true }),
    {
      label: "Kiểm tra trước khi tải",
      helper: "Bước 1/2: kiểm tra lỗi và cảnh báo trước khi tạo file MISA.",
      action: "validate",
      disabled: false,
      loading: false,
    },
  );
});

test("CTA prioritizes validation, blockers, warnings and export states safely", () => {
  assert.equal(
    getDownloadCtaState({ hasAnalyzePayload: true, readinessLoading: true }).label,
    "Đang kiểm tra dữ liệu…",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      readinessReport: { summary: { blocker: 1, warning: 0 } },
    }).label,
    "Cần sửa lỗi trước khi tải",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      readinessReport: { summary: { blocker: 0, warning: 1 } },
    }).label,
    "Xác nhận cảnh báo để tải",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      readinessReport: { summary: { blocker: 0, warning: 1 } },
      acknowledgeWarnings: true,
    }).action,
    "download",
  );
  assert.equal(
    getDownloadCtaState({ hasAnalyzePayload: true, isDownloading: true }).label,
    "Đang tạo file MISA…",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      isSuccess: true,
      readinessReport: { summary: { blocker: 0, warning: 0 } },
    }).label,
    "Tải lại file MISA",
  );
});
