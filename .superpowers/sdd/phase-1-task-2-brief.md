# Student Assistant Phase 1 Explain My File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, evidence-backed explanation workspace for an analyzed sales or purchase workbook.

**Architecture:** FastAPI reuses the existing analyze/mapping/readiness pipeline and emits a stable explanation contract. React renders one student workspace with summary, mapping/preview and an inspector; AI is optional phrasing only.

**Tech Stack:** FastAPI, Pydantic, existing MISA template registry, React, Tailwind.

## Global Constraints

- Requires Phase 0 signed context and owner-bound upload state.
- Template IDs must match repository IDs exactly.
- Every explanation must contain source evidence or a rule source; otherwise return `unsupported`.

---

### Task 2: Explanation engine and API

**Files:**
- Create: `converter/app/student_explanations.py`
- Create: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Test: `converter/tests/test_student_explanations.py`
- Test: `converter/tests/test_student_api.py`

**Interfaces:**
- `POST /api/v1/student/sessions/analyze` multipart fields: `file`, `context_token`, optional `target_template_id`.
- `GET /api/v1/student/sessions/{session_id}/overview` header `X-Student-Context`.
- Response contains existing analyze payload plus `student_summary` and `explanations`.

- [ ] Write failing API tests for authentication, owner binding, summary counts, mapping/default/formula explanations and stale explanation invalidation.
- [ ] Build summary from detected metadata, mapping suggestion, readiness and master-data state.
- [ ] Emit stable explanation IDs based on session/upload/field/rule identity.
- [ ] Run focused API tests plus existing `test_api.py`.
