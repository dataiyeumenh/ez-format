# EzFormat Accounting Operations Assistance Design

**Date:** 2026-07-26  
**Status:** Proposed detailed design  
**Scope:** Mapping Profile V2, anomaly detection, bulk correction, optional reconciliation, source-backed accounting assistant  
**Primary users:** Accounting staff, interns and non-specialist users preparing Excel data for MISA  
**Product position:** Operational support and data preparation, not learning, grading or legal certification

## 1. Executive Summary

EzFormat will extend its existing Excel-to-MISA conversion flow with five related
capabilities:

1. remember mappings by real source and template version;
2. detect suspicious data before export;
3. let users review and apply safe corrections in bulk;
4. optionally reconcile one primary workbook with up to two comparison workbooks;
5. answer accounting-file questions only from verifiable evidence.

The design is deterministic-first. FastAPI remains the source of truth for
workbook parsing, calculations, validation, corrections, reconciliation and MISA
export. Node and MongoDB own authentication, workspace permissions and durable
profile metadata. Local AI is optional and only explains or phrases evidence
already selected by the backend.

The normal converter remains usable when every new feature is disabled or AI is
offline.

## 2. Problem Statement

### 2.1 Real user pain points

- A recurring source file may change column order, labels or data shape, causing
  the old mapping to become unreliable.
- One formatting error can appear in hundreds of rows, but users currently have
  to inspect and correct rows individually.
- Deterministic validation catches known errors but does not clearly separate
  definite errors from unusual patterns that only need review.
- Users frequently need to compare invoice exports, internal records and the
  prepared MISA data, but the identifiers available in each file vary.
- Non-specialist users can see an issue but may not understand why it matters,
  how the result was calculated or which source row supports the answer.

### 2.2 Product outcome

After uploading a raw workbook, a user can:

```text
identify the correct source-aware mapping
-> inspect definite issues and suspicious patterns
-> preview and apply selected bulk corrections
-> optionally compare independent files
-> ask evidence-backed questions
-> revalidate
-> export the real MISA template
```

## 3. Goals And Non-Goals

### 3.1 Goals

- Reduce repeated manual mapping and correction work.
- Preserve accounting safety through explicit review and provenance.
- Keep raw workbooks immutable.
- Make every change previewable, reversible and auditable.
- Make optional features fail independently from the conversion critical path.
- Support 10,000-row files comfortably and define a measurable 50,000-row
  performance envelope.
- Provide accessible desktop and mobile workflows consistent with the existing
  EzFormat visual language.

### 3.2 Non-goals

- No autonomous tax or account-code decisions.
- No automatic deletion or merging of suspected duplicates.
- No general ledger, inventory-costing or ERP replacement.
- No legal-compliance certification.
- No grading, scoring, attempts or classroom workflow.
- No training on customer workbook content.
- No AI access to an entire workbook by default.

## 4. Non-Negotiable Invariants

```text
AI cannot apply a correction.
AI cannot change validation severity or blocking scope.
AI cannot override an export blocker.
AI cannot save or activate a mapping profile.
AI cannot decide VAT eligibility or account codes without deterministic evidence.
Raw workbook bytes and parsed raw cells remain immutable.
Every correction produces a new derived revision.
Every bulk change requires a before/after preview and explicit confirmation.
Statistical anomalies never block MISA export.
Optional comparison files cannot break the primary conversion flow.
Frontend state cannot bypass backend revalidation before export.
Every file-grounded answer must cite a valid evidence packet.
Blank remains distinct from zero.
Codes and document identifiers preserve leading zeroes.
All sessions and profiles are bound to user_id + workspace_id + upload_id.
```

## 5. User Roles And Permissions

### 5.1 Standard user

- Upload and process files within their owner scope.
- Review mappings, anomalies, corrections and reconciliation.
- Create draft profiles and request activation through explicit confirmation.
- Ask questions about active sessions.
- Export when existing readiness rules allow it.

### 5.2 Workspace owner/admin

- Review, activate, suspend and supersede workspace mapping profiles.
- Approve high-risk defaults for shared profiles.
- View privacy-safe audit metadata.
- Cannot access raw workbook content without an existing workspace permission.

### 5.3 Service boundaries

- Node verifies identity and owner scope.
- FastAPI verifies signed session context and owns data operations.
- MongoDB stores durable metadata, not raw workbook rows.
- AI Gateway receives only bounded, redacted evidence.

## 6. End-To-End Product Flow

### 6.1 Converter wizard

```text
1. Tải file
   - one primary workbook
   - select MISA target or allow detection
   - optionally add comparison files later

2. Ghép cột
   - profile match and schema drift status
   - mapping table and source evidence
   - explicit confirmation

3. Kiểm tra dữ liệu
   - deterministic validation
   - anomaly groups
   - bulk correction proposals

4. Đối chiếu (optional)
   - add up to two comparison files
   - review matched, missing and conflicting records

5. Xem trước
   - derived MISA rows
   - revision and reconciliation summary

6. Tải MISA
   - backend revalidates
   - warning acknowledgement remains required
   - real MISA template is copied and filled
```

The optional reconciliation step displays `Bỏ qua` and never prevents users from
reaching preview unless they explicitly configure a reconciliation-only control.

### 6.2 Session lifecycle

```text
created
-> analyzed
-> mapping_confirmed
-> revision_active
-> reviewed
-> exported

Side states: expired | deleted | converter_unavailable
```

## 7. System Architecture

