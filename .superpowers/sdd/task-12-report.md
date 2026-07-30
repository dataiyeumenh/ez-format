# Task 12 Report

## Release status

`blocked`

Release-stopping evidence: no live Render, Vercel, or Mongo credentials/URLs,
backup record, deployment permissions, or staging responses were supplied.
No deployment or staging smoke test was performed. The runbooks explicitly
keep the release blocked rather than claiming live evidence.

## Scope delivered

- `docs/deployment/main-experimental-release-runbook.md`
- `docs/deployment/main-experimental-rollback-runbook.md`
- This report

The runbooks cover the Task 12 sequence: private Mongo backup record, all
initial flags off, converter-first Render deployment, Node Render deployment,
Vercel build, health checks, main-product smoke checks, exact rollback ref and
flags, migration/data restore boundaries, and the no-object-storage contract.

## Ground-truth checks

- Plan source: Task 12 in
  `docs/superpowers/plans/2026-07-30-main-experimental-production-integration.md`.
- Current worktree parent inspected: `e8632a023ae33a17c1db58e44a21e53a6f47f99b`.
- Required rollback ref/SHA copied from the plan and migration/QA records:
  `rollback/main-pre-experimental-integration-20260730-055323` at
  `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- Environment names were checked against `.env.example`,
  `backend/.env.example`, `converter/.env.example`, and
  `frontend/.env.example`. The runbooks use the current Mongo/GridFS bucket
  example `conversion_artifacts`, not a new storage provider.
- The environment-key comparison found only intentional runtime extras:
  `ALLOW_LEGACY_ROW_EXPORT` is an explicit converter hardening value, and the
  `MAPPING_PROFILE_V2_MIGRATION_*` IDs are per-run rollback inputs rather than
  `.env.example` settings.
- Vercel instructions omit `VITE_PYTHON_API_URL` and use an HTTPS Node
  placeholder. Local development defaults are not copied into production
  examples.
- No credential, token, Mongo URI, private URL, or secret value was added.

## Validation

Executed after writing the documents:

```powershell
git diff --cached --check
rg -n "VITE_PYTHON_API_URL\\s*=|AWS_ACCESS_KEY_ID\\s*=|AWS_SECRET_ACCESS_KEY\\s*=" docs/deployment/main-experimental-release-runbook.md docs/deployment/main-experimental-rollback-runbook.md
```

Results: `git diff --cached --check` exited `0`; the forbidden-pattern scan
for local production endpoints, object-storage URLs, and secret literals
returned no matches. `scripts/verify.ps1` and
`scripts/run-outcomes-grader.ps1` are absent from this worktree, so neither
repository gate was available to run.

## Pre-existing dirty work preserved

The worktree contained unrelated modified implementation, test, and progress
files before Task 12. They remain unstaged. Only the two runbooks and this
report are in the Task 12 commit.

## Unresolved release actions

The release owner, Render owner, Vercel owner, and DBA must complete the
blocked checklists in the runbooks. Only then may live health output and smoke
evidence change the status from `blocked`.
