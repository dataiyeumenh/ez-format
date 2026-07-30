import assert from "node:assert/strict";
import test, { after } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const vite = await createServer({
  root: frontendRoot,
  appType: "custom",
  server: { middlewareMode: true },
});

after(async () => vite.close());

async function loadComponent(name) {
  const module = await vite.ssrLoadModule(`/src/components/converter/${name}.jsx`);
  return module.default;
}

test("profile card exposes drift review without presenting it as confirmed", async () => {
  const MappingProfileV2Card = await loadComponent("MappingProfileV2Card");
  const html = renderToStaticMarkup(
    React.createElement(MappingProfileV2Card, {
      profileMatch: {
        name: "Nhà cung cấp A",
        match_tier: "compatible",
        drift: [{ old_field: "MST", current_field: "Mã số thuế" }],
      },
    }),
  );

  assert.match(html, /Nhà cung cấp A/);
  assert.match(html, /thay đổi cấu trúc cần xem/);
  assert.match(html, /Xem thay đổi/);
});

test("profile card distinguishes approved risk from an unapproved exact candidate", async () => {
  const MappingProfileV2Card = await loadComponent("MappingProfileV2Card");
  const approvedHtml = renderToStaticMarkup(
    React.createElement(MappingProfileV2Card, {
      profileMatch: {
        match_tier: "exact",
        mapping_source: "profile_v2",
        approval_state: "approved",
        approval_applies_to_match: true,
        approved_risk_flags: ["vat"],
        unapproved_risk_flags: [],
        can_suggest: true,
        requires_preview: true,
        profile: { name: "Nhà cung cấp A" },
      },
    }),
  );
  assert.match(approvedHtml, /đã phê duyệt/i);
  assert.match(approvedHtml, /Nguồn mapping thực tế: Mapping Profile V2/);
  assert.match(approvedHtml, /1 trường rủi ro đã phê duyệt/);

  const unapprovedHtml = renderToStaticMarkup(
    React.createElement(MappingProfileV2Card, {
      profileMatch: {
        match_tier: "exact",
        mapping_source: "heuristic",
        approval_state: "unapproved",
        approval_applies_to_match: false,
        approved_risk_flags: [],
        unapproved_risk_flags: ["vat"],
        can_suggest: false,
        requires_preview: true,
        profile: { name: "Nhà cung cấp B" },
      },
    }),
  );
  assert.match(unapprovedHtml, /chưa được phê duyệt/i);
  assert.match(unapprovedHtml, /Nguồn mapping thực tế: Heuristic/);
  assert.match(unapprovedHtml, /1 trường rủi ro chưa phê duyệt/);
  assert.match(unapprovedHtml, /<button[^>]*disabled/);
});

test("anomaly workspace labels statistical findings as review-only", async () => {
  const AnomalyWorkspace = await loadComponent("AnomalyWorkspace");
  const html = renderToStaticMarkup(
    React.createElement(AnomalyWorkspace, {
      issues: [
        {
          id: "a-1",
          deterministic: false,
          severity: "warning",
          field: "Đơn giá",
          row_id: "25",
          actual: "96.000",
          message: "Cao hơn nhóm tham chiếu",
        },
      ],
    }),
  );

  assert.match(html, /Cần kiểm tra/);
  assert.match(html, /Không tự chặn tải file/);
  assert.match(html, /Đơn giá/);
});

test("optional reconciliation clearly permits skipping the step", async () => {
  const ReconciliationWorkspace = await loadComponent("ReconciliationWorkspace");
  const html = renderToStaticMarkup(
    React.createElement(ReconciliationWorkspace, {
      primaryFile: { name: "raw.xlsx" },
      comparisonFiles: [],
      maxFiles: 2,
    }),
  );

  assert.match(html, /không bắt buộc/i);
  assert.match(html, /Bỏ qua bước này/);
  assert.match(html, /raw.xlsx/);
});

test("ambiguous reconciliation candidates require a choice and retain review evidence", async () => {
  const ReconciliationWorkspace = await loadComponent("ReconciliationWorkspace");
  const html = renderToStaticMarkup(
    React.createElement(ReconciliationWorkspace, {
      primaryFile: { name: "raw.xlsx" },
      comparisonFiles: [
        { id: "invoice-file", name: "invoices.xlsx", role: "invoice_export" },
      ],
      report: {
        status: "conflict",
        records: [
          {
            match_id: "candidate-1",
            status: "candidate",
            invoice_number: "HD-001",
            reason: "invoice_date_counterparty_total",
            amount_delta: "-12000",
            comparison_record_ids: ["comparison-1", "comparison-2"],
            comparison_options: [
              {
                record_id: "comparison-1",
                label: "HD-001 · 01/07/2026 · Công ty A · dòng 2",
              },
              {
                record_id: "comparison-2",
                label: "HD-001 · 01/07/2026 · Công ty A · dòng 3",
              },
            ],
          },
        ],
      },
    }),
  );

  assert.match(html, /Số hóa đơn, ngày, đối tác và tổng tiền/);
  assert.match(html, /Chênh lệch: Tổng tiền: -12000/);
  assert.match(html, /Chọn bản ghi đối chiếu/);
  assert.match(
    html,
    /<option value="comparison-1">HD-001 · 01\/07\/2026 · Công ty A · dòng 2<\/option>/,
  );
  assert.doesNotMatch(html, />comparison-1<\/option>/);
  assert.match(html, /Không ghép bản ghi này/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Xác nhận ghép<\/button>/);
});

test("reconciliation presents an unavailable comparison-file allowance accurately", async () => {
  const ReconciliationWorkspace = await loadComponent("ReconciliationWorkspace");
  const html = renderToStaticMarkup(
    React.createElement(ReconciliationWorkspace, {
      primaryFile: { name: "raw.xlsx" },
      comparisonFiles: [],
      maxFiles: 0,
    }),
  );

  assert.match(html, /Đối chiếu bằng file khác chưa được bật/);
  assert.match(html, /Không hỗ trợ file đối chiếu/);
});

test("assistant entry explains deterministic fallback when local AI is offline", async () => {
  const AccountingAssistantDrawer = await loadComponent("AccountingAssistantDrawer");
  const html = renderToStaticMarkup(
    React.createElement(AccountingAssistantDrawer, {
      session: { sessionId: "s-1", revision: 1, stateHash: "state-1" },
      fileName: "raw.xlsx",
      aiOnline: false,
    }),
  );

  assert.match(html, /Hỏi về file này/);
  assert.match(html, /Tra cứu và phép tính xác định vẫn hoạt động/);
});

test("wizard progress exposes the current step to assistive technology", async () => {
  const module = await vite.ssrLoadModule("/src/components/ui/StepProgress.jsx");
  const html = renderToStaticMarkup(
    React.createElement(module.default, {
      steps: ["Tải file", "Ghép cột", "Đối chiếu", "Tải MISA"],
      current: 2,
    }),
  );

  assert.match(html, /aria-label="Tiến trình chuyển đổi"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Đối chiếu/);
  assert.match(html, /Bước 3\/4 · Đối chiếu/);
});