```text
React frontend
|-- direct workbook upload --------------------------> FastAPI
|-- auth/workspace/profile requests -----------------> Node/Express
|-- short-lived signed session context <------------- Node/Express
|
Node/Express + MongoDB
|-- authentication and owner scope
|-- mapping profile versions and approval state
|-- correction/reconciliation audit metadata
|-- runtime feature capabilities
|
FastAPI converter
|-- parse each workbook once
|-- normalized session and revision store
|-- readiness and anomaly registries
|-- correction patch simulation/apply/undo
|-- reconciliation indexes and reports
|-- evidence packet generation
|-- real-template MISA export
|
Local AI Gateway
`-- optional wording or explanation over selected evidence only
```

### 7.1 Critical path

Analyze, mapping, validation, preview and export must not depend on Node proxying
workbook bytes or AI availability.

### 7.2 Parse-once rule

Each uploaded workbook is parsed once into an immutable normalized table. Later
operations use indexes and revision overlays. Undo changes the active revision;
it does not reparse the workbook.

### 7.3 Local AI improvement strategy

All model inference is routed through the AI Gateway running on the user's local
machine. Render/VPS hosts conversion and application services but does not host
the model. Ollama remains bound to `127.0.0.1`; only the authenticated AI Gateway
is reachable through the configured ZeroTier or HTTPS tunnel.

Local AI is outside the conversion critical path. Analyze, validation, anomaly
detection, correction, reconciliation, preview and export remain deterministic
FastAPI operations. AI runs only after an explicit user action such as
`Dùng AI hỗ trợ` or `Hỏi về file này`.

#### 7.3.1 Specialized mapping assistance

The mapping assistant receives only:

- target template ID, version and field definitions;
- normalized source headers and inferred data types;
- a small redacted sample selected by FastAPI;
- deterministic mapping candidates and scores;
- approved owner-scoped nearby profiles;
- relevant accounting/MISA knowledge snippets.

It ranks existing candidates and returns schema-constrained JSON with mapping,
reason, evidence and uncertainty. It cannot invent target fields, save profiles
or apply mappings. FastAPI validates field existence, required columns, data
types and forbidden defaults before showing the proposal to the user.

#### 7.3.2 `ke-toan` knowledge retrieval

Convert approved `ke-toan` knowledge into a versioned local knowledge base. Each
entry records:

```json
{
  "id": "stable-id",
  "topic": "misa_purchase_import",
  "content": "approved bounded excerpt",
  "source_type": "official_legal|misa_document|university_material",
  "source_url": "https://...",
  "effective_from": "ISO-date|null",
  "effective_to": "ISO-date|null",
  "verified_at": "ISO-date",
  "supersedes": "stable-id|null"
}
```

Retrieval filters by topic, document type, target template and effective period
before ranking snippets. MISA documents guide software usage; they are not legal
authority. University materials explain concepts; they are not legal authority.
Tax/legal statements require an official source whose effective period covers
the transaction context.

`update-ke-toan` refreshes this corpus through a reviewed update workflow. Stale
knowledge is superseded first. Physical deletion requires verified replacement,
source comparison and explicit approval so historical decisions remain auditable.

#### 7.3.3 Evidence-backed assistant pipeline

```text
User question
-> deterministic intent routing
-> FastAPI selects bounded evidence
-> knowledge retrieval selects approved snippets
-> EvidencePacket is sealed with session/revision hash
-> Local AI produces wording only
-> FastAPI validates values and citations
-> answer or unsupported response
```

AI receives neither unrestricted workbook access nor authority to retrieve a
different session. Cell text is quoted as data and cannot become instructions.

#### 7.3.4 Feedback memory and future fine-tuning

Learning priority:

```text
confirmed Mapping Profile V2
-> deterministic alias/rule improvements
-> anonymized correction dataset
-> optional LoRA/QLoRA fine-tuning after quality threshold
```

Store the difference between an AI proposal and the explicitly confirmed result,
plus template/source fingerprints and rule IDs. Do not store raw customer rows,
names, tax identifiers, bank details or document values in the training dataset.

Usage count alone is not a positive label. A sample becomes training-eligible
only after explicit confirmation and successful deterministic validation. A
future adapter must be versioned, benchmarked against the current model and
rollbackable. Fine-tuning never transfers severity or export authority to AI.

#### 7.3.5 Performance controls

- Use a configurable quantized model suitable for the local GPU/CPU budget.
- Keep model selection in environment/config rather than hardcoded application
  logic.
- Cache approved retrieval and mapping context by template version + source
  fingerprint; never cache confidential row values globally.
- Bound headers, samples, evidence items and generated tokens.
- Require schema-constrained JSON and allow at most one repair retry.
- Use explicit connect/read timeouts and circuit breaking.
- Do not call AI automatically during analyze, preview, validation or export.
- Start Ollama and AI Gateway only from the explicit Local AI launcher; do not
  configure Ollama to start with Windows.

AI timeout or offline status returns a capability warning. Deterministic mapping,
manual correction and export remain available.

#### 7.3.6 Gateway security

```text
Render/VPS
-> authenticated HTTPS tunnel or ZeroTier private route
-> local AI Gateway
-> Ollama at 127.0.0.1
```

The Gateway requires bearer authentication, request-size limits, rate limits,
timeouts and sanitized request IDs. It rejects unknown origins/services where
deployment topology permits. Logs contain metadata and timing only, never full
rows or prompts. Tokens are stored in deployment secrets and local protected
configuration, not committed files or frontend environment variables.

#### 7.3.7 Evaluation and release gates

Maintain a versioned benchmark containing:

- at least 100 purchase-source schema scenarios;
- supported sales-source scenarios;
- exact and drifted Mapping Profile V2 cases;
- Vietnamese and English header aliases;
- ambiguous columns that must remain unresolved;
- prompt-injection and fabricated-citation cases;
- AI offline, timeout and invalid-JSON cases;
- local and production-to-local latency measurements.

Required metrics:

```text
required-field mapping precision and recall
wrong high-risk mapping count
valid JSON response rate
citation validity rate
unsupported-answer correctness
fabricated value/citation count
p50/p95 end-to-end latency
fallback success rate
```

Hard release gates:

```text
0 fabricated source rows or citations
0 AI severity/export-gate overrides
0 cross-owner evidence access
0 silent high-risk mapping application
100% deterministic fallback availability when AI is offline
```

Rollout order:

```text
Gateway contract and capability health
-> versioned `ke-toan` retrieval
-> user-triggered mapping assistant
-> source-backed Q&A wording
-> anonymized feedback dataset
-> optional fine-tuned adapter after benchmark approval
```

## 8. Shared Domain Contracts

### 8.1 NormalizedSession

```json
{
  "session_id": "uuid",
  "upload_id": "uuid",
  "user_id": "mongo-id",
  "workspace_id": "mongo-id|null",
  "owner_scope": "workspace:<id>|user:<id>",
  "target_template_id": "misa_purchase_domestic",
  "target_template_version": "sha256",
  "source_signature": {},
  "primary_table_id": "uuid",
  "active_revision": 3,
  "created_at": "ISO-8601",
  "expires_at": "ISO-8601"
}
```

### 8.2 Derived revision

```json
{
  "revision": 3,
  "parent_revision": 2,
  "patch_set_id": "uuid",
  "state_hash": "sha256",
  "created_by": "user:<id>",
  "created_at": "ISO-8601"
}
```

Only overlays and provenance are stored. Raw values remain addressable for
before/after comparison.

### 8.3 ValidationIssue

Severity and blocking behavior are independent:

```json
{
  "id": "stable-id",
  "rule_id": "date_normalization_ambiguous",
  "severity": "fatal|blocker|warning|info",
  "blocking_scope": "system|reconciliation|export|none",
  "deterministic": true,
  "row_id": "stable-row-id",
  "field": "Ngày hóa đơn",
  "actual": "01/02/26",
  "expected": null,
  "evidence_ids": ["evidence-id"],
  "correction_eligibility": "safe|review_required|forbidden"
}
```

Statistical rules always use `blocking_scope: none`.

### 8.4 Runtime capabilities

Frontend renders backend capabilities instead of assuming deployments expose
every feature:

```json
{
  "mapping_profile_v2": true,
  "anomaly_detection": true,
  "bulk_correction": true,
  "reconciliation": true,
  "accounting_assistant": true,
  "ai_explanation": false,
  "limits": {
    "comparison_files": 2,
    "raw_ttl_minutes": 60,
    "max_rows_per_file": 50000
  }
}
```

## 9. Feature 1 - Source-Aware Mapping Profile V2

### 9.1 Purpose

Remember confirmed mapping behavior for a specific data source without applying
an old mapping to a structurally different workbook.

### 9.2 Profile identity

```text
owner_scope
+ source_family
+ document_type
+ normalized_header_fingerprint
+ data_shape_fingerprint
+ target_template_id
+ target_template_version
```

`source_family` is user-confirmed or deterministically inferred from stable
signals such as sheet naming, exporter markers and headers. File names alone are
not identity.

### 9.3 Fingerprints

- Header fingerprint: normalized labels, duplicate-label positions and column
  count; insensitive to column order only when mappings remain unambiguous.
- Data-shape fingerprint: bounded type/blankness/cardinality patterns; never raw
  customer values.
- Template version: hash of canonical MISA template schema and required columns.

### 9.4 Match tiers

| Tier | Condition | Behavior |
|---|---|---|
| Exact | all identity fields match | preselect profile, still show preview |
| Compatible | header aliases/order differ safely; data shape stable | suggest profile with drift summary |
| Review | required/ambiguous columns changed | never apply until user confirms |
| Rejected | source/document/template conflicts | do not offer as usable profile |

Usage count does not raise confidence. Confidence increases only after an
explicitly confirmed successful use whose export completes.

### 9.5 Lifecycle

```text
draft -> active -> superseded
           `----> suspended
```

- Versions are immutable.
- Editing creates a new draft version.
- Only one active version may exist for one exact profile identity.
- Activating a new version atomically supersedes the previous active version.
- AI cannot create, save, activate or restore a profile.

