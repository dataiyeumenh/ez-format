# Full-system QA/QC (AI excluded)

Date: 2026-07-16

Branch/workspace: `codex/phase3-smart-vouchers` in `E:\0. EXE2\ez-format-phase3`.

## Scope

Covered the public website, authentication, user account UX, pricing, feedback,
traditional MISA conversion, Phase 1 company/master-data workspace, Phase 3 smart
voucher reconstruction, admin screens, MongoDB persistence, FastAPI converter,
real `.xls` templates, export contracts, security scans, and privacy boundaries.

Local/remote AI inference was intentionally disabled. The converter health endpoint
reported `ai=disabled`, and deterministic/profile logic remained operational.

## Accounting and MISA knowledge audit

- `update-ke-toan` audited 70 core legal, tax, invoice, MISA documentation, video,
  and data-entry sources; all 70 were reachable on the audit date.
- The complete `ke-toan` knowledge-base validator passed with 470 sources.
- No accounting/MISA knowledge was deprecated or removed during this audit.
- This QA confirms deterministic import/validation behavior against the configured
  rules and templates; it is not a legal-compliance certification.

## Defects found and corrected

1. Multi-line invoices were incorrectly treated as duplicate documents because line
   amount/VAT fields were included in the document-header fingerprint. Duplicate
   detection now compares only nonblank header-level values, so repeated detail lines
   are accepted while conflicting invoice dates/header data remain blockers.
2. MISA VAT markers `KCT` and `KKKNT` were incorrectly reported as unparseable
   numbers. They are now accepted as zero-VAT calculation markers without replacing
   the original import value.
3. Purchase rows with zero placeholder quantity/unit price generated false amount
   mismatches. Formula validation now runs only when both operands are nonzero.
4. Small line differences caused by displayed unit-price precision generated false
   blockers. Tolerance is now derived from quantity and the displayed unit-price
   precision, while mismatches outside representational rounding still fail.
5. Legacy duplicate warnings used only invoice number + item code and flagged valid
   repeated items. They now require an identical accounting-line fingerprint.
6. Admin search/filter/modal controls lacked accessible names. Visible admin controls
   and tested modals now have complete accessible names.
7. Placeholder admin storage, server-health, notification, profile, settings, and
   search controls were misleading/nonfunctional. They were removed; admin logout now
   uses a confirmation popover.
8. Workspace dependency junctions appeared as untracked `node_modules` entries.
   `.gitignore` now excludes directory and junction forms.

## Automated gates

| Gate | Result |
|---|---:|
| Backend Node tests | 76 passed |
| Converter tests with AI excluded | 166 passed, 41 deselected |
| Focused accounting/readiness/API regression | 40 passed |
| Frontend reconstruction utility tests | 4 passed |
| ESLint | Passed |
| Prettier check | Passed |
| Production frontend build | Passed |
| Workspace `qa:fast` | 5/5 passed |
| Full-system Node/API checks | 53 passed |
| Phase 1 + Phase 3 API E2E | 80 passed |
| Phase 3 desktop/mobile browser QA | 23 passed |
| Full public/user/admin browser QA | 51 passed |

## Real-file accounting results

### Sales

Raw file: `E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx`

Reference: `E:\0. EXE2\Import misa 05.12 - 25.12.xls`

- 1,930 input/output rows.
- 59 MISA headers.
- Zero deterministic blockers; two review warnings for unused source columns and
  master-data not being selected.
- Sheet name, headers, merged cells, column widths, header styles, and header height
  match the reference.
- First 20 rows: 260 key accounting cells matched the reference with zero mismatch.
- First 20 rows: 1,180 preview/export cells matched with zero mismatch.

### Purchase

Raw file: `C:\Users\Admin\Downloads\MUA_VAO_0317262773 (7).xlsx`

Template: `C:\Users\Admin\Downloads\mua_hang_trong_nuoc_full.xls`

- 184 input/output rows.
- 58 MISA headers.
- Zero deterministic blockers; three review warnings for unused columns,
  master-data review, and master-data not being selected.
- `KCT`/`KKKNT`, zero placeholder operands, multi-line invoices, and displayed-price
  rounding no longer create false blockers.
- Sheet name, headers, merged cells, column widths, header styles, and header height
  match the real template.
- First 20 rows: 1,160 preview/export cells matched with zero mismatch.

## Browser and performance evidence

Full browser QA covered registration, persistent login-error popup, login, user plan
display, feedback submission, company workspace/catalogs, sales and purchase preview,
readiness acknowledgement, MISA download, logout confirmation, all admin data pages,
admin conversion history, feedback history, user edit/PerFile credits, ban popup,
plan editor/popular toggle, accessibility, and mobile overflow.

Observed local browser timings:

| Flow | Analyze | Readiness | Download/export |
|---|---:|---:|---:|
| Sales, 1,930 rows | 1.35 s | 4.48 s | 8.78 s |
| Purchase, 184 rows | 0.34 s | 1.04 s | 1.50 s |

These are local-machine timings, not production internet/VPS latency measurements.

## Security and privacy

- Root, backend, and frontend production dependency audits reported zero known
  vulnerabilities at scan time.
- Python dependency consistency passed (`pip check`).
- Secret scan covered 308 tracked/unignored files and found no private key, GitHub,
  OpenAI, Google, Slack, or embedded MongoDB credential pattern.
- Reconstruction/conversion/profile MongoDB collections were scanned for known QA
  invoice, tax-code, supplier, item, and service values; no raw transaction value was
  found.
- Node/converter service logs were scanned for the same markers; no raw transaction
  value was found.
- Temporary reconstruction drafts still contain the data required for user editing
  and export inside the configured temporary store/TTL; they are not persisted in the
  long-term MongoDB run/profile records.

## Release assessment

The non-AI core is suitable for a controlled deployment based on local QA. Required
post-deploy gates remain:

1. Run production URL smoke tests for frontend, Node API, converter, CORS, upload,
   readiness, and download.
2. Validate PayOS settlement/webhook with a deliberately controlled real transaction.
3. Validate Google OAuth and email delivery using deployment credentials.
4. Monitor converter latency/memory on representative production files.

AI mapping/reconstruction quality is outside this QA run and must be validated
separately before enabling AI-dependent claims.
