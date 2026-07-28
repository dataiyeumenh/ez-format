# Accounting Student Assistant - ke-toan Review

**Reviewed:** 2026-07-17
**Scope:** Phase 0 through Phase 6 only
**Decision:** Approved for implementation with deterministic accounting boundaries

## Review Result

- The design preserves the existing MISA template as source of truth.
- Blank values remain distinct from zero and identifier leading zeroes must be preserved.
- Decimal arithmetic is mandatory for amounts, VAT, balancing and reconciliation.
- Missing template fields marked `(*)`, parse failures and arithmetic mismatches may block only when deterministic.
- VAT eligibility, account choice and business classification remain `warning` or `needs_review` unless configured evidence makes them deterministic.
- AI cannot create evidence, change severity, choose an account silently or bypass export readiness.
- Student answers must cite workbook rows/columns or an explicit rule source.
- MISA field identifiers in the design were corrected to the repository IDs `sales_service`, `purchase_service` and `misa_purchase_domestic`.

## Required Safety Gates

1. Phase 0 owner isolation and signed context must ship before any student endpoint.
2. The existing converter remains operational with all student flags disabled.
3. Accounting-map entries use only workbook values, confirmed profiles, workspace configuration or explicit template defaults.
4. Unsupported reconciliation modules return `insufficient_data`; they never return a fabricated zero or success.
5. Internship reports contain verified metadata only and pass confidential-value scanning before export.

## Source Basis

- MISA AMIS Excel import: https://helpact.misa.vn/kb/html_10050000/
- MISA SME Excel import: https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/
- Internal accounting coding policy: `/home/admin_mugen/.codex/skills/ke-toan/references/misa-coding-rules.md`
- Internal import/export policy: `/home/admin_mugen/.codex/skills/ke-toan/references/misa-import-export-guide.md`

No Critical or High accounting issue remains in the design before implementation.