### 9.6 MongoDB model

```json
{
  "ownerScope": "workspace:<id>",
  "profileKey": "sha256",
  "profileFamilyId": "uuid",
  "version": 4,
  "status": "draft|active|suspended|superseded",
  "name": "Hóa đơn mua vào từ nhà cung cấp A",
  "sourceFamily": "invoice_export_x",
  "documentType": "purchase_goods",
  "headerFingerprint": "sha256",
  "dataShapeFingerprint": "sha256",
  "targetTemplateId": "misa_purchase_domestic",
  "targetTemplateVersion": "sha256",
  "mapping": {},
  "defaults": {},
  "formulas": {},
  "riskFlags": [],
  "confirmationCount": 7,
  "lastConfirmedAt": "ISO-8601",
  "createdBy": "ObjectId",
  "approvedBy": "ObjectId|null",
  "createdAt": "ISO-8601"
}
```

Unique index:

```text
ownerScope + profileFamilyId + version
```

Partial unique index for active versions:

```text
ownerScope + profileKey where status = active
```

### 9.7 API

```http
POST /api/mapping-profiles/v2/match
POST /api/mapping-profiles/v2
POST /api/mapping-profiles/v2/:id/versions
POST /api/mapping-profiles/v2/:id/activate
POST /api/mapping-profiles/v2/:id/suspend
GET  /api/mapping-profiles/v2?owner_scope=...
GET  /api/mapping-profiles/v2/:id/history
```

Activation requires profile state hash, expected previous version and owner
permission to avoid lost updates.

### 9.8 UI design

Placement: top of wizard step `Ghép cột`.

```text
+------------------------------------------------------------------+
| Mapping cho nguồn này                              [Đổi profile] |
| Hóa đơn mua vào - Nhà cung cấp A      Đã xác nhận 7 lần           |
| Khớp 31/33 cột | Template MISA v3 | Cập nhật 12/07/2026           |
| ! 2 thay đổi cấu trúc cần xem                                      |
| [Xem thay đổi]                           [Dùng profile và xem trước]|
+------------------------------------------------------------------+
```

Profile selector is a right-side drawer on desktop and full-screen sheet on
mobile. Each profile card shows source family, document type, template, match
tier, drift count, status and last confirmation. It never shows one opaque AI
confidence percentage as proof of correctness.

`Xem thay đổi` opens a three-column drift table:

```text
Trường cũ | File hiện tại | Hành động đề xuất
```

Risky defaults use an amber strip and remain unchecked until user confirmation.
Profile activation uses a confirmation dialog summarizing scope and fields; no
generic browser alert.

### 9.9 Empty/error states

- No profile: `Chưa có setting phù hợp. EzFormat sẽ tạo mapping mới.`
- Suspended profile: visible to owner/admin but never selectable for conversion.
- Template changed: show mandatory drift review.
- Node unavailable: continue with heuristic mapping; disable durable profile save.

### 9.10 Acceptance criteria

- No cross-workspace profile lookup or fallback.
- Exact profile match still requires visible mapping preview.
- Schema drift cannot silently reuse risky fields.
- Successful confirmation creates auditable usage metadata.
- Profile version rollback creates a new version; history is not mutated.

## 10. Feature 2 - Anomaly Detection

### 10.1 Purpose

Surface unusual or potentially wrong rows without pretending that every unusual
business event is an error.

### 10.2 Rule families

#### Deterministic anomalies

- duplicate strong document key;
- conflicting header values inside one invoice;
- unexpected mixed VAT rates for a single-rate target template;
- required identifiers changing within grouped detail rows;
- extreme text length or invalid control characters;
- hidden/formula rows that affect imported totals;
- source/output count or total deltas.

These reuse readiness severity and may block only when an existing deterministic
export rule says so.

#### Statistical anomalies

- amount, quantity or unit-price outliers within a comparable group;
- a previously unseen source code or supplier/customer pattern;
- unusual date gap or transaction volume;
- sharp VAT distribution change compared with the same confirmed source family;
- rare blankness pattern in a normally populated column.

Statistical anomalies are `warning` or `info`, `blocking_scope: none`.

### 10.3 Detection constraints

- Use robust statistics such as median and median absolute deviation when sample
  size is sufficient.
- Declare minimum sample size per rule.
- Compare only within meaningful groups: source family, document type, currency
  and relevant item/supplier group.
- Never compare customer workbooks across owner scopes.
- Explain the observed baseline and threshold.
- Do not call a new value invalid merely because it is rare.

### 10.4 Rule registry

```json
{
  "rule_id": "unit_price_robust_outlier",
  "version": 1,
  "type": "statistical",
  "minimum_sample_size": 20,
  "group_by": ["item_code", "currency"],
  "severity": "warning",
  "blocking_scope": "none",
  "enabled": true,
  "explanation_template": "Đơn giá khác đáng kể so với ..."
}
```

### 10.5 API

```http
POST /api/v1/sessions/:session_id/anomalies/detect
GET  /api/v1/sessions/:session_id/anomalies?revision=3
POST /api/v1/sessions/:session_id/anomalies/:id/review
```

Review actions:

```text
confirmed_issue | expected_value | corrected | deferred
```

`expected_value` suppresses only the same rule/fingerprint in the active source
profile after explicit user confirmation. It cannot suppress deterministic
blockers.

### 10.6 UI design

Placement: `Kiểm tra dữ liệu` step, beside existing readiness issues.

Header summary:

```text
+----------------+ +----------------+ +----------------+
| 2 lỗi chắc chắn| | 7 cần kiểm tra | | 1,842 dòng ổn  |
+----------------+ +----------------+ +----------------+
```

The issue workspace uses a left filter rail and a main grouped table:

```text
[Tất cả 9] [Lỗi chắc chắn 2] [Bất thường 7] [Đã xem 3]

Nhóm: Đơn giá bất thường - Mã hàng HH001                 4 dòng
Mức tham chiếu: 42.000-48.000 VND | Giá trị cao nhất: 96.000 VND
 [ ] Dòng 25   96.000   +100%   [Xem nguồn] [Đánh dấu đã kiểm tra]
```

Selecting a row opens an evidence drawer containing source sheet/cell, normalized
value, comparison group, calculation, possible impact and safe next action.

Visual language:

- red only for deterministic blockers;
- amber for review-required anomalies;
- blue for informational patterns;
- green only for verified/reconciled states, never merely low risk.

Charts are secondary. A compact distribution plot may appear in the drawer, but
the table and exact values remain the accessible source of truth.

### 10.7 Mobile

Filters become horizontally scrollable chips. Each anomaly becomes a card with
row, field, actual value, reason and one primary action. Evidence opens a full
height bottom sheet.

### 10.8 Acceptance criteria

- Statistical anomaly alone never disables download.
- Every anomaly exposes baseline, method and evidence.
- Insufficient sample produces `not_evaluated`, not `normal`.
- Revisions invalidate stale anomaly results.
- A reviewed anomaly remains traceable in audit metadata.

## 11. Feature 3 - Bulk Correction

### 11.1 Purpose

Correct recurring, safely understood data issues without forcing users to edit
each row while retaining full control and undo.

### 11.2 Workflow

```text
Detect candidates
-> build CorrectionPatchSet
-> user selects patches
-> simulate on active revision
-> show before/after diff and affected totals
-> user confirms
-> atomically create derived revision
-> revalidate and redetect anomalies
-> allow undo by activating parent revision
```

### 11.3 Allowed safe operations

- trim surrounding whitespace;
- normalize Unicode/text form without changing semantic content;
- remove safe control characters;
- normalize an unambiguous date representation;
- normalize an unambiguous numeric representation;
- copy one explicitly selected source field into a target field;
- apply an already confirmed owner-scoped mapping/default;
- standardize exact aliases from configured master data.

