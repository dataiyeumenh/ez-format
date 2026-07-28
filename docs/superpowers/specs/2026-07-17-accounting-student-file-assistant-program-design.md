# Accounting Student File Assistant Program Design

**Date:** 2026-07-17  
**Scope:** Phases 0 through 6  
**Explicitly excluded:** Phase 7 lecturer/classroom dashboard  
**Primary audience:** Vietnamese accounting students in years 3-4 and interns  
**Initial accounting scope:** Sales and purchase workbooks supported by the existing MISA converter

## 1. Executive Summary

EzFormat will evolve from a file converter into a file-grounded accounting
assistant for students. The product will help a student understand a workbook,
inspect how source data maps to MISA, ask questions that are answered from the
current file, identify file issues, follow a voucher through its accounting
effects, reconcile totals, and produce an internship-safe activity record.

The implementation must extend the current converter rather than create a
separate LMS or generic accounting chatbot. Existing deterministic mapping,
readiness validation, canonical voucher reconstruction, workspace master data,
real-template export and optional AI infrastructure remain the source of truth.

The program is split into independently releasable phases:

```text
Phase 0  Ownership, privacy, source and retention foundation
Phase 1  Explain My File
Phase 2  Ask About This File
Phase 4  Voucher and Accounting Map
Phase 5  Reconciliation and Control
Phase 6  Internship Assistant
```

No implementation from a later phase may weaken the accounting, security or
export invariants established by an earlier phase.

## 2. Product Decision

### 2.1 Positioning

```text
EzFormat Student
Trợ lý hiểu, kiểm tra và xử lý dữ liệu kế toán theo file thực tế.
```

The product supports students while they work. It does not replace university
coursework, write assignments, certify legal compliance or simulate the entire
MISA interface.

### 2.2 Core user outcome

A student can upload a supported workbook and answer all of the following:

1. What kind of data is this?
2. Which source columns feed which MISA fields?
3. Why was each mapping suggested?
4. Which values are invalid, inconsistent or uncertain?
5. What should be corrected before import?
6. Which source rows form a voucher?
7. What accounting concepts and tentative entries are involved?
8. Do invoice, VAT and payment totals reconcile?
9. What did the student learn or correct during the session?

### 2.3 Initial persona

The first release targets a student who:

- has completed introductory accounting;
- understands basic debit/credit terminology;
- is working with accounting, tax, accounting information systems or MISA and needs practical file support;
- receives Excel exports, invoice lists or import exercises;
- needs help understanding and checking the work rather than receiving an
  untraceable answer.

### 2.4 Source basis

The design is aligned with public accounting education and MISA sources:

- NEU Accounting Principles syllabus:
  https://courses.neu.edu.vn/syllabus/K66/vi/KTKE1101
- UEL Accounting program, including accounting data analysis, ERP, spreadsheets
  and accounting software:
  https://tuyensinh.uel.edu.vn/gioi-thieu-nganh-ke-toan/
- Banking Academy audit program, including financial accounting, management
  accounting, internal control, risk and data processing:
  https://hvnh.edu.vn/hvnh/vi/sinh-vien-tuong-lai/goc-review-ctdt-act04-chuong-trinh-kiem-toan-he-chuan-4020.html
- MISA AMIS Excel import:
  https://helpact.misa.vn/kb/html_10050000/
- MISA SME Excel import:
  https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/

University sources provide educational structure, not legal authority. MISA
sources provide product-operation guidance, not legal authority. Legal or tax
claims still require an official legal source.

## 3. Non-Negotiable Invariants

```text
AI cannot change validation severity.
AI cannot override an export blocker.
AI cannot invent amounts, dates, invoice numbers, accounts or source rows.
Every file-grounded answer must cite source rows/columns or an explicit rule.
Every legal/accounting rule must declare source and determinism.
Raw files are temporary by default.
Profiles and sessions are always scoped to an authenticated owner.
Frontend state cannot bypass backend validation.
Blank remains distinct from zero.
Codes, tax identifiers and voucher numbers preserve leading zeroes.
The UI cannot claim legal or MISA correctness at 100%.
```

## 4. Program Architecture

### 4.1 Service responsibilities

#### React frontend

- Student assistant navigation and workspace.
- File summary, mapping, preview and explanation inspector.
- File-grounded question interface.
- Voucher/accounting map visualization.
- Reconciliation panels.
- Internship activity and anonymization controls.
- No accounting severity, grouping or export decisions.

