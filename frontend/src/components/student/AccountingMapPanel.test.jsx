// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import AccountingMapPanel from "./AccountingMapPanel";

afterEach(cleanup);

test("renders every accounting evidence and navigates each source row", async () => {
  const onEvidenceNavigate = vi.fn();
  const user = userEvent.setup();
  render(
    <AccountingMapPanel
      data={{
        maps: [
          {
            voucher_id: "voucher-1",
            business_event: "sales_goods",
            business_event_status: "suggested",
            balanced: true,
            issues: [],
            entries: [
              {
                side: "debit",
                account: "131",
                amount: "100",
                status: "suggested",
                reason_vi: "Tài khoản có căn cứ nguồn.",
                evidence: [
                  {
                    voucher_id: "voucher-1",
                    source_rows: [2],
                    preview_rows: [1],
                    target_field: "TK Nợ",
                  },
                  {
                    voucher_id: "voucher-1",
                    source_rows: [4, 5],
                    preview_rows: [3, 4],
                    target_field: "TK Có",
                  },
                ],
              },
            ],
          },
        ],
      }}
      loading={false}
      error=""
      onRefresh={vi.fn()}
      onEvidenceNavigate={onEvidenceNavigate}
    />,
  );

  const evidenceList = screen.getByRole("list", {
    name: "Căn cứ cho bút toán Nợ 131",
  });
  expect(within(evidenceList).getAllByRole("listitem")).toHaveLength(2);
  expect(within(evidenceList).getByText("TK Nợ")).toBeTruthy();
  expect(within(evidenceList).getByText("TK Có")).toBeTruthy();
  expect(evidenceList.getAttribute("tabindex")).toBe("0");
  expect(
    document.getElementById(evidenceList.getAttribute("aria-describedby"))?.textContent,
  ).toContain("Dùng phím mũi tên");

  await user.click(
    within(evidenceList).getByRole("button", {
      name: "Mở dòng nguồn 2, trường đích TK Nợ",
    }),
  );
  await user.click(
    within(evidenceList).getByRole("button", {
      name: "Mở dòng nguồn 4, trường đích TK Có",
    }),
  );
  await user.click(
    within(evidenceList).getByRole("button", {
      name: "Mở dòng nguồn 5, trường đích TK Có",
    }),
  );

  expect(onEvidenceNavigate).toHaveBeenNthCalledWith(1, {
    id: "voucher-1-0-0-0",
    row: 2,
    field: null,
    target_field: "TK Nợ",
  });
  expect(onEvidenceNavigate).toHaveBeenNthCalledWith(2, {
    id: "voucher-1-0-1-0",
    row: 4,
    field: null,
    target_field: "TK Có",
  });
  expect(onEvidenceNavigate).toHaveBeenNthCalledWith(3, {
    id: "voucher-1-0-1-1",
    row: 5,
    field: null,
    target_field: "TK Có",
  });
});