Safe patches may be preselected. The user still confirms the complete patch set.

### 11.4 Never automatically corrected

- VAT rate or eligibility;
- debit/credit accounts;
- monetary amount, quantity or unit price;
- ambiguous dates or decimal separators;
- positive/negative signs;
- goods versus service classification;
- fuzzy customer, supplier or item codes;
- suspected duplicate deletion or row merging;
- values inferred only by AI;
- missing values without an approved deterministic source.

These may be displayed as manual review suggestions but cannot become executable
patches without the user explicitly defining the replacement.

### 11.5 Patch contract

```json
{
  "patch_set_id": "uuid",
  "session_id": "uuid",
  "base_revision": 2,
  "base_state_hash": "sha256",
  "status": "proposed|simulated|applied|stale|reverted",
  "patches": [
    {
      "patch_id": "uuid",
      "operation": "normalize_date",
      "row_ids": ["r25", "r26"],
      "field": "Ngày hóa đơn",
      "before_fingerprint": "sha256",
      "after_value": "2026-07-01",
      "risk": "safe",
      "selected_by_default": true,
      "evidence_ids": ["e1"]
    }
  ],
  "summary": {
    "affected_rows": 2,
    "affected_fields": 1,
    "amount_delta": "0",
    "vat_delta": "0"
  }
}
```

### 11.6 Concurrency and atomicity

- Simulation and apply require the same `base_revision` and `base_state_hash`.
- Any intervening mapping/correction change makes the patch set `stale`.
- Either every selected patch applies or none applies.
- A failed revalidation keeps the new revision available for inspection but does
  not silently mark it ready.
- Undo activates the parent revision and records a new audit event; it does not
  delete history.

### 11.7 API

```http
POST /api/v1/sessions/:session_id/corrections/propose
POST /api/v1/sessions/:session_id/corrections/simulate
POST /api/v1/sessions/:session_id/corrections/apply
POST /api/v1/sessions/:session_id/revisions/:revision/activate
GET  /api/v1/sessions/:session_id/revisions
```

### 11.8 UI design

Entry button appears above the issue table:

```text
[Sửa hàng loạt 128 ô]   5 nhóm sửa an toàn được tìm thấy
```

Clicking opens a two-stage modal on desktop and full-screen flow on mobile.

#### Stage A - Select corrections

```text
+------------------------------------------------------------------+
| Sửa lỗi hàng loạt                                    Bước 1/2    |
| [x] Xóa khoảng trắng                92 ô   An toàn                |
|     " KH001 " -> "KH001"                                      |
| [x] Chuẩn hóa ngày                  34 ô   An toàn                |
|     "1-7-2026" -> "01/07/2026"                                |
| [ ] Điền mã nhà cung cấp             2 ô   Cần chọn thủ công      |
|                                                                  |
| Không tự động sửa: tiền, thuế suất, tài khoản, dấu âm/dương.      |
|                                      [Hủy] [Xem trước 126 thay đổi]|
+------------------------------------------------------------------+
```

#### Stage B - Preview diff

```text
+------------------------------------------------------------------+
| Xem trước thay đổi                                    Bước 2/2    |
| 126 ô | 124 dòng | Tổng tiền thay đổi: 0 VND                       |
| Dòng | Cột          | Trước        | Sau          | Nguồn         |
| 25   | Mã NCC       | " NCC01 "   | "NCC01"     | Chuẩn hóa     |
| 26   | Ngày hóa đơn | "1-7-2026"  | "01/07/2026"| Quy tắc ngày  |
|                                                                  |
| [ ] Tôi đã xem các thay đổi cần xác nhận thủ công                 |
|                                     [Quay lại] [Áp dụng thay đổi] |
+------------------------------------------------------------------+
```

After apply, a persistent revision banner appears:

```text
Đã áp dụng 126 thay đổi - Phiên bản 3        [Xem chi tiết] [Hoàn tác]
```

### 11.9 Accessibility

- Modal traps focus and returns focus to its trigger.
- Checkboxes have visible labels and affected counts.
- Diff does not rely on red/green alone; `Trước` and `Sau` remain textual.
- Large diff tables support keyboard navigation and virtualization.

### 11.10 Acceptance criteria

- No patch applies before explicit confirmation.
- Raw data remains unchanged and inspectable.
- Stale patch sets return `409`.
- Apply is atomic and produces a new revision.
- Undo restores the exact prior derived state.
- Revalidation runs against the active revision after apply/undo.

## 12. Feature 4 - Optional Three-Way Reconciliation

### 12.1 Purpose

Compare prepared MISA data against independent sources without making extra
files mandatory for conversion.

### 12.2 Upload model

```text
Primary file: required, already uploaded for conversion
Comparison A: optional
Comparison B: optional
```

The user assigns a role to each optional file:

```text
invoice_export | internal_ledger | payment_list | inventory_list | other
```

Role selection changes labels and suggested fields, not accounting truth.

### 12.3 Matching priority

1. Stable source document ID.
2. Seller tax code + invoice symbol + invoice number.
3. Invoice number + date + counterparty + total: candidate only.
4. Name/description similarity: user-confirmed candidate only.

The engine never automatically matches records using only similar amounts.

### 12.4 Tolerances

- Codes, dates and VAT rates: exact after deterministic normalization.
- VND: `1 VND` may be shown as a rounding notice, not silently changed.
- Foreign currency: currency precision, default `0.01`.
- Quantity: target-template precision, default `0.000001`.
- Tolerance configuration is stored with the report and shown in UI.

### 12.5 Report status

```text
not_run
partial
complete
insufficient_evidence
conflict
```

The UI must never say `Khớp 3 nguồn` unless all three roles exist and the report
status is complete.

### 12.6 Reconciliation contract

```json
{
  "report_id": "uuid",
  "session_id": "uuid",
  "revision": 3,
  "status": "partial",
  "roles_present": ["primary", "invoice_export"],
  "summary": {
    "matched": 410,
    "missing_primary": 2,
    "missing_comparison": 3,
    "conflicts": 5,
    "candidates_need_review": 4
  },
  "totals": [],
  "records": [],
  "tolerances": {},
  "state_hash": "sha256"
}
```

### 12.7 Performance design

- Build hash indexes for stable/exact keys.
- Partition by date period and tax code before bounded candidate matching.
- Run fuzzy matching only on unresolved candidates with a strict cap.
- Avoid pairwise `O(n^2)` comparisons.
- Parse each comparison file once and expire it with the session TTL.

### 12.8 API

```http
POST   /api/v1/sessions/:session_id/comparison-files
DELETE /api/v1/sessions/:session_id/comparison-files/:file_id
POST   /api/v1/sessions/:session_id/reconciliation/run
GET    /api/v1/sessions/:session_id/reconciliation/:report_id
POST   /api/v1/sessions/:session_id/reconciliation/:report_id/matches/:id/confirm
```

### 12.9 UI design

Placement: optional wizard step `Đối chiếu` after data review.

#### Empty state

```text
+------------------------------------------------------------------+
| Đối chiếu với file khác (không bắt buộc)                          |
| So sánh file đang chuyển đổi với hóa đơn, sổ nội bộ hoặc thanh toán|
| để tìm thiếu, trùng và chênh lệch.                                |
|                                                                  |
| [+ Thêm file đối chiếu]                         [Bỏ qua bước này] |
+------------------------------------------------------------------+
```

#### Files present

```text
Nguồn chính             Hóa đơn đầu vào          Thanh toán
[raw_purchase.xlsx]  <-> [invoice_export.xlsx] <-> [Chưa thêm]
1,930 dòng              420 hóa đơn               [+ Thêm file]
```

#### Result screen

