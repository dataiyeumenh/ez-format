Task 0: complete (worktree `codex/main-experimental-production-integration` from `8d1a934`, source workspace untouched)
Task 1: complete (commits `8d1a934..fae0c25`, review clean)
Task 2: complete (commits `724c114..676930e`, review clean after two fixes)
Task 3: complete (commits `f52c96f..cda61b6`, review clean; strict replica release gate implemented, local replica URI still required for release evidence)
Task 4: complete (commits `f6bbcef..d5ee360`, review clean; MongoDB/GridFS only, live GridFS staging evidence pending)
Task 5: complete (commits `81e1f71..f0fa29f`, review clean; Student Assistant privacy/capability gates enforced)
Task 6: complete (commits `1ab7108..9cddc6b`, review clean; canonical Smart Voucher contract)
Task 7: complete (commits `712b932..f2ba0d0`, review clean; Mapping Profile V2/accounting operations deterministic and reversible)
Task 3: complete (zero-total creation and settlement are atomic; focused payment tests 30 pass/8 replica skipped; `qa:main-contracts` 64 backend pass/8 replica skipped plus 2 frontend pass; `PAYMENT_REPLICA_SET_TEST_URI` absent, so real replica coverage was not executed)
Task 5: privacy blockers resolved (single analyzed-sheet anonymized export; scanner re-checks all exported cells; StudentQuestionEvent purge bounded, idempotent, feature-flag independent, and startup-safe). Focused tests: converter 70 passed; backend 16 passed.
Task 5: final anonymization blocker resolved (analysis signature passes exact sheet/header context; export no longer uses `workbook.active`; missing or changed context fails closed; active confidential cover-sheet regression passes). Focused converter privacy tests: 71 passed, 1 existing FastAPI deprecation warning.
Task 8: complete (commits `e1ae422..54eb1c9`, final re-review clean; GridFS contract, invoice-symbol grouping, partial-import readiness, complete retry groups and failed-stream audit fixed; shared FastAPI route registration intentionally deferred to Task 9).
Task 9: complete (commits `88c26b4..ab0c38f`, final re-review clean; shared Node/FastAPI/React routes composed, production handshake/idempotency/traversal/startup gates fixed, Student attempt persistence made transactional and retention-safe; real replica execution remains release-gated).
Task 10: complete (commits `feb1af5..c1669ea`, final re-review clean; migrations default off, explicit allowlisted index contracts, preflight-first apply, structured partial-failure rollback reporting, no broad `syncIndexes`).
Task 11: complete (commits `582cb17..e8632a0`, final re-review clean; latest `origin/main` reconciled via merge `bff29ca`, rollback ref pushed, full local QA passes with explicit `INCOMPLETE/RELEASE_BLOCKED` status for missing live/replica evidence, reproducible tracked evidence binding).
Task 12: complete (commit `e05764b`, final re-review clean; Render/Vercel/Mongo release and rollback runbooks added, flags-off order and MongoDB/GridFS boundaries documented; live staging blocked by missing credentials/URLs/backup evidence).
Task 13: code/docs complete (commits `41009e6..3275111`, final re-review clean; progressive enablement, exact-SHA promotion, rollback drill and literal `RELEASE_READY` gate aligned). Live enablement/promotion remains blocked by missing staging credentials/URLs, backup record, replica MongoDB and GridFS evidence.
