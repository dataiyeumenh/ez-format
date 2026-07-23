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

### Task 3: Check-my-work UI

**Files:**
- Create: `frontend/src/components/student/CheckWorkPanel.jsx`
- Create: `frontend/src/components/student/SkillProgressCard.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

- [ ] Add tests for score bands, hint lock state and revision labels.
- [ ] Implement attempt submission from current mapping/edited rows, result breakdown and explicit hint reveal controls.
- [ ] Never preload hidden hints into browser state.
- [ ] Run frontend test/lint/build.
