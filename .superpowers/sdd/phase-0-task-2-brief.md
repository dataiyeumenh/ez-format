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