```text
+----------+ +----------+ +----------+ +------------------+
| Khớp 410 | | Thiếu 5  | | Lệch 5  | | Cần xác nhận 4   |
+----------+ +----------+ +----------+ +------------------+

[Tất cả] [Thiếu] [Chênh lệch] [Cần xác nhận]
Số HĐ | Nhà cung cấp | Nguồn chính | Đối chiếu | Chênh lệch | Trạng thái
```

Selecting a record opens a side-by-side evidence drawer with one column per
present source. Missing roles show `Chưa cung cấp`, never a zero value.

Candidate matches require explicit `Xác nhận ghép` or `Không phải cùng chứng từ`.
The UI shows why a candidate was suggested and which exact fields differ.

### 12.10 Failure states

- Invalid optional file: show error on that file card; primary conversion remains
  active.
- Expired comparison: report becomes stale; ask user to re-upload only that file.
- Unsupported schema: show `Không đủ trường để đối chiếu tự động` and permit
  manual field selection.
- Converter timeout: keep uploaded-file metadata and allow retry.

### 12.11 Acceptance criteria

- Normal export remains possible when reconciliation is not run.
- Two-source reports use `partial`, never `complete three-way` wording.
- Candidate and fuzzy matches never become confirmed automatically.
- Every delta links to exact source records and operands.
- Optional-file failures do not alter the primary revision.

## 13. Feature 5 - Source-Backed Accounting Q&A

### 13.1 Purpose

Help users understand the active file, mappings, calculations and MISA issues
without presenting unsupported AI output as accounting truth.

### 13.2 Pipeline

```text
Question
-> deterministic intent routing
-> bounded retrieval within active session/revision
-> server-generated EvidencePacket
-> optional AI wording
-> server citation and value validation
-> answer or explicit unsupported response
```

### 13.3 Supported intent families

```text
file_summary
mapping_explanation
locate_rows
required_fields
issue_explanation
amount_calculation
vat_calculation
duplicate_summary
anomaly_explanation
reconciliation_explanation
actions_before_export
misa_import_guidance
unsupported_business_or_legal_judgment
```

### 13.4 EvidencePacket

```json
{
  "packet_id": "uuid",
  "session_id": "uuid",
  "revision": 3,
  "state_hash": "sha256",
  "expires_at": "ISO-8601",
  "items": [
    {
      "evidence_id": "e1",
      "type": "file_cell|calculation|misa_document|legal_source|ai_suggestion",
      "label": "Dòng 25 - Tiền thuế GTGT",
      "locator": {"sheet": "Data", "row": 25, "column": "Tiền thuế GTGT"},
      "value": "100000",
      "source_url": null,
      "effective_from": null,
      "effective_to": null
    }
  ]
}
```

Permitted evidence:

- file sheet/row/column in the active session;
- backend Decimal calculation and explicit operands;
- MISA documentation URL;
- official legal source with effective period;
- AI suggestion explicitly labeled `Cần kiểm tra`, never treated as proof.

Excel cell content is data, not prompt instructions.

### 13.5 Answer contract

```json
{
  "answer_id": "uuid",
  "answer": "Tiền thuế tại dòng 25 lệch 20.000 VND so với phép tính...",
  "status": "answered|unsupported|ai_unavailable",
  "answer_type": "deterministic|ai_worded|unsupported",
  "confidence": "verified|needs_review|unsupported",
  "evidence_packet_id": "uuid",
  "citations": ["e1", "e2"],
  "needs_professional_review": false,
  "unsupported_reason": null,
  "suggested_actions": []
}
```

The server rejects an AI response when it cites unknown evidence, introduces an
unseen value, uses an expired legal source outside its effective period, or
references another session/revision.

### 13.6 AI boundary

AI may:

- rephrase verified calculations in plain Vietnamese;
- summarize selected evidence;
- classify an unrecognized question intent;
- explain MISA terminology from approved source snippets.

AI may not:

- retrieve unrestricted workbook rows;
- generate a missing amount or identifier;
- apply corrections or activate profiles;
- decide severity, readiness, VAT eligibility or account correctness;
- answer from a previous session packet.

### 13.7 UI design

Entry: persistent `Hỏi về file này` button in the converter workspace after
analysis. Desktop opens a 420 px right drawer; mobile opens a full-screen panel.

```text
+------------------------------------------+
| Hỏi về file này                     [x] |
| Dữ liệu: raw_purchase.xlsx - Phiên bản 3|
| AI diễn giải: Ngoại tuyến                |
|------------------------------------------|
| Gợi ý                                    |
| [Tôi cần sửa gì trước khi tải?]          |
| [Vì sao dòng 25 bị cảnh báo thuế?]       |
| [Có bao nhiêu hóa đơn chưa đối chiếu?]   |
|------------------------------------------|
| Bạn: Vì sao tổng tiền lệch?              |
| EzFormat: Tổng chi tiết thấp hơn tổng... |
| [1] Dòng 25  [2] Phép tính tổng          |
| Cần kiểm tra lại nghiệp vụ nếu có phí... |
|------------------------------------------|
| [Nhập câu hỏi về file...]          [Gửi]|
+------------------------------------------+
```

Citation chips are buttons. Clicking one closes or narrows the drawer and
navigates to the relevant mapping cell, source row, issue or reconciliation
record. External sources open in a new tab with safe `rel` attributes.

AI status wording:

- AI online: `AI đang hỗ trợ diễn giải; kết quả vẫn dựa trên dữ liệu và quy tắc.`
- AI offline: `AI diễn giải đang ngoại tuyến. Tra cứu và phép tính xác định vẫn hoạt động.`
- Unsupported: `Chưa đủ dữ liệu để kết luận. Hãy kiểm tra với kế toán phụ trách.`

No animated typing indicator persists after the backend has returned. Streaming
is optional and cannot hide citation validation.

### 13.8 Privacy

- AI receives only evidence selected by FastAPI.
- Personal, banking and tax identifiers are masked before external transmission.
- Full prompts, rows and answers containing customer values are not logged.
- Questions and evidence packets expire with the raw session by default.
- No customer question/file content is used for model training.

### 13.9 Acceptance criteria

- Every file-specific answer has valid citations.
- Citation navigation resolves to the active revision.
- AI timeout falls back to deterministic answer or explicit unsupported state.
- Prompt injection placed in Excel cells cannot change tool or system behavior.
- Cross-session/cross-workspace evidence is rejected.

## 14. Unified UI Information Architecture

### 14.1 Desktop layout

```text
+--------------------------------------------------------------------------------+
| Navbar                                                                         |
+--------------------------------------------------------------------------------+
| File/session header | template | profile status | revision | service status    |
+--------------------------------------------------------------------------------+
| Wizard steps                                                                    |
+------------------+-------------------------------------------------------------+
| Context/filter   | Main working table, preview or reconciliation               |
| rail             |                                                             |
|                  |                                                             |
+------------------+------------------------------------------+------------------+
| Sticky summary/actions                                   [Preview] [Tải MISA]  |
+--------------------------------------------------------------------------------+
                                                     Q&A opens as right drawer -->
```

The existing converter remains the primary workspace. New features extend its
steps and drawers; they do not create five disconnected top-level pages.

### 14.2 Mobile layout

- One content column.
- Wizard labels shorten while preserving accessible names.
- Sticky bottom action bar keeps primary action visible.
- Filters become chips; large tables become summary cards with detail sheets.
- Bulk correction and Q&A use full-screen dialogs.
- Horizontal table scrolling is allowed only where row/column comparison is
  essential; first identifier column remains sticky.

### 14.3 State completeness

Every new surface implements:

```text
loading
empty
partial
success
needs_review
blocked
stale_revision
permission_denied
optional_service_offline
converter_unavailable
expired_session
```

