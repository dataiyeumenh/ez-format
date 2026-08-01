// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import RetryBatchReview from "./RetryBatchReview.jsx";

afterEach(cleanup);

const repairWithWarning = ({ version = 3, hash = "a".repeat(64) } = {}) => ({
  repairId: "repair-warning",
  status: "ready_for_repair",
  version,
  summary: {
    unknownDocumentGroups: 0,
    failedDocumentGroups: 1,
    unresolvedIssues: 0,
    unmatchedIssues: 0,
    ambiguousIssues: 0,
  },
  documentGroupStatuses: [{ documentGroupId: "group-1", status: "failed" }],
  readiness: {
    version,
    hash,
    summary: { fatal: 0, blocker: 0, warning: 1 },
  },
  retryGate: { allowed: true, reason: "Cần xác nhận cảnh báo" },
});

for (const [change, nextRepair] of [
  ["repair version", repairWithWarning({ version: 4 })],
  ["readiness hash", repairWithWarning({ hash: "b".repeat(64) })],
]) {
  test(`warning acknowledgement resets when ${change} changes`, async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RetryBatchReview
        repair={repairWithWarning()}
        busy={false}
        onCreate={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    const acknowledgement = screen.getByRole("checkbox");
    const createButton = screen.getByRole("button", { name: "Tạo file xuất lại" });

    await user.click(acknowledgement);
    expect(acknowledgement.checked).toBe(true);
    expect(createButton.disabled).toBe(false);

    rerender(
      <RetryBatchReview
        repair={nextRepair}
        busy={false}
        onCreate={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox").checked).toBe(false);
    expect(screen.getByRole("button", { name: "Tạo file xuất lại" }).disabled).toBe(true);
  });
}
