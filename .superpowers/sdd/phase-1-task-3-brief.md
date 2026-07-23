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
