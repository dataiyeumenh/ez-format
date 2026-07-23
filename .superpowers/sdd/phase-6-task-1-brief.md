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
