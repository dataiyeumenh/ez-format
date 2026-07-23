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

### Task 2: Durable session metadata and feature flags

**Files:**
- Create: `backend/models/StudentFileSession.js`
- Create: `backend/controllers/studentSessionController.js`
- Create: `backend/routes/student.js`
- Modify: `backend/server.js`
- Test: `backend/tests/studentSessions.test.js`

**Interfaces:**
- `POST /api/student/sessions` creates metadata and returns `{ session, contextToken }`.
- `GET /api/student/sessions/:id` and `DELETE /api/student/sessions/:id` enforce user/workspace ownership.
- `POST /api/student/sessions/:id/context` refreshes a valid short-lived token.

- [ ] Add failing serializer and ownership tests; include a payload containing `rawRows` and assert it is discarded.
- [ ] Implement schema fields from the design with TTL index on `retentionExpiresAt` and no workbook byte field.
- [ ] Add authenticated routes behind `STUDENT_ASSISTANT_ENABLED` and expose student capabilities in `/api/health`.
- [ ] Run `node --test backend/tests/studentSessions.test.js`.

### Task 3: Production mapping-profile owner isolation

**Files:**
- Modify: `backend/models/MappingProfile.js`
- Modify: `backend/services/mappingProfileService.js`
- Modify: `backend/controllers/accountingWorkspaceController.js`
- Modify: `converter/app/mapping_profile_client.py`
- Modify: `converter/app/misa_profiles.py`
- Modify: `converter/app/misa_workflow.py`
- Test: `backend/tests/mappingProfiles.test.js`
- Test: `converter/tests/test_misa_profile_api.py`
- Test: `converter/tests/test_mapping_profile_client.py`

**Interfaces:**
- Profile key becomes `(ownerScope, targetTemplateId, sourceSignatureHash)`.
- Signed workspace context resolves to `workspace:<workspace_id>`.
- Signed student context resolves to its exact `owner_scope`.
- Local SQLite uses `LOCAL_MAPPING_OWNER_SCOPE`, default `local:default`, never `""`.

- [ ] Write failing cross-owner lookup/get/save/use tests in Node and SQLite tests in Python.
- [ ] Add `ownerScope`, optional `user`, optional `workspace`; validate that exactly the signed owner can access a profile.
- [ ] Migrate SQLite rows: workspace rows become `workspace:<id>`; empty legacy rows become `local:legacy`; add owner-scope index.
- [ ] Keep compatibility serializers but make `ownerScope` authoritative.
- [ ] Run the focused Node and Python tests.

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
