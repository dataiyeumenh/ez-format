# Student Assistant Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish authenticated owner isolation, signed student sessions, feature flags, retention, privacy-safe metadata and deterministic anonymization primitives without changing the existing converter flow.

**Architecture:** Node/Express owns durable `StudentFileSession` metadata and signs short-lived contexts. FastAPI verifies those contexts and binds temporary upload state to `owner_scope`. MongoDB owns production mapping profiles; SQLite is local-only and requires a non-empty owner scope.

**Tech Stack:** Node.js, Express, Mongoose, JWT, Python, FastAPI, SQLite, pytest, node:test.

## Global Constraints

- Phase 7 is excluded.
- Existing converter behavior must remain unchanged when `STUDENT_ASSISTANT_ENABLED=false`.
- Raw workbook bytes must not be stored in MongoDB or application logs.
- New profile writes must reject empty owner scope.
- Token purpose and required scope must be checked on every student operation.
- Default temporary retention is at most 24 hours.

---

### Task 5: Anonymization primitives and rollback gate

**Files:**
- Create: `converter/app/student_anonymization.py`
- Test: `converter/tests/test_student_anonymization.py`
- Modify: `.env.example`
- Modify: `converter/.env.example`
- Modify: `frontend/.env.example`

**Interfaces:**
- `AnonymizationSession(session_id, secret)` provides stable replacements per category.
- Categories: company, counterparty, tax code, address, email, phone, bank account, optional document number.

- [ ] Write failing consistency tests: same source value maps identically, different categories do not collide, blanks stay blank, leading zeroes remain text.
- [ ] Implement deterministic HMAC-derived pseudonyms and a confidential-value scanner.
- [ ] Document all seven feature flags and retention/token environment values.
- [ ] Run anonymization tests and existing converter smoke tests with all student flags disabled.