#### Node/Express backend with MongoDB

- Authentication and authorization.
- Durable student session metadata.
- Owner-scoped profile authorization.
- Signed converter context for every authenticated session.
- Quota, feature flags and retention policy.
- Internship activity records.
- Internal service contracts with FastAPI.

#### FastAPI converter

- Temporary workbook bytes and parsed tables.
- Mapping and template analysis.
- Deterministic explanation generation.
- File query execution and citations.
- Check-my-work scoring inputs and deterministic checks.
- Canonical voucher reconstruction and provenance.
- Accounting-map construction.
- Reconciliation.
- Existing readiness and real-template export.

#### AI Gateway

- Optional natural-language explanation.
- Optional intent classification after deterministic shortcuts.
- Optional synthesis over already selected evidence.
- Never receives the full workbook unless a future explicit policy changes this.
- Never owns arithmetic, severity, source selection or export decisions.

### 4.2 End-to-end flow

```text
Authenticated frontend
-> Node creates StudentFileSession and signed context
-> Frontend uploads workbook to FastAPI with signed context
-> FastAPI analyzes using existing converter pipeline
-> FastAPI returns mapping, provenance, issues and explanation summary
-> User inspects, asks and edits the file with evidence-backed assistance
-> FastAPI revalidates deterministic state
-> Node stores privacy-safe session metadata, not raw workbook
-> Existing MISA export gate produces the file
-> Temporary file/session data expires by policy
```

### 4.3 Reuse requirements

The program must reuse rather than fork:

- existing MISA templates and exporter;
- existing mapping and profile logic after owner isolation is fixed;
- existing readiness report and export gate;
- existing workspace master-data context;
- existing canonical voucher reconstruction;
- existing AI Gateway boundary;
- existing conversion history where compatible.

## 5. Shared Ownership And Session Model

### 5.1 Owner scope

Every durable profile and student session uses one canonical scope:

```text
workspace:<workspace_id>  when a workspace is selected
user:<user_id>            otherwise
```

The empty scope is invalid for newly created or updated profiles.

### 5.2 Signed student context

Node issues a short-lived signed token:

```json
{
  "purpose": "student_file_session",
  "session_id": "uuid",
  "user_id": "mongo-object-id",
  "owner_scope": "user:mongo-object-id",
  "workspace_id": null,
  "snapshot_set_hash": null,
  "allowed_scopes": [
    "analyze",
    "explain",
    "ask",
    "accounting_map",
    "reconcile",
    "export"
  ],
  "expires_at": "ISO-8601"
}
```

FastAPI rejects missing, expired, wrong-purpose or owner-mismatched contexts.

### 5.3 MongoDB entities

#### StudentFileSession

