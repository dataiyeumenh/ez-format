# Final Re-review 3: XLS Structure Closure

Date: 2026-07-17  
Scope: the single remaining `.xls` workbook-structure finding from `final-rereview-2-report.md`; the other six previously reviewed findings were not reopened.  
Method: reviewed `final-rereview-2-report.md`, `final-xls-structure-fix-report.md`, the four requested current implementation/test files, and ran only four focused `.xls`/`.xlsx` regression tests. No implementation files were edited and no full suite was rerun.

## Findings

No Critical or Important findings remain.

## Verification

- **Warning-only `.xls` formula capability:** `converter/app/document_structure.py:142` marks formula detection unavailable and `converter/app/document_structure.py:155` requests `formula_detection_unavailable`; the warning is emitted at `converter/app/document_structure.py:169`. Student readiness maps it to severity `warning`, not blocker, at `converter/app/student_workflow.py:998`. Regression coverage asserts the inspector and API behavior at `converter/tests/test_document_structure.py:39` and `converter/tests/test_student_api.py:361`.
- **Correct hidden coordinates and evidence:** `.xls` row indexes become 1-based at `converter/app/document_structure.py:115`, and column indexes become Excel letters at `converter/app/document_structure.py:120`. The actual `.xls` fixture hides the second row and column A at `converter/tests/test_student_api.py:169`; the student API regression asserts evidence row `2`, column `A`, and matching source references at `converter/tests/test_student_api.py:388`.
- **Readiness and explanations surface the warning:** workbook structure is merged into readiness at `converter/app/student_workflow.py:880`; the capability and hidden issues are created at `converter/app/student_workflow.py:998` and `converter/app/student_workflow.py:1022`, then appended as warnings at `converter/app/student_workflow.py:1082`. The API regression confirms both issue codes are warning-only and both reach explanations at `converter/tests/test_student_api.py:377` and `converter/tests/test_student_api.py:402`.
- **`.xlsx` behavior remains intact:** the `.xlsx` inspector still detects formulas, hidden rows/columns, and merged cells at `converter/app/document_structure.py:45`, with formula detection explicitly available at `converter/app/document_structure.py:89`. Existing structure and student API regressions remain unchanged in intent at `converter/tests/test_document_structure.py:13` and `converter/tests/test_student_api.py:339`.

## Focused Evidence

Command:

```bash
PYTHONPATH=converter uv run --with-requirements converter/requirements.txt pytest \
  converter/tests/test_document_structure.py::test_xlsx_structure_reports_hidden_formula_and_merged_cells \
  converter/tests/test_document_structure.py::test_xls_structure_warns_when_formula_detection_is_unavailable_and_normalizes_hidden_cells \
  converter/tests/test_student_api.py::test_student_analyze_surfaces_formula_and_hidden_row_warnings \
  converter/tests/test_student_api.py::test_student_analyze_surfaces_xls_formula_capability_warning_and_normalized_hidden_evidence -q
```

Result: `4 passed, 7 warnings in 3.40s`. The warnings were the reported FastAPI TestClient deprecation and pytest temporary-directory cleanup warnings; no focused test failed.

## Seven-finding Gate

`final-rereview-2-report.md` found the other six Important findings fixed and identified this `.xls` structure gap as the only remaining Important issue. The current implementation and focused regressions close that gap without changing the reviewed `.xlsx` warning behavior. No Critical or Important finding remains across the original seven-finding set.

## Verdict

**PASS.** The prior NO-GO condition is resolved.
