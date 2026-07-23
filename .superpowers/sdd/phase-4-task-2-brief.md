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

### Task 2: API and activity event

**Files:**
- Modify: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Modify: `backend/controllers/studentSessionController.js`
- Test: `converter/tests/test_student_api.py`

**Interfaces:**
- `GET /api/v1/student/sessions/{session_id}/accounting-map`.
- Student revisions are owner-bound and generate sanitized activity metadata.

- [ ] Write failing auth, balance and evidence API tests.
- [ ] Implement endpoint and state revision invalidation.
- [ ] Run focused tests.