```json
{
  "userId": "ObjectId",
  "workspaceId": null,
  "ownerScope": "user:<id>",
  "mode": "student_assistant",
  "status": "created|analyzed|in_review|exported|expired|deleted",
  "file": {
    "originalName": "sales.xlsx",
    "sizeBytes": 574528,
    "extension": ".xlsx",
    "contentHash": "sha256",
    "rawRetained": false
  },
  "converterUploadId": "uuid",
  "targetTemplateId": "bsn_sales",
  "sourceSignatureHash": "sha256",
  "summary": {},
  "retentionExpiresAt": "ISO-8601",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

#### StudentQuestionEvent

Stores the question, answer type, evidence identifiers and outcome. It must not
store a full raw row payload by default.

## 6. Shared Explanation Contract

Every explanation item uses one stable schema:

```json
{
  "id": "stable-id",
  "kind": "mapping|field|normalization|issue|calculation|master_data|voucher",
  "severity": "blocker|warning|info|none",
  "deterministic": true,
  "targetField": "Ngày hạch toán (*)",
  "source": {
    "sheet": "Data",
    "row": 25,
    "column": "Thời gian",
    "rawValue": "25/12/2025 17:23"
  },
  "normalizedValue": "2025-12-25T17:23:00",
  "concept": {
    "title": "Ngày hạch toán",
    "meaningVi": "Ngày nghiệp vụ được ghi nhận vào sổ kế toán."
  },
  "reasonVi": "Cột Thời gian chứa ngày phát sinh của chứng từ.",
  "impactVi": "Có thể ảnh hưởng kỳ ghi nhận và báo cáo kế toán.",
  "fixHintVi": "Đối chiếu ngày hóa đơn và ngày ghi nhận theo đề bài.",
  "rule": {
    "ruleId": "posting_date_mapping",
    "sourceUrl": "https://...",
    "checkedAt": "2026-07-17",
    "effectiveFrom": null,
    "effectiveTo": null
  }
}
```

Missing evidence produces an explicit `unsupported` response rather than a
fabricated explanation.

## 7. Phase 0 - Foundation

### 7.1 Goals

- Eliminate unscoped mapping profiles.
- Create student sessions and signed owner context.
- Define raw-file retention and deletion behavior.
- Add source metadata and explanation rule registry.
- Add feature flags and audit events.
- Establish synthetic/anonymized test data.

### 7.2 Profile isolation

Production mapping profiles remain owned by Node/MongoDB. FastAPI local SQLite
profiles are limited to explicit local-development mode and must also carry a
non-empty owner scope.

Profile lookup key:

```text
owner_scope + target_template_id + source_signature_hash
```

Profile retrieval, confirmation and export all verify the signed owner scope.

### 7.3 Retention

- Raw workbook default TTL: 24 hours or less.
- Parsed session/draft TTL: 24 hours or less unless an active review policy
  explicitly extends it.
- MongoDB retains privacy-safe session metadata but not workbook bytes.
- User deletion invalidates converter state and removes durable student metadata
  allowed by product/accounting audit policy.
- Logs exclude full rows, tax identifiers and customer/supplier names.

### 7.4 Anonymization foundation

Provide deterministic replacement for:

- company names;
- customer and supplier names;
- tax identifiers;
- addresses, emails and phone numbers;
- bank accounts;
- document numbers when the user requests full anonymization.

Anonymization preserves relational consistency within one file. The same source
value maps to the same pseudonym in that session.

### 7.5 Feature flags

```text
STUDENT_ASSISTANT_ENABLED
STUDENT_FILE_EXPLAIN_ENABLED
STUDENT_FILE_QA_ENABLED
STUDENT_ACCOUNTING_MAP_ENABLED
STUDENT_RECONCILIATION_ENABLED
STUDENT_INTERNSHIP_ENABLED
```

Each flag is independently reversible. Disabling student features cannot disable
the existing converter.

### 7.6 Acceptance criteria

- Cross-user profile read/write/export attempts fail.
- User-scoped profiles are remembered for the same user.
- Workspace-scoped profiles remain workspace isolated.
- Expired session tokens fail.
- Expired raw files are deleted.
- Logs contain no full confidential row payloads.
- Existing conversion flow passes unchanged when all student flags are off.

## 8. Phase 1 - Explain My File

### 8.1 Goals

- Explain file structure, mapping, normalization and validation without requiring AI.
- Make every explanation traceable to source data or a rule.
- Integrate with the existing conversion page through a student mode.

### 8.2 File summary

The summary includes:

- detected file type and target template;
- sheets, header row and data row count;
- estimated document count when safely available;
- recognized and unresolved columns;
- mapping-mode counts;
- blocker/warning/info counts;
- master-data verification status;
- totals that can be reconciled from available columns.

### 8.3 Field dictionary

The initial dictionary covers all fields in:

```text
bsn_sales
bsn_purchase
sales_goods
sales_service
purchase_goods
purchase_service
misa_purchase_domestic
```

Each entry records concept, plain-language meaning, common source aliases,
required status source, common mistakes, fix hints and source metadata.

### 8.4 Explanation engine

The engine emits:

- why a source field was mapped;
- how a value was normalized;
- whether a default or formula was used;
- which deterministic rule produced an issue;
- which fields require business judgment;
- which MISA master data remain unverified.

### 8.5 UX

Desktop uses a three-area layout:

```text
Session summary | Mapping/preview table | Explanation inspector
```

Mobile uses an explanation bottom sheet. Selecting a mapping row, preview cell,
validation issue or master-data item opens the same inspector contract.

### 8.6 Acceptance criteria

- Every required field in the initial templates has a field explanation.
- Selecting an item opens the correct explanation and evidence.
- Explanations survive filtering and pagination.
- Editing mapping/data invalidates stale explanations and readiness.
- AI offline does not remove deterministic explanations.
- Existing export behavior remains unchanged.

## 9. Phase 2 - Ask About This File

### 9.1 Goals

- Answer questions grounded in the active file and rule registry.
- Prefer deterministic query execution over LLM generation.
- Link every answer to evidence the student can inspect.

### 9.2 Supported intent families

```text
file_summary
locate_column
locate_rows
explain_mapping
explain_issue
aggregate_amount
count_documents
find_duplicates
find_vat_mismatches
required_actions_before_export
concept_explanation
unsupported_legal_or_business_judgment
```

### 9.3 Query execution

```text
Question
-> deterministic intent shortcuts
-> bounded file query
-> evidence selection
-> optional AI phrasing/synthesis
-> schema validation
-> citation validation
-> response
```

### 9.4 Answer contract

```json
{
  "answer": "Có 3 dòng có tiền thuế không khớp.",
  "answerType": "deterministic_file_query",
  "confidence": "verified",
  "evidence": [
    {
      "sheet": "Data",
      "row": 25,
      "field": "Tiền thuế GTGT",
      "actual": "100000",
      "expected": "80000"
    }
  ],
  "ruleSources": [],
  "needsProfessionalReview": false,
  "unsupportedReason": null
}
```

### 9.5 Safety

- No evidence means no file-specific answer.
- Unknown VAT eligibility remains a warning requiring review.
- Account recommendations require configured accounting context and remain
  suggestions unless deterministically defined.
- AI output is rejected if it introduces unseen rows, fields or values.
- Questions cannot access another session or owner scope.

### 9.6 Acceptance criteria

- A benchmark of at least 50 representative questions passes.
- Every file-specific answer contains valid evidence.
- Clicking evidence navigates to the correct row/field.
- AI timeout falls back to deterministic results or an explicit unavailable state.
- Repeated questions cannot escape the active session scope.

## 10. Phase 3 - Removed: Grading

EzFormat is an operational support platform, not a learning-management or assessment system. It does not score work, grade users, persist attempts, rank skills or progressively unlock answers. Mapping edits remain available only to help users correct and complete their files.

## 11. Phase 4 - Voucher And Accounting Map

### 11.1 Goals

- Connect raw rows, canonical vouchers, tentative accounting effects and MISA fields.
- Reuse canonical voucher reconstruction and field provenance.
- Present account entries as supported suggestions, not universal truth.

### 11.2 Visual chain

```text
Source rows
-> Canonical voucher
-> Business nature
-> Accounting elements affected
-> Suggested debit/credit lines
-> MISA target rows
-> Reports potentially affected
```

### 11.3 Accounting map contract

```json
{
  "voucherId": "stable-id",
  "businessEvent": "credit_sale",
  "businessEventStatus": "supported",
  "entries": [
    {
      "side": "debit",
      "account": "131",
      "amount": "1080000",
      "status": "suggested",
      "reasonVi": "Bán hàng chưa thu tiền theo dữ liệu hiện có.",
      "evidence": []
    },
    {
      "side": "credit",
      "account": "5111",
      "amount": "1000000",
      "status": "suggested",
      "reasonVi": "Doanh thu bán hàng hóa theo template và cấu hình.",
      "evidence": []
    }
  ],
  "balanced": true,
  "issues": []
}
```

### 11.4 Account suggestion policy

Account suggestions may use, in order:

1. explicit exercise/company chart of accounts;
2. confirmed workspace mapping/profile;
3. deterministic template defaults with an explicit source;
4. AI suggestion marked `needs_review`.

No account is silently invented. Unbalanced entries are blockers for the
accounting-map exercise, but they do not retroactively change the existing MISA
readiness severity unless the export contract requires those accounts.

### 11.5 Acceptance criteria

- Every suggested line has evidence and status.
- Debit and credit totals use Decimal and reconcile.
- Unsupported account choices remain unresolved or suggested.
- Student edits create a new revision with provenance.
- Source rows, voucher fields and MISA rows remain navigable in both directions.

## 12. Phase 5 - Reconciliation And Control

### 12.1 Goals

- Teach students to compare independent totals and identify explainable deltas.
- Reuse existing amount/VAT/readiness calculations.
- Avoid claiming a full general-ledger or inventory-costing engine.

### 12.2 Initial reconciliation modules

```text
input_row_count_vs_output_row_count
detail_amount_vs_invoice_subtotal
subtotal_plus_vat_vs_payment_total
line_vat_vs_invoice_vat
duplicate_document_keys
customer_receivable_summary_when_supported
supplier_payable_summary_when_supported
inventory_quantity_summary_when_supported
```

### 12.3 Reconciliation item

```json
{
  "code": "invoice_total_mismatch",
  "status": "mismatch",
  "left": { "label": "Tổng chi tiết", "value": "1000000" },
  "right": { "label": "Tổng hóa đơn", "value": "1020000" },
  "delta": "-20000",
  "deterministic": true,
  "evidence": [],
  "possibleReasonsVi": [
    "Thiếu dòng chi tiết",
    "Chiết khấu chưa được tính",
    "Dòng tổng bị nhận nhầm là dữ liệu"
  ],
  "fixHintVi": "Đối chiếu các dòng chi tiết và cột chiết khấu."
}
```

Possible reasons are hypotheses and must be labeled as such. They cannot replace
the deterministic mismatch result.

### 12.4 Acceptance criteria

- Reconciliations use Decimal and declared tolerances.
- Each delta links to its source components.
- Unsupported modules show `insufficient_data`, not zero or success.
- Student corrections trigger fresh reconciliation.
- Export remains blocked only by existing deterministic readiness rules.

## 13. Phase 6 - Internship Assistant

### 13.1 Goals

- Help students safely record and explain practical data work.
- Prevent confidential company data from entering reports or portfolios.
- Build a skills record from actual verified actions.

### 13.2 Features

- File anonymization preview and export.
- Session activity timeline.
- Corrections and issues resolved.
- Checklist of work completed.
- Skill evidence summary.
- Internship handoff checklist.
- Portfolio-safe summary with no raw company values.
- Exportable personal report generated from metadata and user-approved notes.

### 13.3 Activity event

```json
{
  "sessionId": "ObjectId",
  "eventType": "issue_resolved",
  "skill": "vat_reconciliation",
  "summaryVi": "Đã sửa chênh lệch tiền thuế ở 3 dòng.",
  "evidenceCount": 3,
  "containsRawValues": false,
  "createdAt": "ISO-8601"
}
```

### 13.4 Report policy

The assistant may summarize verified actions. It may not:

- write a complete internship report or thesis;
- include raw confidential values by default;
- invent work not present in session history;
- claim professional certification;
- publish a report without explicit user action.

### 13.5 Acceptance criteria

- Anonymization is consistent within the exported workbook.
- Original files are never overwritten.
- Reports contain only verified activity and approved notes.
- Confidential-value scanners pass before export.
- Students can delete internship records allowed by retention policy.

## 14. UX Information Architecture

### 14.1 Entry point

Add a student assistant entry without replacing the existing converter:

```text
/student
  Explain my file
  Ask about this file
  Check my work
  Accounting map
  Reconciliation
  Internship record
