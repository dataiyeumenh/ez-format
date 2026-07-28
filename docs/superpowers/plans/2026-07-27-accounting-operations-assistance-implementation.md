# Accounting Operations Assistance Implementation Plan

**Date:** 2026-07-27  
**Design:** `docs/superpowers/specs/2026-07-26-accounting-operations-assistance-design.md`  
**Branch:** `Experimental`  
**Method:** TDD, feature-flagged increments, deterministic-first, independent accounting QA gate

## Constraints

- Preserve the existing staged Student Assistant and Smart Voucher work.
- Do not reparse workbooks after session creation.
- Do not put AI in analyze, preview, validation or export critical paths.
- Do not mutate raw workbook data.
- Every mutation uses revision + state hash and is auditable/undoable.
- Keep each feature disabled until its tests and production gate pass.

## Task 0 - Baseline and contracts

Files:

- Create `converter/app/operation_models.py`
- Create `converter/app/operation_store.py`
- Create `converter/tests/test_operation_store.py`
- Create `backend/services/runtimeCapabilitiesService.js`
- Modify `backend/server.js`
- Modify `backend/.env.example`
- Modify `converter/.env.example`

Steps:

- [x] Add feature flags and runtime-capability contract.
- [x] Add normalized session, revision, issue, evidence and reconciliation models.
- [x] Add immutable raw/session store with CAS state hash and TTL.
- [x] Test revision creation, stale writes, undo and raw hash immutability.
- [x] Run focused backend/converter tests.

## Task 1 - Mapping Profile V2

Files:

- Create `backend/models/MappingProfileV2.js`
- Create `backend/services/mappingProfileV2Service.js`
- Create `backend/controllers/mappingProfileV2Controller.js`
- Create `backend/routes/mappingProfilesV2.js`
- Create `backend/tests/mappingProfileV2.test.js`
- Create `converter/app/mapping_profile_v2.py`
- Create `converter/tests/test_mapping_profile_v2.py`
- Modify `backend/server.js`
- Modify `converter/app/misa_workflow.py`

Steps:

- [x] Implement V2 identity, immutable versions and lifecycle.
- [x] Implement exact/compatible/review/rejected matching.
- [x] Enforce owner isolation, risk flags and optimistic activation.
- [x] Dual-read safely; keep V1 fallback behind flags.
- [x] Stop usage/confidence updates during analyze.
- [x] Record confirmation only after successful confirmed export.
- [x] Test migration-compatible behavior and cross-workspace denial.

## Task 2 - Parse-once conversion sessions

Files:

- Modify `converter/app/misa_workflow.py`
- Modify `converter/app/main.py`
- Create `converter/tests/test_operation_session_api.py`

Steps:

- [x] Create normalized session during analyze.
- [x] Bind preview/readiness/export to active revision.
- [x] Reject stale state with 409.
- [x] Revalidate latest revision before export.
- [x] Assert preview/readiness/export do not reparse the workbook.

## Task 3 - ValidationIssue V2 and anomaly registry

Files:

- Create `converter/app/anomaly_rules.py`
- Create `converter/app/anomaly_workflow.py`
- Create `converter/tests/test_anomaly_workflow.py`
- Modify `converter/app/models.py`
- Modify `converter/app/main.py`

Steps:

- [x] Separate severity from blocking scope.
- [x] Adapt deterministic readiness issues.
- [x] Add robust, minimum-sample statistical rules.
- [x] Bind anomaly results/reviews to revision and evidence.
- [x] Prove statistical anomalies never block export.

## Task 4 - Bulk correction

Files:

- Create `converter/app/correction_workflow.py`
- Create `converter/tests/test_correction_workflow.py`
- Modify `converter/app/main.py`

Steps:

- [x] Implement safe-operation allowlist and forbidden fields.
- [x] Implement propose, simulate, atomic apply and undo.
- [x] Return exact before/after diff and control-total deltas.
- [x] Add idempotency and stale revision rejection.
- [x] Revalidate and redetect anomalies after revision activation.

## Task 5 - Optional multi-source reconciliation

Files:

- Create `converter/app/reconciliation_workflow_v2.py`
- Create `converter/tests/test_reconciliation_workflow_v2.py`
- Modify `converter/app/main.py`

Steps:

