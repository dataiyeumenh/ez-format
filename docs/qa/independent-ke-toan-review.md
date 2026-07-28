# Independent Vietnamese Accounting/MISA Review

## Verdict

**PASS for the scoped accounting review. Production readiness: NOT ATTESTED.**

The canonical BSN sales template and the current 1,930-row export preserve the
relevant MISA style properties exactly. Purchase adjustment references are
retained as review-only metadata. No automatic adjustment posting decision was
found.

Reviewer: independent senior Vietnamese accounting/MISA review using
`C:\Users\Admin\.agents\skills\ke-toan\SKILL.md`.
Implementation changes: none. Git mutations: none.
Reviewed: `2026-07-28 08:12:26 +07:00`.
Branch: `Experimental`.
HEAD: `937f3bb44775a2485c7290ec0a56435b66b8aa3a`.
Worktree: already dirty before review; application code was not modified.

## 1. Template/export review

Reference files:

- Raw sales: `E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx`
- Correct MISA output/reference: `E:\0. EXE2\Import misa 05.12 - 25.12.xls`
- Canonical template: `E:\0. EXE2\ez-format\converter\fixtures\templates\bsn_sales.xls`

Independent export used the current `read_input_table` ->
`heuristic_suggestion` -> `apply_mapping` -> `write_xls_from_template` path.

Results:

- Raw rows: `1930`; mapped/exported rows: `1930`.
- Relevant comparison scope: `1938 x 59 = 114342` cells.
- Canonical template vs reference style mismatches: `0/114342`.
- Exported workbook vs reference style mismatches: `0/114342`.
- Sheet name: `Ban hang` on both sides.
- Merged-cell set: equal.
- Style comparison includes number format, font, alignment, border, fill,
  protection, and formula-hidden/locked flags.
- Reference workbook has a large blank tail (`65534` rows reported by `xlrd`);
  comparison intentionally covers the populated/reference scope through row
  `1938`, not blank tail rows.

Evidence:

- `E:\0. EXE2\ez-format\.artifacts\qa\independent-ke-toan-current\style-comparison.json`
- `E:\0. EXE2\ez-format\.artifacts\qa\independent-ke-toan-current\sales_export_1930.xls`

## 2. Purchase adjustment review

Input: `C:\Users\Admin\Downloads\MUA_VAO_0317262773 (7).xlsx`.
Detected input rows: `184`. Detected adjustment contexts: `4`.

Required references:

| Adjustment invoice | Parsed reference | Review flag |
|---|---|---|
| `41617` | `1K26TEB / 38884 / 03/04/2026` | `true` |
| `41686` | `1K26TEB / 39087 / 03/04/2026` | `true` |

The real analyze flow returned:

- Target: `misa_purchase_domestic`.
- Adjustment warning present: `true`.
- Review context returned: `4` entries.
- Mapping/default/formula keys containing adjustment treatment: none.

The source rows for original invoices `38884` and `39087` are also surfaced as
review contexts with no inferred reverse reference. This is safe fail-closed
behavior; manual reconciliation remains required.

Evidence:

- `E:\0. EXE2\ez-format\.artifacts\qa\independent-ke-toan-current\purchase-adjustment-analysis.json`
- Implementation reviewed: `E:\0. EXE2\ez-format\converter\app\excel_io.py`
  (`read_purchase_adjustment_context`)
- Workflow reviewed: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
  (`analyze_upload` review-context/warning wiring)

## 3. Accounting safety

PASS for the reviewed scope:

- Adjustment detection returns metadata plus `requires_user_review=true`.
- Analyze adds a warning asking the user to check original documents/references.
- The adjustment context is not written into mapping, defaults, or formulas.
- No automatic debit/credit account, tax treatment, quantity, amount, or
  voucher-posting decision is inferred from the adjustment text.
- This matches the `ke-toan` policy: deterministic facts may be surfaced;
  business judgment stays a warning/manual review.

MISA operation source used for review:

- [MISA AMIS Excel import](https://helpact.misa.vn/kb/html_10050000/)
- [MISA SME Excel import](https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/)

No claim is made that the workbook is legally correct, VAT-eligible, account-
correct, or accepted by MISA in every company configuration.

## 4. Commands and evidence

Focused automated tests:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_template_export_contract.py tests/test_purchase_adjustment_context.py -q
```

Result: **9 passed in 34.70s**.

Extended focused tests:

```powershell
python -m pytest tests/test_misa_template_export_contract.py tests/test_purchase_adjustment_context.py tests/test_misa_purchase_domestic.py tests/test_misa_profile_api.py -q
```

Result: **27 passed in 51.49s**.

Independent style/export and real purchase analyze checks were executed as
one-off Python scripts. Results are stored in the evidence JSON files above.
`git diff --check` completed without whitespace errors.

## 5. Fixture hashes

| Fixture | SHA-256 |
|---|---|
| `E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx` | `3e2b01b088b1accfe16912b2a1bb4bff772b28c8bfe9ef9a563ad4d7ec2a73fb` |
| `E:\0. EXE2\Import misa 05.12 - 25.12.xls` | `06c2e6d5c8016b5b721bc16ceea6efdf8b9ce5d2a736988eb442008391739d69` |
| `C:\Users\Admin\Downloads\MUA_VAO_0317262773 (7).xlsx` | `fc642e57ec7792526201cf4c907d4333803cce506078797ed3bce853e8c68859` |
| `C:\Users\Admin\Downloads\mua_hang_trong_nuoc_full.xls` | `e4772c711d38da6203a3d00721ae2af4d0324c587e008f55da684db9e896e93b` |

## 6. Limitations / release conditions

- No live import into MISA AMIS/SME; MISA acceptance and rendered appearance
  were not observed.
- No external MongoDB or S3 deployment was tested.
- No production Node-FastAPI gateway, browser journey, or live AI call was
  included in this accounting-only review.
- No company chart of accounts, supplier/item/warehouse master data, or
  approved company mapping profile was supplied.
- VAT eligibility and account suitability were not adjudicated.
- Style equality is property-level comparison over the relevant `114342` cells;
  BIFF binary record ordering/index identity is not asserted.

Therefore this report does **not** grant production sign-off. Before release,
run live MISA import acceptance plus the Node/FastAPI, Mongo/S3, browser, and
deployment gates.
