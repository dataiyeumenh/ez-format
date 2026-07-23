# Student Assistant Phase 3 Check My Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate student mapping/data/classification work deterministically, reveal progressive hints and store reproducible skill evidence.

**Architecture:** FastAPI owns expected state, scoring and hint boundaries. MongoDB stores immutable attempt revisions and aggregate progress; the browser never receives future hint content before reveal.

**Tech Stack:** FastAPI, Decimal, Node/Express, MongoDB, React.

## Global Constraints

- AI cannot mark an answer correct or alter a score.
- Same input, rubric version and state must produce the same score.
- Expected state remains server-side until hint level permits disclosure.

---

### Task 2: Attempt/progress persistence and APIs

**Files:**
- Create: `backend/models/StudentAttempt.js`
- Create: `backend/models/StudentSkillProgress.js`
- Modify: `backend/controllers/studentSessionController.js`
- Modify: `backend/routes/student.js`
- Modify: `backend/routes/internal.js`
- Modify: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Test: `backend/tests/studentAttempts.test.js`
- Test: `converter/tests/test_student_api.py`

**Interfaces:**
- `POST /api/v1/student/sessions/{session_id}/attempts` evaluates.
- `POST /api/v1/student/sessions/{session_id}/attempts/{attempt_id}/hints/{level}` reveals one allowed level.
- Node stores immutable revision, state hash, score, summary and highest hint level.

- [ ] Write failing ownership, revision and progress tests.
- [ ] Add evaluation endpoints and signed internal persistence events.
- [ ] Update progress only after completed deterministic evaluation.
- [ ] Run focused tests.