- [x] Upload at most two optional comparison files.
- [x] Implement strong-key hash matching and bounded candidates.
- [x] Implement `not_run|partial|complete|insufficient_evidence|conflict`.
- [x] Require user confirmation for fuzzy/candidate matches.
- [x] Keep optional failures isolated from the primary session.

## Task 6 - Source-backed Q&A and Local AI boundary

Files:

- Create `converter/app/evidence_packets.py`
- Create `converter/app/accounting_assistant.py`
- Create `converter/tests/test_accounting_assistant.py`
- Modify `converter/app/misa_workflow.py`
- Modify `converter/app/reconstruction_workflow.py`
- Modify `converter/app/ai_reconstruction_client.py`
- Modify `backend/models/StudentQuestionEvent.js`

Steps:

- [x] Seal evidence by owner/session/revision/state hash.
- [x] Validate citations and calculation operands.
- [x] Remove automatic AI calls from critical conversion flows.
- [x] Route optional inference through Local AI Gateway only.
- [x] Redact before outbound HTTP.
- [x] Store privacy-safe question metadata instead of full prompts.
- [x] Test offline, timeout, malformed JSON, prompt injection and PII canaries.

## Task 7 - Frontend session foundation

Files:

- Create `frontend/src/hooks/useConversionSession.js`
- Create `frontend/src/utils/operationSession.js`
- Create `frontend/src/utils/operationSession.test.mjs`
- Modify `frontend/src/hooks/useConverterApi.js`
- Modify `frontend/src/pages/ConvertPage.jsx`

Steps:

- [x] Add runtime capabilities, session ID, revision and state hash.
- [x] Move mutation state from page-local ad hoc fields into reducer/hook.
- [x] Preserve current mapping/preview/download behavior.
- [x] Add stale, expired, permission and optional-offline states.

## Task 8 - Frontend feature surfaces

Files:

- Create `frontend/src/components/converter/MappingProfileV2Card.jsx`
- Create `frontend/src/components/converter/AnomalyWorkspace.jsx`
- Create `frontend/src/components/converter/BulkCorrectionDialog.jsx`
- Create `frontend/src/components/converter/ReconciliationWorkspace.jsx`
- Create `frontend/src/components/converter/AccountingAssistantDrawer.jsx`
- Modify `frontend/src/pages/ConvertPage.jsx`
- Modify `frontend/src/components/ui/StepProgress.jsx`

Steps:

- [x] Add profile drift/review UI.
- [x] Add issue/anomaly grouping and evidence navigation.
- [x] Add two-stage correction selection/diff/undo UI.
- [x] Add optional comparison upload and report UI.
- [x] Add evidence-backed Q&A drawer with AI status.
- [x] Complete mobile, keyboard, focus and live-region states.

## Task 9 - Migration, rollout and evidence

Files:

- Create `backend/services/mappingProfileV2MigrationService.js`
- Create `backend/tests/mappingProfileV2Migration.test.js`
- Create `scripts/qa-accounting-operations.ps1`
- Create `docs/qa/accounting-operations-release-gate.md`

Steps:

- [x] Add dry-run/idempotent V1-to-V2 draft migration.
- [x] Quarantine invalid/high-risk legacy profiles.
- [x] Add rollback and feature-disable smoke checks.
- [x] Generate `.artifacts/qa/<release-id>/` evidence bundle.

## Task 10 - Extreme production QA/QC

Steps:

- [x] Run backend tests.
- [x] Run full converter tests.
- [x] Run frontend lint, unit tests and build.
- [x] Run `npm run qa:fast` and accounting-operations gate.
- [x] Benchmark 10k/50k fixtures.
- [x] Run desktop/mobile browser journeys.
- [x] Spawn an independent subagent with `ke-toan`; no implementation access.
- [x] Run red-team and privacy-canary checks.
- [x] Require three consecutive clean mandatory runs.
- [x] Keep failing feature flags off.

## Browser QA note

Desktop/mobile public journeys passed. Full authenticated conversion journey remains a manual operator check because the local backend is connected to the configured MongoDB account store.

## Completion Criteria

- No P0/P1 findings.
- No automatic AI call in conversion critical path.
- No statistical anomaly blocks export.
- No correction applies silently or partially.
- No ambiguous reconciliation match auto-confirms.
- No invented/cross-owner evidence.
- Existing MISA real-template export remains intact.
- Independent accounting QA subagent signs `PASS`.

