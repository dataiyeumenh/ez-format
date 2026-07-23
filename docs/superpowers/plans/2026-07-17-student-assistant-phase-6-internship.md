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

### Task 1: Activity persistence and report policy

**Files:**
- Create: `backend/models/StudentActivity.js`
- Modify: `backend/controllers/studentSessionController.js`
- Modify: `backend/routes/student.js`
- Modify: `backend/routes/internal.js`
- Test: `backend/tests/studentActivities.test.js`

**Interfaces:**
- Activity event fields: session, eventType, skill, summaryVi, evidenceCount, containsRawValues, createdAt.
- `GET /api/student/sessions/:id/activity` and `DELETE /api/student/sessions/:id/activity` are owner scoped.

- [ ] Write failing tests proving raw rows/values are rejected and cross-user reads/deletes fail.
- [ ] Implement allowlisted event types and sanitized summaries.
- [ ] Run backend tests.

### Task 2: Workbook anonymization and confidential scanner

**Files:**
- Modify: `converter/app/student_anonymization.py`
- Modify: `converter/app/student_workflow.py`
- Modify: `converter/app/main.py`
- Test: `converter/tests/test_student_anonymization.py`
- Test: `converter/tests/test_student_api.py`

**Interfaces:**
- `POST /api/v1/student/sessions/{session_id}/anonymization/preview`.
- `POST /api/v1/student/sessions/{session_id}/anonymization/export` returns a new workbook.
- Optional `full_document_numbers=true` controls document-number replacement.

- [ ] Write failing `.xlsx` and `.xls` tests for all sensitive categories, relational consistency and original-file immutability.
- [ ] Implement format-preserving copy/edit where supported and explicit warning when unsupported structures are flattened.
- [ ] Scan workbook output and refuse export if original confidential tokens remain in targeted fields.
- [ ] Run anonymization tests.

### Task 3: Internship summary export

**Files:**
- Create: `converter/app/student_reports.py`
- Modify: `converter/app/main.py`
- Test: `converter/tests/test_student_reports.py`

**Interfaces:**
- `POST /api/v1/student/sessions/{session_id}/internship-report` accepts approved notes and returns UTF-8 Markdown.

- [ ] Write failing tests for invented activity rejection, unsafe notes and confidential values.
- [ ] Generate sections for file metadata, verified actions, resolved issues, skills and handoff checklist.
- [ ] Require the activity IDs to exist in signed session metadata before inclusion.
- [ ] Run report tests.

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
