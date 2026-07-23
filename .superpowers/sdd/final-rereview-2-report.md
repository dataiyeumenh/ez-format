# Final Re-review 2: Seven Important Fixes

Date: 2026-07-17  
Scope: the seven Important findings from `final-rereview-report.md`; Phase 7 excluded.  
Method: reviewed `final-seven-fixes-report.md`, current implementation/tests, parent verification evidence, and a bounded runtime probe for the remaining workbook-structure risk. No implementation files were edited.

## Findings

### Important 1 - The formula/hidden-workbook fix is still incomplete for supported `.xls` input

- The student upload contract accepts `.xls`, but the XLS inspector always returns an empty formula list at `converter/app/document_structure.py:133`, hard-codes `formula_cell_count` to zero at `converter/app/document_structure.py:141`, and calls `_warnings` with a zero formula count at `converter/app/document_structure.py:146`.
- Consequently, the student workflow only creates `formula_cells_detected` when the inspector reports a non-zero count at `converter/app/student_workflow.py:997`; a real `.xls` formula is silently omitted from readiness and explanations.
- XLS hidden-location evidence is also not normalized to Excel coordinates. `xlrd` row/column indexes are collected directly at `converter/app/document_structure.py:113` and `converter/app/document_structure.py:118`, then exposed unchanged as user evidence at `converter/app/student_workflow.py:1046` and `converter/app/student_workflow.py:1055`. The second worksheet row is therefore reported as row `1`, and column A as column `0`.
- Coverage does not exercise this supported format: the structure test creates only `.xlsx` at `converter/tests/test_document_structure.py:12`, and the student warning API regression test also uses only the XLSX fixture at `converter/tests/test_student_api.py:314`.
- Bounded runtime probe with an actual `xlwt.Formula("1+1")`, hidden second row, and hidden column A returned:

```text
format=xls
formula_cell_count=0
formula warning absent
hidden_rows=[1]
hidden_columns=[0]
warning_codes=[hidden_rows_or_columns_detected]
```

Impact: a supported legacy MISA/Excel workbook can contain formulas without any student warning, while hidden-row/column evidence points to the wrong user-facing coordinates. This leaves prior Finding 5 unresolved and violates the evidence-grounding invariant.

Required correction: either detect `.xls` formulas with a reliable parser or emit a conservative warning that formula detection is unavailable for `.xls`; normalize hidden rows to 1-based worksheet rows and columns to Excel letters; add `.xls` structure and student-analyze regressions.

## Seven-finding disposition

1. **Retention after old context expiry: fixed.** Durable retention is signed at `backend/services/conversionContextService.js:132`, session refresh mints a new context without requiring the old one at `backend/controllers/studentSessionController.js:499`, upload expiry follows signed retention at `converter/app/student_store.py:261`, and refreshed ownership is exercised at `converter/tests/test_student_context.py:133`. Frontend resume refreshes on 401 and retries overview with the new token at `frontend/src/utils/studentAssistant.js:575`.
2. **Stable validated rate keys: fixed.** Context validation precedes allocation at `converter/app/main.py:1156`, the key is stable by action/owner/session/user at `converter/app/main.py:1172`, refresh bypass is covered at `converter/tests/test_student_api.py:696`, and invalid tokens do not allocate at `converter/tests/test_student_api.py:711`.
3. **Genuinely student-owned Phase 3 input: fixed.** New drafts do not preload the converter answer, mapping and preview values are editable at `frontend/src/components/student/StudentMappingTable.jsx:240` and `frontend/src/components/student/StudentMappingTable.jsx:311`, classification is student-controlled at `frontend/src/components/student/CheckWorkPanel.jsx:60`, and regressions are covered at `frontend/src/utils/studentAssistant.test.mjs:522` and `frontend/src/utils/studentAssistant.test.mjs:586`.
4. **Decimal no-float accounting path: fixed for the reviewed student totals.** Decimal parsing is introduced at `converter/app/parsing.py:32`, reconciliation delegates to it at `converter/app/student_reconciliation.py:365`, aggregate questions use it at `converter/app/student_queries.py:326`, and high-precision regressions exist at `converter/tests/test_student_reconciliation.py:105` and `converter/tests/test_student_queries.py:388`.
5. **Formula/hidden warnings with evidence: not fully fixed.** The Important finding above remains for `.xls`.
6. **Unresolved Accounting Map UI: fixed.** Backend returns `balanced=False` for unresolved events at `converter/app/student_accounting_map.py:118`, partial invalid amounts prevent balance at `converter/app/student_accounting_map.py:239`, and the UI renders unresolved state plus issues at `frontend/src/components/student/AccountingMapPanel.jsx:24` and `frontend/src/components/student/AccountingMapPanel.jsx:51`.
7. **Internship metadata privacy: fixed.** Filename and sheet names are replaced by safe labels at `converter/app/student_reports.py:149`, with regression coverage at `converter/tests/test_student_reports.py:76`.

## Regression and verification assessment

- No additional Critical/Important regression was found in the reviewed fixes for ownership isolation, temporary raw-workbook retention, AI authority boundaries, deterministic scoring, export safety, or frontend/API integration.
- Parent verification supplied for this re-review: converter `327/327`, backend `128/128`, frontend `48/48`, lint pass, and production build pass.
- Independent bounded checks reproduced the `.xls` gap above. Scoped conflict-marker and whitespace checks for the seven-fix paths found no issue.

## Verdict

**NO-GO.** No Critical finding remains, but one Important finding remains. PASS is rejected until supported `.xls` files receive safe formula-capability warnings/detection and correct hidden-location evidence with regression coverage.
