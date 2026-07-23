# Phase 4 Domain Report

## Scope

- Added only the pure accounting-map domain builder and its focused tests.
- Reused `VoucherReconstructionReport`, `VoucherDraft`, `VoucherField`,
  `FieldProvenance`, source-row coordinates, and `student_preview` rows.
- Did not modify API, workflow, UI, readiness, export, staging, or git history.

## TDD Evidence

- RED: `python -m pytest -q tests/test_student_accounting_map.py` failed because
  `app.student_accounting_map` did not exist.
- GREEN: `/tmp/ez-format-test-env/bin/python -m pytest -q
  tests/test_student_accounting_map.py tests/test_voucher_reconstruction.py`
  completed with `16 passed`.

## Domain Behavior

- Maps canonical stable voucher IDs to sales/purchase goods/service events.
- Groups debit and credit entries with `Decimal` amounts, preserving source,
  voucher, preview-row, target-field, and provenance evidence on every entry.
- Uses only mapped preview accounts, voucher fields with provenance, or explicit
  defaults. Missing accounts remain `unresolved`; AI-only defaults are
  `needs_review`.
- Emits a blocker when debit and credit totals are not equal and does not mutate
  MISA readiness.

## Validation Note

- Pytest emitted six cleanup warnings for temporary directories;
  all selected tests passed.
