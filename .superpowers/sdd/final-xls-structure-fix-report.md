# Final XLS Structure Fix

Date: 2026-07-17
Scope: `converter/app/document_structure.py`, `converter/app/student_workflow.py`,
`converter/tests/test_document_structure.py`, and `converter/tests/test_student_api.py`.

## Behavior

- `.xls` now reports `formula_detection: "unavailable"` and emits the warning-only
  `formula_detection_unavailable` capability warning. It never reports this condition as a blocker.
- `.xls` hidden-row evidence uses 1-based worksheet rows and hidden-column evidence uses Excel
  letters. The regression fixture's hidden second row and column A are reported as `2` and `A`.
- Student analysis includes the capability warning in readiness and the normal readiness-to-
  explanation flow. Its hidden-structure evidence preserves the normalized `Data!row:2` and
  `Data!column:A` references.
- `.xlsx` remains formula-detection capable and its existing formula, hidden-cell, and merged-cell
  regression remains green.

## RED

Command:

```bash
PYTHONPATH=converter uv run --with-requirements converter/requirements.txt pytest \
  converter/tests/test_document_structure.py converter/tests/test_student_api.py -q
```

Result before production edits: `2 failed, 42 passed`. Both new actual-`.xls` fixture tests failed
with `KeyError: 'formula_detection'`, proving that no formula-safety capability state reached either
the inspector or student API.

## GREEN

Focused command (same selection): `44 passed, 7 warnings in 2.75s`.

Full converter command:

```bash
PYTHONPATH=converter uv run --with-requirements converter/requirements.txt pytest \
  converter/tests -q --tb=short
```

Result: `329 passed, 7 warnings in 97.36s`. The warnings are pre-existing FastAPI TestClient
deprecation and pytest temporary-directory cleanup warnings; no test failures occurred.

No files were staged or committed.
