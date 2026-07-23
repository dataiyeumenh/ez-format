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
