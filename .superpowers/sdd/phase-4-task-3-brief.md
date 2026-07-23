# Student Assistant Phase 4 Voucher And Accounting Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect source rows to canonical voucher groups, supported business events, reviewable debit/credit suggestions and MISA output rows.

**Architecture:** The accounting map reuses preview rows, canonical grouping and field provenance. Accounts are read only from submitted data, confirmed profile/workspace context or explicit template defaults; unknown choices stay unresolved.

**Tech Stack:** Python, Decimal, existing voucher reconstruction/provenance modules, React.

## Global Constraints

- Account choice is `suggested` unless deterministically configured.
- Every entry contains evidence and source status.
- An unbalanced exercise map is a blocker for the exercise only; it does not silently alter MISA readiness.

---

### Task 3: Accounting-map UI

**Files:**
- Create: `frontend/src/components/student/AccountingMapPanel.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

- [ ] Add tests for suggested/needs-review/unresolved labels and debit-credit totals.
- [ ] Implement source → voucher → event → entries → MISA visual chain with keyboard navigation.
- [ ] Link evidence back to the active row/field inspector.
- [ ] Run frontend test/lint/build.
