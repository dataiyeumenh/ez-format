import assert from "node:assert/strict";
import test from "node:test";

import { MISA_IMPORT_GUIDE } from "../content/misaImportGuide.js";
import {
  getRepairRefreshId,
  getRetryGate,
  mergeImportRepairWorkspacePage,
} from "./importRepairUx.js";

test("unknown document status disables retry", () => {
  const gate = getRetryGate({
    summary: { unknownDocumentGroups: 1, unresolvedIssues: 0 },
    readiness: { fatal: 0, blocker: 0, warning: 0 },
    warningsAcknowledged: false,
  });

  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /chưa xác nhận/i);
});

test("mixed imported and failed document groups are complete for retry", () => {
  const gate = getRetryGate({
    summary: {
      unknownDocumentGroups: 0,
      failedDocumentGroups: 1,
      unresolvedIssues: 0,
      unmatchedIssues: 0,
      ambiguousIssues: 0,
    },
    readiness: { fatal: 0, blocker: 0, warning: 0 },
    readinessHash: "a".repeat(64),
    readinessVersion: 8,
    sessionVersion: 8,
  });

  assert.equal(gate.enabled, true);
});

test("all imported document groups have nothing to retry", () => {
  const gate = getRetryGate({
    summary: {
      unknownDocumentGroups: 0,
      failedDocumentGroups: 0,
      unresolvedIssues: 0,
      unmatchedIssues: 0,
      ambiguousIssues: 0,
    },
    readiness: { fatal: 0, blocker: 0, warning: 0 },
    readinessHash: "a".repeat(64),
    readinessVersion: 8,
    sessionVersion: 8,
  });

  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /không có.*thất bại/i);
});

test("first-time guide contains complete MISA handoff", () => {
  assert.deepEqual(MISA_IMPORT_GUIDE.map((step) => step.id), [
    "choose-document-type",
    "upload-raw",
    "review-mapping",
    "validate",
    "download-misa",
    "import-in-misa",
    "download-error-file",
    "upload-error-file",
    "confirm-and-retry",
  ]);
});

test("readiness blockers and unacknowledged warnings disable retry", () => {
  const blocked = getRetryGate({
    summary: { unknownDocumentGroups: 0, unresolvedIssues: 0 },
    readiness: { fatal: 0, blocker: 1, warning: 0 },
    warningsAcknowledged: false,
  });
  const warnings = getRetryGate({
    summary: { unknownDocumentGroups: 0, unresolvedIssues: 0 },
    readiness: { fatal: 0, blocker: 0, warning: 1 },
    warningsAcknowledged: false,
  });

  assert.match(blocked.reason, /blocker/i);
  assert.match(warnings.reason, /xác nhận cảnh báo/i);
});

test("retry requires readiness bound to the current repair version", () => {
  const missing = getRetryGate({
    summary: { unknownDocumentGroups: 0, unresolvedIssues: 0 },
    readiness: { fatal: 0, blocker: 0, warning: 0 },
    readinessHash: "",
    readinessVersion: 8,
    sessionVersion: 8,
  });
  const stale = getRetryGate({
    summary: { unknownDocumentGroups: 0, unresolvedIssues: 0 },
    readiness: { fatal: 0, blocker: 0, warning: 0 },
    readinessHash: "a".repeat(64),
    readinessVersion: 7,
    sessionVersion: 8,
  });

  assert.equal(missing.enabled, false);
  assert.equal(stale.enabled, false);
  assert.match(stale.reason, /phiên kiểm tra/i);
});

test("workspace page merge preserves 51 issues and 101 document groups", () => {
  const first = {
    repairId: "repair-1",
    version: 8,
    issues: Array.from({ length: 50 }, (_, index) => ({ _id: `issue-${index + 1}` })),
    documentGroupStatuses: Array.from(
      { length: 100 },
      (_, index) => ({ documentGroupId: `group-${index + 1}` }),
    ),
    nextCursor: "issue-cursor",
    nextGroupCursor: "group-cursor",
  };
  const second = {
    repairId: "repair-1",
    version: 8,
    issues: [{ _id: "issue-51" }],
    documentGroupStatuses: [{ documentGroupId: "group-101" }],
    nextCursor: null,
    nextGroupCursor: null,
    readiness: { version: 8, hash: "a".repeat(64), summary: { warning: 0 } },
  };

  const merged = mergeImportRepairWorkspacePage(
    mergeImportRepairWorkspacePage(null, first),
    second,
  );

  assert.equal(merged.issues.length, 51);
  assert.equal(merged.documentGroupStatuses.length, 101);
  assert.equal(merged.readiness.hash, "a".repeat(64));
});

test("workspace page merge resets stale pages and replaces records by stable ID", () => {
  const current = {
    repairId: "repair-1",
    version: 8,
    issues: [{ _id: "issue-1", technicalMessage: "old" }],
    documentGroupStatuses: [{ documentGroupId: "group-1", status: "unknown" }],
  };
  const sameVersion = mergeImportRepairWorkspacePage(current, {
    repairId: "repair-1",
    version: 8,
    issues: [{ _id: "issue-1", technicalMessage: "new" }],
    documentGroupStatuses: [{ documentGroupId: "group-1", status: "failed" }],
  });
  const nextVersion = mergeImportRepairWorkspacePage(sameVersion, {
    repairId: "repair-1",
    version: 9,
    issues: [{ _id: "issue-2" }],
    documentGroupStatuses: [{ documentGroupId: "group-2" }],
  });

  assert.equal(sameVersion.issues.length, 1);
  assert.equal(sameVersion.issues[0].technicalMessage, "new");
  assert.equal(sameVersion.documentGroupStatuses[0].status, "failed");
  assert.deepEqual(nextVersion.issues.map((issue) => issue._id), ["issue-2"]);
  assert.deepEqual(
    nextVersion.documentGroupStatuses.map((group) => group.documentGroupId),
    ["group-2"],
  );
});

test("auto-resume stale reload keeps the persisted repair ID when no repair is loaded", () => {
  const requested = [];
  const reload = (id) => requested.push(id);

  reload(getRepairRefreshId("repair-saved-409", null));

  assert.deepEqual(requested, ["repair-saved-409"]);
});
