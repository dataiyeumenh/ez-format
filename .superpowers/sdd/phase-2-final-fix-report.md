# Phase 2 Final P1 Fix Report

## Scope

- Replaced reclaim-mutex `O_EXCL` plus TTL ownership with a persistent,
  non-blocking advisory lock (`msvcrt.locking` on Windows and `fcntl.flock`
  on POSIX). The heartbeat and stale reclaimer share this mutex. The mutex
  is never unlinked or recreated, and the TTL lease-steal path is removed.
- Invalidated pending source-row requests on reset and new analysis by
  incrementing the request epoch and aborting the active controller.
  Successful responses now require matching epoch, session ID, upload ID,
  and state hash before updating the panel.
- The existing source-row workflow already returns `session_id`, `upload_id`,
  and `state_hash`; no response-model change was needed.

## TDD Evidence

- Red: reclaim-mutex tests failed before the advisory-lock implementation
  because `_claim_analysis_reclaim_mutex` was absent after the initial
  implementation direction changed.
- Green: tests cover a second holder being rejected, acquisition after the
  first holder closes, and persistent mutex-file identity across acquisitions.
- Red: frontend utility test failed because
  `createStudentSourceRowRequestContext` was not exported.
- Green: the utility and page wiring reject an old response after reset or a
  new analysis context.

## Validation

- `uv run --with-requirements requirements.txt python -m pytest tests/test_student_context.py tests/test_student_api.py -q`
  - 40 passed; one existing FastAPI/httpx deprecation warning.
- `node.exe --test src/utils/studentAssistant.test.mjs`
  - 15 passed.
- `npm exec -- eslint src/pages/StudentAssistantPage.jsx src/hooks/useStudentAssistantApi.js src/utils/studentAssistant.js src/utils/studentAssistant.test.mjs`
  - passed.
- Frontend production build was attempted with a Windows temp path. It is
  blocked by pre-existing unrelated code:
  `FileQuestionPanel.jsx` imports `BotOff`, which the installed
  `lucide-react` package does not export.

## Git

- No files staged and no commit created.
