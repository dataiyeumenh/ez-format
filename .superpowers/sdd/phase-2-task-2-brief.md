# Student Assistant Phase 2 Ask About This File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer bounded questions about the active workbook using deterministic queries and inspectable evidence.

**Architecture:** A deterministic intent router executes file queries first. Optional AI can rephrase only selected evidence; citation validation rejects invented rows, fields or values.

**Tech Stack:** Python, FastAPI, Pydantic, Decimal, React.

## Global Constraints

- Requires Phase 1 overview/explanation state.
- No evidence means no file-specific answer.
- Questions never escape the signed session and owner scope.

---

### Task 2: API and privacy-safe question events

**Files:**
- Create: `backend/models/StudentQuestionEvent.js`
- Modify: `backend/controllers/studentSessionController.js`
- Modify: `backend/routes/internal.js`
- Modify: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Test: `backend/tests/studentQuestions.test.js`
- Test: `converter/tests/test_student_api.py`

**Interfaces:**
- `POST /api/v1/student/sessions/{session_id}/questions` with `X-Student-Context`.
- Node stores question text, answer type, evidence identifiers/count and outcome; it does not store full raw rows.

- [ ] Write failing cross-session and sanitized-event tests.
- [ ] Add FastAPI endpoint and optional internal event notification.
- [ ] Validate all returned evidence against active table headers and row range.
- [ ] Run focused backend and converter tests.
