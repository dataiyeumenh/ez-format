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

### Task 4: FastAPI student context and retention

**Files:**
- Create: `converter/app/student_context.py`
- Create: `converter/app/student_store.py`
- Modify: `converter/app/misa_workflow.py`
- Modify: `converter/app/main.py`
- Test: `converter/tests/test_student_context.py`

**Interfaces:**
- `verify_student_context(token, required_scope) -> StudentContextClaims`.
- `bind_upload_to_student(upload_id, claims, ttl_seconds)` stores only IDs/scope/expiry.
- `assert_upload_owner(upload_id, claims)` rejects cross-session and cross-owner access.
- `cleanup_expired_student_uploads(now=None) -> list[str]` deletes expired upload directories.

- [ ] Write failing tests for valid, expired, wrong-purpose, wrong-scope and cross-owner tokens.
- [ ] Implement HMAC/JWT verification compatible with Node `CONVERSION_CONTEXT_SECRET`.
- [ ] Persist owner/session/expiry in upload metadata and clean expired raw files.
- [ ] Add startup/request opportunistic cleanup without logging row contents.
- [ ] Run `python -m pytest tests/test_student_context.py tests/test_misa_profile_api.py -q` from `converter/`.
