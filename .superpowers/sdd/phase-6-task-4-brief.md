# Student Assistant Phase 6 Internship Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce privacy-safe anonymized workbooks, verified activity timelines, skill summaries and user-triggered internship handoff reports.

**Architecture:** FastAPI anonymizes a copy of the active workbook using session-stable pseudonyms and scans output before returning it. Node persists sanitized activity metadata. Reports contain verified actions plus user-approved notes only.

**Tech Stack:** Python, openpyxl, xlrd/xlutils/xlwt, Node/Mongoose, React.

## Global Constraints

- Original workbooks are never overwritten.
- No report is generated or published without explicit user action.
- Complete internship reports/theses are out of scope.
- Raw confidential values are excluded by default and must pass a scanner before export.

---

### Task 4: Internship UI and final program QA

**Files:**
- Create: `frontend/src/components/student/InternshipAssistantPanel.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Modify: `scripts/qa-qc.ps1`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

- [ ] Add tests for anonymization acknowledgement, activity filters and explicit report generation.
- [ ] Implement anonymization preview/export, timeline, checklist, skill summary and report download.
- [ ] Wire student backend/converter/frontend focused tests into workspace QA without weakening existing gates.
- [ ] Run full converter tests, backend node tests, frontend test/lint/build and `npm run qa:fast`.
- [ ] Browser QA desktop/mobile with one sales file, one purchase file, AI disabled and all feature flags enabled.
