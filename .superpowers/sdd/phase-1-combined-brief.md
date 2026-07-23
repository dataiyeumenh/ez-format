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

### Task 1: Field dictionary and explanation schemas

**Files:**
- Create: `converter/app/student_models.py`
- Create: `converter/app/student_field_dictionary.py`
- Test: `converter/tests/test_student_explanations.py`

**Interfaces:**
- `StudentEvidence`, `StudentExplanation`, `StudentFileSummary` Pydantic models.
- `field_definition(template_id, header)` returns meaning, aliases, required source, mistakes, fix hint and source metadata.

- [ ] Write failing coverage test that iterates all headers from all seven templates and requires a dictionary entry; every `(*)` header must have meaning and source.
- [ ] Implement exact definitions for accounting-critical fields and safe generated fallback definitions for optional template fields.
- [ ] Run `python -m pytest tests/test_student_explanations.py -q`.


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

### Task 3: Student explanation workspace UI

**Files:**
- Create: `frontend/src/hooks/useStudentAssistantApi.js`
- Create: `frontend/src/pages/StudentAssistantPage.jsx`
- Create: `frontend/src/components/student/StudentSessionSummary.jsx`
- Create: `frontend/src/components/student/ExplanationInspector.jsx`
- Create: `frontend/src/components/student/StudentMappingTable.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/Navbar.jsx`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

**Interfaces:**
- `/student` is authenticated and feature-flagged.
- Selected mapping/field/issue opens the same inspector contract.

- [ ] Add failing utility tests for summary labels, evidence labels and stale state invalidation.
- [ ] Implement Node session creation then direct signed upload to FastAPI.
- [ ] Implement responsive three-column desktop layout and mobile inspector bottom sheet with accessible buttons/dialog semantics.
- [ ] Add empty, loading, expired, permission and converter-offline states.
- [ ] Run `npm test`, `npm run lint`, `npm run build` in `frontend/`.
