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

### Task 1: Owner-scope and signed-context contracts

**Files:**
- Modify: `backend/services/conversionContextService.js`
- Create: `backend/services/studentSessionService.js`
- Test: `backend/tests/studentSessions.test.js`

**Interfaces:**
- Produces `buildOwnerScope({ userId, workspaceId }): string`.
- Produces `createStudentContextToken({ sessionId, userId, ownerScope, workspaceId, snapshotSetHash, allowedScopes, expiresIn })`.
- Produces `verifyStudentContextToken(token, requiredScope)`.

- [ ] Write failing node:test cases for `user:<id>`, `workspace:<id>`, missing owner rejection, wrong purpose, missing scope and expiry.
- [ ] Run `node --test backend/tests/studentSessions.test.js`; expect failures for missing functions.
- [ ] Implement owner-scope normalization and JWT claims using `purpose=student_file_session` and `allowed_scopes`.
- [ ] Re-run the test and require all cases to pass.
