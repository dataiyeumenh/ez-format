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
