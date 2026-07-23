# Student Assistant Phase 5 Reconciliation And Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach students to compare independent totals, understand deterministic deltas and distinguish mismatch from insufficient data.

**Architecture:** FastAPI reuses readiness calculations and applies declared Decimal tolerances. Each reconciliation item includes left/right components, delta, evidence, hypotheses and a fix hint.

**Tech Stack:** Python Decimal, FastAPI, React.

## Global Constraints

- Unsupported modules return `insufficient_data`.
- Possible reasons are labeled hypotheses and never replace the deterministic result.
- Existing export gate remains authoritative.

---

### Task 2: API and UI

**Files:**
- Modify: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Create: `frontend/src/components/student/ReconciliationPanel.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Test: `converter/tests/test_student_api.py`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

**Interfaces:**
- `GET /api/v1/student/sessions/{session_id}/reconciliation`.

- [ ] Write failing API and UI-state tests.
- [ ] Implement endpoint, correction invalidation and privacy-safe completion event.
- [ ] Render status, delta, components, hypotheses and fix hint without treating insufficient data as success.
- [ ] Run converter focused tests and frontend test/lint/build.