### 14.4 Design language

- Preserve EzFormat blue/slate base and rounded card language.
- Use a quiet off-white/blue gradient page background, not flat gray.
- Use one expressive display style already present in the product; do not add a
  new font solely for these features.
- Reserve red for deterministic failure/blocker.
- Reserve green for confirmed success.
- Use amber for human review.
- Use blue for information and selected state.
- Avoid badges that duplicate card titles or repeat the same status.
- Motion is limited to drawer/modal transitions and a short staggered reveal of
  newly computed summary cards; respect `prefers-reduced-motion`.

### 14.5 Accessibility

- WCAG-compatible color contrast.
- All status meaning available as text, not color alone.
- Keyboard-operable drawers, dialogs, tables and tabs.
- Focus is restored after modal/drawer close.
- Live regions announce analysis completion, patch apply and reconciliation
  completion without reading entire tables.
- Error summaries link to the first actionable control.
- Virtualized rows retain programmatic row/column labels.

## 15. API Surface Summary

### 15.1 Node/Express

```http
GET  /api/converter/capabilities
POST /api/converter/sessions
POST /api/mapping-profiles/v2/match
POST /api/mapping-profiles/v2
POST /api/mapping-profiles/v2/:id/versions
POST /api/mapping-profiles/v2/:id/activate
POST /api/mapping-profiles/v2/:id/suspend
GET  /api/mapping-profiles/v2/:id/history
```

### 15.2 FastAPI converter

```http
POST   /api/v1/uploads/analyze
POST   /api/v1/mappings/preview
POST   /api/v1/mappings/validate
POST   /api/v1/sessions/:id/anomalies/detect
GET    /api/v1/sessions/:id/anomalies
POST   /api/v1/sessions/:id/corrections/propose
POST   /api/v1/sessions/:id/corrections/simulate
POST   /api/v1/sessions/:id/corrections/apply
POST   /api/v1/sessions/:id/revisions/:revision/activate
POST   /api/v1/sessions/:id/comparison-files
DELETE /api/v1/sessions/:id/comparison-files/:file_id
POST   /api/v1/sessions/:id/reconciliation/run
GET    /api/v1/sessions/:id/reconciliation/:report_id
POST   /api/v1/sessions/:id/questions
POST   /api/v1/conversions/export
```

Every mutating request includes `revision` and `state_hash`. Stale state returns
`409`. Validation/export policy errors return `422`. Missing/expired sessions
return `404` or `410` without revealing another owner's resource.

## 16. Persistence And Retention

### 16.1 MongoDB stores

- immutable mapping profile versions;
- profile activation/suspension audit;
- privacy-safe correction metadata;
- reconciliation report metadata and aggregate counts;
- question outcome metadata without full confidential evidence;
- session ownership and expiry metadata.

### 16.2 FastAPI temporary storage

- raw workbook bytes;
- normalized immutable tables;
- revision overlays;
- anomaly and reconciliation indexes;
- evidence packets.

Default raw and parsed session TTL: 60 minutes. A deployment may lower this
value. Extending it requires an explicit retention policy and UI disclosure.

### 16.3 Audit event examples

```text
mapping_profile_version_created
mapping_profile_activated
mapping_profile_suspended
anomaly_reviewed
correction_patch_simulated
correction_patch_applied
revision_activated
reconciliation_run
candidate_match_confirmed
assistant_question_answered
assistant_question_unsupported
```

Audit events store identifiers, counts, rule IDs and state hashes, not raw rows.

## 17. Security And Privacy

- Short-lived signed session context includes user, workspace, upload, allowed
  operations and expiry.
- IDs alone never authorize access.
- Direct upload URLs and converter sessions are owner-bound.
- Validate Excel extension, MIME/magic, size, sheet count and decompression ratio.
- Rate-limit upload, reconciliation and assistant endpoints independently.
- Formula cells, hidden rows and external links are treated as data risks.
- Sanitize file names before display/download.
- Redact identifiers before optional external AI calls.
- Do not log raw workbook rows, full AI prompts, bank accounts, tax identifiers or
  customer/supplier names.
- Delete temporary artifacts on expiry and explicit session deletion.

## 18. Performance Budgets

Baseline must be measured before implementation. New features must not increase
the normal analyze-to-preview path by more than 20% at p95 when optional
reconciliation and AI are unused.

Targets after baseline confirmation:

| Operation | 10k rows | 50k rows |
|---|---:|---:|
| Analyze + mapping suggestion | <= 8 s | <= 30 s |
| Deterministic anomaly pass | <= 3 s | <= 12 s |
| Patch simulation, 1k patches | <= 2 s | <= 5 s |
| Patch apply + revalidate | <= 5 s | <= 18 s |
| Two-source exact reconciliation | <= 5 s | <= 20 s |
| Three-source exact reconciliation | <= 8 s | <= 30 s |

These are service-side processing targets under the benchmark environment, not
network guarantees. The UI must show phase progress and allow cancellation of
optional reconciliation.

## 19. Feature Flags And Rollout

```text
FEATURE_MAPPING_PROFILE_V2
FEATURE_ANOMALY_DETECTION
FEATURE_BULK_CORRECTION
FEATURE_RECONCILIATION
FEATURE_ACCOUNTING_ASSISTANT
```

### 19.1 Delivery order

1. Shared contracts, signed scope, normalized revision and capabilities.
2. Mapping Profile V2 and owner isolation.
3. Anomaly registry and deterministic/statistical separation.
4. Bulk correction simulation, apply and undo.
5. Optional two-/three-source reconciliation.
6. Evidence packet and source-backed Q&A.

Each feature can be disabled independently. Disabling a feature hides its entry
point and preserves the existing converter behavior.

### 19.2 Profile migration

- Existing profiles are read-only candidates during migration.
- Migrate only profiles with a valid owner scope and target template.
- Missing data-shape fingerprint produces a V2 draft requiring confirmation.
- Never auto-activate migrated high-risk defaults.
- Keep a rollback path to V1 lookup until V2 acceptance tests pass, but never
  allow V1 cross-workspace fallback.

## 20. Testing Strategy

### 20.1 Unit tests

- fingerprint stability and schema drift classification;
- profile lifecycle and immutable version rules;
- anomaly minimum sample, robust threshold and non-blocking invariant;
- patch eligibility, simulation, atomic apply, stale rejection and undo;
- exact reconciliation keys, candidate matching and tolerance behavior;
- evidence packet creation, expiry, citation and cross-session rejection;
- Decimal calculations and preservation of blank/zero/leading zeroes.

### 20.2 Integration tests

- profile exact match -> preview -> confirmation -> export -> confirmation count;
- compatible profile -> drift review -> new version activation;
- anomaly -> bulk correction -> new revision -> revalidation;
- optional file invalid -> primary preview/export still works;
- two-source report remains partial;
- three-source complete report uses all present source roles;
- AI timeout -> deterministic assistant answer or unsupported response;
- backend export rejects stale frontend readiness.

### 20.3 Security tests

- cross-user/workspace profile and session access;
- forged/expired signed context;
- prompt injection in cell content;
- malicious file names, formula links and oversized workbook structures;
- evidence ID guessing and cross-revision citation;
- logs contain no configured sensitive test markers.

### 20.4 Performance tests

Fixtures:

```text
10k primary rows
50k primary rows
10k x 3 source files
50k x 3 source files
1k and 10k correction patches
high unresolved-candidate reconciliation case
```

Measure parse count, CPU time, memory peak, p50/p95 latency and payload size.
Assert no workbook reparse during anomaly, correction or Q&A operations.

### 20.5 UI QA