```

### 14.2 Session workspace

One session workspace contains tabs:

```text
Overview
Mapping and data
Explanations
Questions
Attempts
Accounting map
Reconciliation
Activity
```

Tabs are feature-flagged by phase. The file remains one active context; tabs do
not duplicate uploads.

### 14.3 State requirements

Every phase supports:

- loading;
- empty;
- partial data;
- AI unavailable;
- converter unavailable;
- expired session;
- permission denied;
- deterministic blocker;
- review warning;
- completed/exported.

## 15. AI Policy

### 15.1 Allowed

- Rephrase deterministic explanations in student-friendly Vietnamese.
- Classify a question intent when deterministic shortcuts fail.
- Summarize already selected evidence.
- Suggest possible concepts or account choices as `needs_review`.
- Explain issues and suggested fixes from approved concepts and evidence.

### 15.2 Forbidden

- Reading another user's session.
- Creating values absent from evidence.
- Changing deterministic rule severity or readiness status.
- Deciding that a tax treatment is legally correct without a deterministic rule.
- Writing complete internship reports.

### 15.3 Prompt payload

Send only:

- question;
- target template identifier;
- relevant headers;
- bounded evidence rows/fields selected by backend;
- approved concept/rule snippets;
- nearby owner-scoped profile metadata without confidential values.

## 16. Security And Privacy

- All student APIs require authentication.
- Node validates ownership before issuing converter context.
- FastAPI validates signed context on every student endpoint.
- IDs alone never authorize access.
- Rate limits apply to upload, ask and export.
- Upload type, size and Excel magic are validated.
- Formula cells and hidden rows remain visible as warnings.
- Logs use request/session IDs and sanitized metadata.
- Raw files and AI payloads are excluded from application logs.
- Anonymized exports use new files and never modify originals.

## 17. Telemetry And Product Metrics

Record privacy-safe events:

```text
student_session_created
student_file_analyzed
explanation_opened
question_asked
question_answered_with_evidence
question_unsupported
issue_resolved
accounting_map_reviewed
reconciliation_completed
anonymized_export_created
misa_export_created
```

Program metrics:

- upload-to-first-explanation time;
- percentage of explanations with valid evidence;
- issue correction rate;
- unsupported question rate;
- AI fallback rate;
- export readiness improvement per session;
- repeat student sessions;
- cross-user access incidents, which must remain zero.

## 18. Rollout Sequence

```text
Release A  Phase 0 foundation behind flags
Release B  Phase 1 Explain My File pilot
Release C  Phase 2 bounded file Q&A
Release E  Phase 4 accounting map
Release F  Phase 5 reconciliation modules
Release G  Phase 6 internship assistant
```

Each release requires:

1. backend unit and integration tests;
2. cross-owner authorization tests;
3. accounting rule review using `ke-toan`;
4. frontend build and accessibility checks;
5. browser QA on desktop and mobile;
6. real-file QA with sales and purchase samples;
7. rollback verification through feature flags.

## 19. Program-Level Test Strategy

### 19.1 Unit tests

- Owner scope construction and validation.
- Signed context claims.
- Explanation schema and source registry.
- Deterministic query intents.
- Citation validation.
- Accounting-map balancing.
- Reconciliation math.
- Anonymization consistency.

### 19.2 Integration tests

- Node creates a student session and FastAPI accepts its token.
- Cross-user session/profile access is rejected.
- Existing analyze/preview/readiness/export flow remains compatible.
- AI valid, timeout and invalid-schema paths.
- Session expiration and raw-file cleanup.
- Mongo metadata persists while raw workbook expires.

### 19.3 Browser tests

- Create account and student session.
- Upload a sales workbook.
- Inspect mapping and explanation.
- Ask a supported and unsupported question.
- Review accounting map and reconciliation.
- Export MISA and anonymized internship output.
- Confirm no global mobile overflow.

### 19.4 Accounting acceptance files

- Existing real 1,930-row sales sample and MISA reference.
- Existing BAE purchase sample and purchase template.
- Synthetic files with date, amount, VAT, duplicate and grouping errors.
- Synthetic confidential data for anonymization tests.

## 20. Completion Criteria

The program is complete through Phase 6 only when:

- all seven releases A-G are implemented and independently flaggable;
- profile and session ownership are enforced for users and workspaces;
- raw file retention is automated and tested;
- every deterministic explanation and answer is evidence-backed;
- AI offline does not break deterministic functionality;
- accounting-map suggestions remain traceable and reviewable;
- reconciliation handles supported modules and labels insufficient data;
- internship outputs contain no unapproved confidential values;
- existing converter and admin flows remain operational;
- full backend, converter, frontend and browser QA passes;
- the `ke-toan` review records no unresolved Critical/High accounting finding.

## 21. Explicit Non-Goals

- Phase 7 lecturer/classroom dashboard.
- Full LMS, video course or curriculum delivery.
- Generic unrestricted accounting chatbot.
- OCR/PDF invoice extraction in this program.
- Direct posting into MISA by API or RPA.
- Full payroll, fixed-assets, manufacturing-costing or public-accounting engines.
- Full general-ledger posting engine.
- Automated legal compliance certification.
- Complete internship report or thesis generation.
- Public sharing of student or company data.

## 22. Required Implementation Decomposition

This master design must be implemented as separate plans:

```text
Plan 0  Student ownership, session and privacy foundation
Plan 1  Explain My File
Plan 2  Ask About This File
Plan 4  Voucher and Accounting Map
Plan 5  Reconciliation and Control
Plan 6  Internship Assistant
```

Plan N may begin implementation only after all required interfaces from earlier
plans are merged or available in the same isolated implementation branch.
