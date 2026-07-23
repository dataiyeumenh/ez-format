# Phase 0 Task 1 Report

## RED

Command initially requested:

```bash
node --test backend/tests/studentSessions.test.js
```

Output:

```text
/bin/bash: line 1: node: command not found
```

The available Node executable in this WSL shell is `node.exe`, so the RED test was run with the equivalent command:

```bash
node.exe --test backend/tests/studentSessions.test.js
```

Output (abridged only for Windows paths):

```text
TAP version 13
Error: Cannot find module '../services/studentSessionService'
...
not ok 1 - ...backend\\tests\\studentSessions.test.js
# tests 1
# pass 0
# fail 1
```

This is the expected failure: the new owner-scope service did not exist.

## GREEN

Command:

```bash
node.exe --test backend/tests/studentSessions.test.js
```

Output:

```text
TAP version 13
ok 1 - owner scope uses the selected workspace or falls back to the user
ok 2 - owner scope rejects requests without a user or workspace
ok 3 - student context contains its owner and allowed scopes
ok 4 - student context rejects a token with another purpose
ok 5 - student context rejects missing required scopes
ok 6 - student context rejects expired tokens
1..6
# tests 6
# pass 6
# fail 0
# duration_ms 88.4432
```

Additional focused validation:

```bash
node.exe --check backend/services/conversionContextService.js
node.exe --check backend/services/studentSessionService.js
git diff --check -- backend/services/conversionContextService.js backend/services/studentSessionService.js backend/tests/studentSessions.test.js
```

All three commands exited successfully.

## Files Changed

- `backend/services/conversionContextService.js`: added signed student-context creation and verification with purpose and required-scope enforcement.
- `backend/services/studentSessionService.js`: added canonical workspace-first/user-fallback owner-scope construction and missing-owner rejection.
- `backend/tests/studentSessions.test.js`: added six `node:test` contract tests.
- `.superpowers/sdd/phase-0-task-1-report.md`: this required implementation report.

## Self-Review

- Workspace scope takes precedence when selected; otherwise the normalized user scope is used.
- Token verification relies on `jsonwebtoken` signature and expiration checks before checking purpose and required scope.
- The default student token lifetime is 10 minutes, within the Phase 0 maximum temporary-retention limit.
- No existing converter behavior, routes, models, or later-phase files were changed.
- No files were staged or committed.

## Concerns

- In this shell, `node` is not on `PATH`; validation used the available `node.exe` executable. CI should continue to use the repository's normal `node` command.
- This task deliberately does not add controller-side ownership matching, session persistence, or FastAPI verification; those are later Phase 0 tasks.

## Reviewer Fix: Lifetime And Scope Enforcement

### RED

Command:

```bash
node.exe --test backend/tests/studentSessions.test.js
```

Output:

```text
not ok 6 - student context requires an explicit required scope during verification
error: 'Missing expected exception.'
not ok 8 - student context rejects lifetimes longer than 24 hours
error: 'Missing expected exception.'
not ok 9 - student context rejects unsupported lifetime formats
error: 'Missing expected exception.'
# tests 10
# pass 7
# fail 3
```

The failures prove that verification could bypass the required scope and that lifetime values were forwarded to JWT without Task 1 validation.

### GREEN

Command:

```bash
node.exe --test backend/tests/studentSessions.test.js
```

Output:

```text
ok 1 - owner scope uses the selected workspace or falls back to the user
ok 2 - owner scope rejects requests without a user or workspace
ok 3 - student context contains its owner and allowed scopes
ok 4 - student context rejects a token with another purpose
ok 5 - student context rejects missing required scopes
ok 6 - student context requires an explicit required scope during verification
ok 7 - student context accepts a 24-hour lifetime
ok 8 - student context rejects lifetimes longer than 24 hours
ok 9 - student context rejects unsupported lifetime formats
ok 10 - student context rejects expired tokens
1..10
# tests 10
# pass 10
# fail 0
# duration_ms 93.3905
```

Focused checks:

```bash
node.exe --check backend/services/conversionContextService.js
node.exe --check backend/services/studentSessionService.js
git diff --check -- backend/services/conversionContextService.js backend/services/studentSessionService.js backend/tests/studentSessions.test.js
```

All focused checks exited successfully with no output.

### Changes

- `createStudentContextToken` now accepts only integer seconds or `s`, `m`, `h`, and `d` lifetime strings, rejects unknown formats, and rejects absolute durations over 24 hours.
- `verifyStudentContextToken` now rejects a missing or whitespace-only `requiredScope` before verifying token claims.
- Added coverage for `24h`, `48h`, `2d`, an unsupported format, and omitted/blank required scopes.