- desktop at 1366x768 and 1920x1080;
- mobile at 360x800 and 390x844;
- keyboard-only flow;
- screen-reader labels and announcements;
- slow API, empty, partial, offline, stale and expired states;
- 10k-row table virtualization;
- visual regression for all five feature surfaces;
- real browser upload, correction, reconciliation, Q&A and MISA download.

## 21. Extreme Human-Like Accounting QA/QC Production Gate

### 21.1 Gate purpose

This mandatory release gate covers:

1. Mapping Profile V2.
2. Anomaly Detection.
3. Bulk Correction.
4. Optional Three-Way Reconciliation.
5. Source-Backed Accounting Q&A.
6. Local AI.

The gate tests the system as an accounting user would use it, not only through
API contracts. Raw workbooks remain immutable; monetary, VAT, document and MISA
template differences cannot be ignored. AI never decides accounting treatment.
A feature that does not pass remains disabled through its feature flag.

This gate evaluates data integrity, traceability and safe software behavior. It
is not a legal-compliance certificate and cannot claim that MISA will accept
every file in every company configuration.

### 21.2 Independent QA roles

| Role | Responsibility |
|---|---|
| Feature developer | Supplies build, migration, automated tests and known limits |
| QA engineer | Tests contracts, regressions, security and performance |
| Accounting QA subagent | Uses the `ke-toan` skill to test accounting/MISA behavior |
| Red-team reviewer | Attempts wrong mappings, amount corruption, data leaks and authorization bypasses |
| Release owner | Enables feature flags only from complete evidence |

For every release candidate, an independent accounting QA subagent must be
spawned with the `ke-toan` skill. It must not implement the feature it audits.
Its required workflow is:

1. Start from the release build and immutable fixture corpus.
2. Perform the first human-like pass without reading the oracle.
3. Record confusing copy, decisions, mistakes and recovery behavior.
4. Compare the result with the oracle only after the first pass.
5. Classify each finding as:

```text
deterministic_error
accounting_review_required
usability_risk
security_privacy_risk
unsupported_claim
```

6. Record `confidence: high | medium | low` for accounting judgments.
7. Attach `source_url`, effective period and verification date to legal/MISA
   assertions.
8. Never upgrade a warning to a blocker without a deterministic rule.
9. Never modify fixtures or oracle expectations during a gate run.
10. Produce a signed `PASS`, `FAIL` or `CONDITIONAL_FAIL` report.

The subagent complements but does not replace final acceptance testing by a real
MISA user on a representative company configuration.

### 21.3 Human test personas

| Persona | Real pain point to simulate |
|---|---|
| New accountant | Technical column names are unclear; needs safe guidance and undo |
| Experienced MISA accountant | Needs fast mapping, correct template and minimal repetition |
| Chief accountant | Reviews amounts, VAT, duplicate documents and audit trail |
| Data reviewer | Traces each warning to exact workbook evidence |
| Workspace admin | Manages profiles without seeing another workspace's data |
| Remote production user | Local AI is slow, offline or times out while conversion must continue |
| Careless user | Selects the wrong profile, bulk action or optional file |
| Adversarial user | Uploads formulas, prompt injection, corrupt files or crafted identifiers |

Each persona completes at least one end-to-end journey without live guidance
from the feature developer.

### 21.4 Release workbook corpus

Use synthetic or explicitly permitted anonymized data only.

#### Golden workbooks

- Every supported purchase/sales and goods/services MISA template.
- Permitted, anonymized partner examples.
- Representative schemas from the 100+ source-scenario corpus.
- The same source with reordered, renamed, added and removed columns.
- Multiple detail rows belonging to one invoice.
- Vietnamese and English date/number formats.
- Negative values, discounts, VAT 0/5/8/10% and non-taxable markers.
- Supported `.xls` and `.xlsx` variants.

#### Fault-injection workbooks

- Missing required columns.
- Duplicate, shifted or merged headers.
- Hidden rows, columns and sheets.
- Formula cells, external links and text beginning with formula characters.
- Ambiguous dates and decimal separators.
- Duplicate invoice numbers with different amounts.
- Similar amounts belonging to different documents.
- One-VND rounding differences and real amount/VAT mismatches.
- Corrupt, password-protected and unsupported workbooks.
- Prompt injection in headers and cell content.
- PII canaries for leak detection.

#### Reconciliation workbooks

- Primary file only.
- Primary plus one comparison file.
- All three sources present.
- Complete matches, source-specific missing records and conflicts.
- Strong-key duplicates with conflicting content.
- Amount-only similarity without document keys.
- Foreign-currency precision cases.
- 10,000-row and 50,000-row datasets.

### 21.5 Immutable oracle contract

Each case has a versioned manifest:

```json
{
  "fixture_id": "purchase_three_way_001",
  "purpose": "Detect conflicting invoice totals",
  "template_id": "misa_purchase_goods",
  "template_version": "sha256:...",
  "input_hashes": [],
  "expected_profile_match": {},
  "expected_required_mappings": {},
  "expected_issues": [],
  "expected_correction_state_hash": "sha256:...",
  "expected_undo_state_hash": "sha256:...",
  "expected_reconciliation": {},
  "allowed_answer_claims": [],
  "required_evidence": [],
  "forbidden_claims": [],
  "pii_canaries": []
}
```

Oracle rules:

- Amounts, taxes and quantities use `Decimal`.
- Compare exports by cells, styles, merged regions, column widths and template
  fingerprint, not only a binary file hash.
- Ambiguous outcomes remain `review_required`; the oracle does not force a false
  binary answer.
- Someone other than the feature developer approves fixtures and oracles.
- Every oracle change requires rationale, diff and accounting QA sign-off.
- Source priority is official legal text, Ministry of Finance material, official
  MISA documentation, academic material, then practice sources.
- MISA documentation describes product behavior, not legal authority.

### 21.6 Feature-specific production gates

#### A. Mapping Profile V2

Required checks:

- Exact signature selects the expected profile but still shows preview.
- Header drift never silently applies an active profile.
- Similar headers with different data shapes remain distinguishable.
- Another workspace's profile is never suggested.
- Template version change requires renewed confirmation.
- High-risk mappings/defaults are never preapproved.
- AI cannot save or activate a profile.

Pass criteria:

- 100% of required mappings in the golden corpus match the oracle.
- Zero cross-workspace profile exposure.
- Zero silent schema-drift application.
- Ambiguous mappings become explicit user review instead of guesses.

#### B. Anomaly Detection

Required checks:

- Every seeded deterministic anomaly is detected.
- Statistical anomalies remain warning/info with `blocking_scope: none`.
- Statistical outliers never block export.
- Multiple detail rows from one invoice are not mislabeled as duplicate invoices.
- Each issue identifies the correct row, field and document.
- Clean golden workbooks produce no false deterministic blocker.

Pass criteria:

- Seeded deterministic anomaly recall is 100%.
- False deterministic blocker count is zero on the golden corpus.
- Every issue has `code`, `severity`, `blocking_scope` and evidence.
- Statistical detection never mutates data or mapping.

#### C. Bulk Correction

The complete sequence is mandatory:

```text
detect
-> propose
-> select
-> preview before/after
-> confirm
-> atomic apply
-> revalidate
-> undo
```

Required checks:

- No proposal applies before confirmation.
- VAT, accounts, amounts, signs and business classification are not auto-fixed.
- Concurrent revision changes make old patch sets stale.
- Mid-apply failure cannot create partial state.
- Undo restores the exact normalized state hash.
- Raw workbook content remains unchanged.
- Export revalidates the latest active revision.

Pass criteria:

- Zero silent mutations.
- Atomic apply in 100% of fault-injection cases.
- Exact undo state hash in 100% of cases.
- Before/after preview exactly matches selected patches.

#### D. Optional Three-Way Reconciliation

Required checks:

