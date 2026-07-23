# Kế toán/MISA Review — Converter Usability Controls

**Reviewed spec:** `docs/superpowers/specs/2026-07-16-converter-usability-controls-design.md`  
**Review date:** 2026-07-16  
**Reviewer role:** `ke-toan` skill  
**Final verdict:** APPROVED — 15/15 checklist items passed

`15/15` means the design satisfies the complete accounting/MISA safety checklist defined for this change. It is not a claim that the application or every future file is legally/MISA-correct 100%.

## Source And Knowledge Validation

- `validate-ke-toan-kb.py`: passed, 470 sources.
- Official MISA source reachability audit: passed for the active AMIS/SME import, mapping, troubleshooting and reconciliation sources checked on 2026-07-16.
- No legal/tax rule was added or changed by this frontend UX design.

Primary sources:

- https://helpact.misa.vn/kb/html_10050000/
- https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/
- https://helpact.misa.vn/kb/huong-dan-an-hien-thong-tin-khi-thuc-hien-ghep-cac-cot-tu-lieu-tu-file-excel-vao-phan-mem/
- https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/

## Round 1 Findings

Round 1 was not approved. The original spec had four gaps:

1. It did not state the actual backend precedence for default, source mapping and formula.
2. It called multi-mode configuration a conflict without defining whether that was a blocker or warning.
3. It bounded master-data rows but still allowed the issue table to render up to 200 rows.
4. It did not explicitly require previous readiness/acknowledgement to be invalidated after every data or mapping change.

The spec was revised before the final review.

## Final Checklist

| # | Accounting/MISA safety criterion | Result |
|---:|---|---|
| 1 | No placeholders or unresolved design decisions | PASS |
| 2 | Official AMIS/SME sources are cited | PASS |
| 3 | Required fields remain derived from the selected template `(*)` | PASS |
| 4 | Backend precedence is documented accurately | PASS |
| 5 | Multi-mode configuration is `mixed/review`, not an automatic blocker | PASS |
| 6 | Frontend cannot change backend severity | PASS |
| 7 | Master-data list is bounded to 20 rows/page | PASS |
| 8 | Validation issue list is bounded to 25 rows/page | PASS |
| 9 | Summary covers every target header and exposes mixed/unmapped fields | PASS |
| 10 | CTA distinguishes validation from export | PASS |
| 11 | Mapping/data/master-data changes invalidate old readiness and acknowledgement | PASS |
| 12 | Backend export revalidation remains mandatory | PASS |
| 13 | Responsive behavior is specified | PASS |
| 14 | Accessibility behavior is specified | PASS |
| 15 | Browser QA uses the real 1.930-row file and validates MISA output flow | PASS |

## Deterministic Vs Review Rules

### Deterministic blockers remain backend-owned

- Required template mapping/value missing.
- Required date/number cannot be parsed.
- Deterministic amount/VAT/total mismatch.
- Template or workbook cannot be processed safely.

### Frontend review states

- Multiple configured fill modes on one target field.
- Master-data code has not been checked against the selected company.
- Optional source columns are not used.
- Accounting/business judgment warnings returned by readiness.

Frontend review states must not be promoted to blockers without a deterministic backend rule and source.

## Approval Boundary

Implementation is approved only if it preserves these invariants:

```text
AI cannot change severity.
Frontend cannot bypass export validation.
Mixed mapping configuration is review-only unless backend detects a deterministic error.
Filtering and pagination cannot drop issues or resolutions from the underlying data.
Required fields and blockers remain visible in summary even when lists are collapsed.
Any user edit invalidates stale readiness and warning acknowledgement.
```

## Implementation Re-review

The implemented change was reviewed again after browser QA and review-driven fixes.

Final result:

- No remaining Critical/High/Medium findings in scope.
- Warning acknowledgement is cleared before every new preview/readiness run.
- Failed readiness cannot leave an old report controlling the download CTA.
- Workspace creation resets the active conversion state.
- Activating a master-data snapshot re-analyzes the selected file with a fresh context.
- Frontend export does not make a redundant readiness request; backend export revalidation remains mandatory.
- Mapping filters, 20-row master-data pagination, 25-row issue pagination and confidence disclaimer match the approved design.
- Frontend tests: 23/23 passed.
- Workspace `qa:fast`: 6/6 passed.
- Browser QA with the 1.930-row real file produced a structurally valid 59-column MISA `.xls`.

**Implementation verdict:** APPROVED for the accounting/MISA UX checklist defined by this change.

## Real-user QA Follow-up — 2026-07-17

The local website was exercised as a newly registered free user with the real
1,930-row sales workbook. All 19 customer-facing checks passed: registration,
login error persistence, login, account-plan menu, template selection before
upload, analyze, mapping coverage, preview, readiness, warning acknowledgement,
download, mobile overflow, accessibility names and logout confirmation.

The first downloaded workbook exposed one deterministic MISA-export defect:
ISO date strings were written as text cells even though the template applied a
date number format. The reference workbook stores those values as native Excel
date cells. The exporter was fixed test-first so date-formatted template cells
parse supported date strings and write Excel serial values.

Post-fix evidence:

- Full converter suite: 208/208 passed.
- Export regression group: 12/12 passed.
- Workspace `qa:fast`: 6/6 passed.
- Output and reference: same 59 headers, merged regions and column widths.
- First 20 key accounting rows match the reference, including posting date,
  voucher date, expiry date, quantity, unit price, amount, discount and lot.
- Date fields are now `XL_CELL_DATE`, not text.
- Real-user timings: analyze 2.30s, preview 6.28s, validation 4.86s and export
  download 5.96s on the local machine.
- Upload no longer triggers a hidden analyze before the explicit CTA. Browser
  regression evidence confirms zero analyze requests before the click and one
  request after the click, preventing duplicate conversion-history entries.

Remaining external configuration finding:

- Google Identity rejects `http://localhost:5173` for the configured Client ID.
  This does not affect the converter flow but Google login cannot pass local QA
  until that exact origin is authorized in Google Cloud Console for the Client ID
  used by the frontend.

**Follow-up verdict:** APPROVED for the converter/MISA user flow. Google local
login remains a separate environment-configuration item.

## Multi-tenant Profile Isolation Finding

The same real-user run also showed that an account without an accounting
workspace loads and updates the SQLite profile under `workspace_id = ""`.
That profile scope is shared by every user who has no workspace. Mapping
profiles contain defaults and formulas, which may include company-specific
warehouse codes, account codes and document conventions.

This is not approved for multi-tenant production because a correction made by
one no-workspace user can influence another user's future conversion with the
same source signature. The deterministic converter output remains valid for the
tested BSN sample, but ownership isolation is incomplete.

Recommended remediation:

1. Issue a signed conversion context for every authenticated user, not only for
   selected workspaces.
2. Scope mapping profiles by `workspace_id` when present; otherwise scope them
   by authenticated `user_id`.
3. Reject profile confirm/export when the signed owner scope does not match.
4. Add cross-user tests proving that one user's defaults/formulas cannot be
   loaded or exported by another user.

**Production verdict after extended user QA:** NOT 100% approved for the
no-workspace multi-tenant flow until profile ownership isolation is implemented.
The date-export and converter UX changes themselves are approved.
