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

### Task 3: Question UI and evidence navigation

**Files:**
- Create: `frontend/src/components/student/FileQuestionPanel.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

**Interfaces:**
- Evidence click selects the corresponding mapping/preview field in the student workspace.

- [ ] Add failing tests for supported, unsupported and AI-unavailable answer labels.
- [ ] Implement question history, suggested prompts, loading, retry and explicit unsupported states.
- [ ] Render evidence chips with row/field labels and safe values already returned by backend.
- [ ] Run frontend test/lint/build.