- Conversion/export works without optional files.
- UI never states three-way success when one source is absent.
- Stable document ID and strong invoice key have highest priority.
- Amount-only similarity never auto-matches records.
- Fuzzy matching creates user-confirmed candidates only.
- One-VND policy appears as a rounding notice when applicable.
- Conflicts remain visible even when related records match.
- Large fixtures do not use `O(n^2)` pairwise comparison.

Pass criteria:

- Strong-key match accuracy is 100% against the oracle.
- Automatically accepted ambiguous matches equal zero.
- Report state is exactly one of `not_run`, `partial`, `complete`,
  `insufficient_evidence` or `conflict` as expected.
- Optional-file failure leaves the primary normalized session intact.

#### E. Source-Backed Accounting Q&A

Required checks:

- Citations resolve to the exact active file, sheet, row, column or approved source.
- Calculations use backend results and declared operands.
- Missing evidence returns `Chưa đủ dữ liệu để kết luận.`
- Expired evidence is not used for a later effective period.
- Evidence cannot cross upload, session or workspace boundaries.
- Excel content remains data, never instructions.
- AI does not determine VAT eligibility or account treatment.

Pass criteria:

- Zero invented citations.
- Zero cross-session/workspace evidence leaks.
- Every material accounting claim has valid evidence IDs.
- Zero successful prompt-injection cases.
- Zero forbidden legal-certainty claims.

#### F. Local AI

Required checks:

- Ollama/Gateway offline.
- Timeout, malformed JSON, unavailable model and invalid token.
- Slow or interrupted production-to-local connection.
- Mapping output that violates the response schema.
- Attempts to change severity, remove blockers or activate profiles.
- Payloads containing PII canaries.
- Citations absent from the sealed `EvidencePacket`.

Pass criteria:

- Conversion, validation, correction, reconciliation and export work when AI is
  offline.
- AI is absent from the conversion critical path.
- Invalid AI output is rejected with deterministic/manual fallback.
- PII canaries appear in neither AI request nor logs.
- Ollama port remains non-public.
- AI cannot mutate data or accounting authority.
- AI features can be independently disabled.

### 21.7 Mandatory human-like journeys

The accounting QA subagent performs at least these journeys:

1. Upload a new source -> inspect mapping -> correct mapping -> save a profile.
2. Upload a similar schema -> verify correct profile behavior and drift warning.
3. Detect anomalies -> understand warning -> navigate to the source cell.
4. Select 20+ corrections -> inspect diff -> apply -> undo -> apply again.
5. Upload three sources -> investigate matched, missing and conflict records.
6. Ask about amount/VAT differences -> open evidence -> verify calculation.
7. Stop Local AI mid-session -> continue preview and export.
8. Change workspace -> verify old profile/evidence is unavailable.
9. Complete correction and warning review on mobile.
10. Download MISA -> inspect template structure and control totals.

Record for every journey:

```text
task_completed
incorrect_accounting_action
unintended_mutation
time_to_complete
confusing_copy
missing_evidence
recovery_success
confidence
```

### 21.8 Red-team requirements

Attempt at least:

- cross-workspace ID substitution;
- stale revision replay;
- duplicate export requests;
- correction patch tampering;
- unauthorized profile activation;
- formula injection and external links;
- Excel decompression/workbook bombs;
- workbook prompt injection;
- fabricated evidence IDs;
- stale legal/MISA sources;
- AI token misuse and oversized requests;
- logs/telemetry containing rows, tax IDs, bank accounts or PII;
- races between correction, validation and export.

The red-team corpus cannot contain real customer confidential data.

### 21.9 Performance and resilience gate

Benchmark 10,000 and 50,000 rows with up to three workbooks:

- parse each workbook at most once per session;
- use reconciliation hashes/indexes, never a full Cartesian comparison;
- run fuzzy matching only on a bounded unresolved set;
- keep p95 regression within 20% of the corresponding baseline;
- prevent AI timeout from extending the critical path;
- ensure retries cannot duplicate mutations or audit events;
- verify process restart does not corrupt durable profile/audit state.

### 21.10 Required evidence bundle

Store each gate run under:

```text
.artifacts/qa/<release-id>/
```

Required evidence:

- Git commit SHA and dirty-state report.
- Feature flags and runtime capabilities.
- Runtime and dependency versions obtained from the executed environment.
- Template IDs, versions and hashes.
- Fixture and manifest hashes.
- Exact test commands and raw exit status.
- Unit, integration, E2E, security and performance reports.
- Redacted API/network traces.
- Desktop/mobile screenshots for primary states.
- Cell-level MISA export comparison report.
- Independent accounting QA subagent report.
- Red-team report.
- Source URLs, effective periods and verification dates.
- Open risks and accepted-risk owner.
- Rollback and feature-disable smoke evidence.
- Local AI model identifier and digest obtained from runtime.
- Confirmation that artifacts/logs contain no confidential workbook rows or PII.

Missing evidence means the corresponding test is considered not run.

### 21.11 Release decision

Severity:

```text
P0: data loss/corruption, workspace leak, broken export, blocker bypass
P1: wrong deterministic mapping, wrong amount, broken undo, invented citation
P2: confusing UX, noisy statistical anomaly, minor performance budget breach
P3: cosmetic or informational defect
```

A feature may be enabled only when:

- no P0 or P1 remains;
- all mandatory cases pass three consecutive clean runs;
- no mandatory test is flaky;
- the independent accounting QA subagent signs `PASS`;
- red-team finds no remaining bypass;
- performance budgets pass;
- rollback and feature-disable smoke tests pass;
- the evidence bundle is complete;
- UI copy makes no absolute legal/MISA correctness claim.

If deterministic core passes but Local AI fails:

```text
core deployment may proceed
FEATURE_ACCOUNTING_ASSISTANT=false
AI must not be advertised as available
```

If another feature fails, its feature flag remains off. Accepted risk cannot be
used to bypass a P0 or P1.

### 21.12 Mandatory UI wording review

Allowed:

```text
Không khớp với rule đã cấu hình.
Cần kiểm tra lại nghiệp vụ.
Chưa đủ dữ liệu để kết luận.
Đề xuất của AI - cần người dùng xác nhận.
```

Forbidden:

```text
Đúng luật 100%.
MISA chắc chắn chấp nhận.
Thuế suất này chắc chắn đúng.
Tài khoản này chắc chắn sai.
AI đã tự sửa chính xác.
```

## 22. Product Acceptance Criteria

The program is acceptable when:

- Existing conversion and real-template export remain operational with all new
  flags disabled.
- Profile V2 never crosses owner scopes and never hides schema drift.
- Every applied correction is selected, previewed, confirmed, versioned and
  undoable.
- Statistical anomalies cannot block export.
- Optional comparison files cannot break primary conversion.
- Reconciliation never overstates match completeness.
- Every file-specific assistant answer cites active, valid evidence.
- AI offline does not disable mapping, validation, correction, reconciliation or
  deterministic questions.
- 10k/50k benchmarks satisfy agreed budgets or rollout is blocked with measured
  evidence.
- UI states are complete, responsive and keyboard accessible.

## 23. Deferred Scope

- Automatic VAT eligibility classification from product descriptions.
- Universal debit/credit recommendation engine.
- Cross-company anomaly baselines.
- Automatic duplicate deletion or voucher merging.
- Real-time multi-user editing of one revision.
- Persistent raw workbook storage.
- Full natural-language querying over unrestricted workbook content.

## 24. Source Basis

This design uses MISA documentation as operational guidance, not legal authority:

- MISA AMIS Excel import:
  https://helpact.misa.vn/kb/html_10050000/
- MISA AMIS import error guidance:
  https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/
- MISA SME Excel import:
  https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/

Accounting and tax assertions introduced during implementation must cite an
official source, include effective dates and remain separate from MISA product
instructions.
