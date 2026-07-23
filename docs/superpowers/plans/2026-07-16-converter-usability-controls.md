# Converter Usability Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound long converter review screens, summarize every MISA target column, and make validation/download actions unambiguous without weakening backend accounting gates.

**Architecture:** Add pure frontend helpers for mapping coverage, validation list filtering and CTA state; reuse existing master-data utilities for bounded resolution views; then wire the components into `ConvertPage`. Backend contracts and export validation remain unchanged.

**Tech Stack:** React, Vite, Tailwind CSS, Node `node:test`, Playwright browser QA, existing FastAPI converter APIs.

## Global Constraints

- Do not add a frontend dependency.
- Backend remains the source of truth for blocker/warning severity.
- Mixed source/default/formula configuration is review-only unless backend returns a deterministic blocker.
- Mapping/default/formula/preview/master-data changes must invalidate readiness and warning acknowledgement.
- Filtering and pagination must not remove underlying issues/resolutions.
- Preserve the three existing unrelated working-tree changes in `backend/controllers/authController.js`, `backend/server.js`, and `frontend/src/services/api.js`.
- Do not commit unless the user explicitly requests a commit.

---

### Task 1: Add mapping coverage and CTA state helpers

**Files:**

- Create: `frontend/src/utils/converterUx.js`
- Create: `frontend/src/utils/converterUx.test.mjs`

**Interfaces:**

- Produces `classifyMappingField(target, targetMapping, defaults, formulas)`.
- Produces `summarizeMappingFields(targetHeaders, targetMapping, defaults, formulas)`.
- Produces `filterMappingItems(items, filter)`.
- Produces `getDownloadCtaState(context)` returning `{ label, helper, action, disabled, loading }`.

- [ ] **Step 1: Write failing tests for mapping modes**

```js
test("classifies all mapping modes without inventing precedence", () => {
  assert.equal(classifyMappingField("A", { A: "Raw" }, {}, {}).mode, "mapped");
  assert.equal(classifyMappingField("A", {}, { A: "X" }, {}).mode, "default");
  assert.equal(classifyMappingField("A", {}, {}, { A: "${B}" }).mode, "formula");
  assert.equal(classifyMappingField("A", {}, {}, {}).mode, "unmapped");
  assert.equal(
    classifyMappingField("A", { A: "Raw" }, { A: "Fallback" }, {}).mode,
    "mixed",
  );
});
```

- [ ] **Step 2: Write failing tests for full-template counts and filters**

```js
test("summary accounts for every target header", () => {
  const summary = summarizeMappingFields(
    ["A (*)", "B", "C", "D", "E"],
    { "A (*)": "Raw A", E: "Raw E" },
    { B: "Default", E: "Fallback" },
    { C: "${A (*)}" },
  );
  assert.deepEqual(summary.counts, {
    all: 5,
    mapped: 1,
    default: 1,
    formula: 1,
    unmapped: 1,
    mixed: 1,
    requiredAttention: 0,
  });
  assert.deepEqual(filterMappingItems(summary.items, "mixed").map((item) => item.target), ["E"]);
});
```

- [ ] **Step 3: Write failing tests for CTA states**

```js
test("CTA separates validation from download", () => {
  assert.equal(getDownloadCtaState({ hasAnalyzePayload: true }).action, "validate");
  assert.equal(
    getDownloadCtaState({ hasAnalyzePayload: true, readinessLoading: true }).label,
    "Đang kiểm tra dữ liệu…",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      readinessReport: { summary: { blocker: 1, warning: 0 } },
    }).action,
    "none",
  );
  assert.equal(
    getDownloadCtaState({
      hasAnalyzePayload: true,
      readinessReport: { summary: { blocker: 0, warning: 1 } },
      acknowledgeWarnings: true,
    }).action,
    "download",
  );
});
```

- [ ] **Step 4: Run tests and verify RED**

Run:

```bash
cd frontend
node --test src/utils/converterUx.test.mjs
```

Expected: FAIL because `converterUx.js` or its exports do not exist.

- [ ] **Step 5: Implement the helpers minimally**

Implement exact modes `mapped`, `default`, `formula`, `unmapped`, `mixed`; required status comes from `target.includes("(*)")`. CTA must prioritize downloading/loading/blocker/warning states before ready download.

- [ ] **Step 6: Run tests and verify GREEN**

Run the same `node --test` command. Expected: all Task 1 tests pass.

---

### Task 2: Bound and filter master-data resolutions

**Files:**

- Modify: `frontend/src/utils/masterData.js`
- Modify: `frontend/src/utils/masterData.test.mjs`
- Modify: `frontend/src/components/accounting/MasterDataResolutionTable.jsx`

**Interfaces:**

- Produces `MASTER_DATA_PAGE_SIZE = 20`.
- Produces `summarizeResolutionGroups(resolutions)` with `{ actionRequired, notChecked, verified, requiredCritical, total }`.
- Produces `filterMasterDataResolutions(resolutions, { statusFilter, query })`.
- Produces `paginateMasterDataResolutions(resolutions, page, pageSize)`.

- [ ] **Step 1: Add failing utility tests**

Cover grouping before counts, actionable statuses (`suggested`, `missing`, `conflict`), required critical items, accent-insensitive search, and pages of at most 20 items.

- [ ] **Step 2: Run targeted tests and verify RED**

```bash
cd frontend
node --test src/utils/masterData.test.mjs
```

Expected: FAIL for missing new exports.

- [ ] **Step 3: Implement pure master-data helpers**

Search fields: catalog label/type, `field`, `raw_value`, `target_code`, candidate `code` and `name`. Clamp page to a valid non-negative integer.

- [ ] **Step 4: Run utility tests and verify GREEN**

Expected: all `masterData.test.mjs` tests pass.

- [ ] **Step 5: Update the component**

Add:

- Collapsed summary header with `aria-expanded`.
- Counts for `Cần xử lý`, `Chưa kiểm tra`, `Đã khớp`.
- Visible warning/CTA when no company snapshot is available.
- Search input.
- Status filters.
- 20-row pagination.
- Auto-expand only when `requiredCritical > 0`.

Keep candidate search and alias confirmation behavior unchanged.

- [ ] **Step 6: Run lint/build for component integration**

```bash
cd frontend
npm run lint
npm run build
```

Expected: both exit 0.

---

### Task 3: Bound validation issues without hiding accounting blockers

**Files:**

- Create: `frontend/src/utils/validationUi.js`
- Create: `frontend/src/utils/validationUi.test.mjs`
- Modify: `frontend/src/components/ValidationIssueTable.jsx`

**Interfaces:**

- Produces `VALIDATION_PAGE_SIZE = 25`.
- Produces `summarizeValidationIssues(issues)`.
- Produces `filterValidationIssues(issues, { severity, query })`.
- Produces `paginateValidationIssues(issues, page, pageSize)`.

- [ ] **Step 1: Write failing helper tests**

Verify severity totals, search by row/field/invoice/message/actual/expected, and 25-row pages without mutation or dropped items.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd frontend
node --test src/utils/validationUi.test.mjs
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement helper functions**

Use normalized lowercase search. Keep original issue objects and ordering.

- [ ] **Step 4: Run tests and verify GREEN**

Expected: all validation UI utility tests pass.

- [ ] **Step 5: Update `ValidationIssueTable`**

Add summary chips, severity filter, search and pagination. If blockers exist, default filter to `blocker`; otherwise default to `all`. Summary counts remain visible regardless of filter.

- [ ] **Step 6: Run lint/build**

Expected: both exit 0.

---

### Task 4: Wire mapping summary/filter and explicit CTA into ConvertPage

**Files:**

- Create: `frontend/src/components/MappingCoverageSummary.jsx`
- Modify: `frontend/src/pages/ConvertPage.jsx`

**Interfaces:**

- Consumes helpers from Task 1.
- `MappingCoverageSummary` props: `{ summary, activeFilter, onFilterChange, confidence, sourceLabel }`.
- ConvertPage adds `mappingFilter` state and computes `mappingSummary`, `visibleMappingItems`, `downloadCta`.

- [ ] **Step 1: Add the mapping coverage component**

Render buttons for `all`, `mapped`, `default`, `formula`, `unmapped`, `mixed`, and `requiredAttention`; use `aria-pressed`. Show `Độ tin cậy gợi ý N%` and the disclaimer that confidence is not accounting correctness.

- [ ] **Step 2: Render filtered mapping rows**

Replace `targetHeaders.map(...)` with `visibleMappingItems.map(({ target }) => ...)`. Reset filter to `all` after a new analyze result.

- [ ] **Step 3: Preserve readiness invalidation**

Keep `clearPreviewAfterMappingChange()` in every mapping/default/formula edit. Ensure alias confirmation and preview edits clear readiness/acknowledgement before enabling download again.

- [ ] **Step 4: Replace download CTA behavior**

Add `handlePrimaryDownloadCta()`:

```js
const handlePrimaryDownloadCta = async () => {
  if (downloadCta.action === "validate") {
    await handleReadinessCheck();
    readinessSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (downloadCta.action === "download") {
    await handleDownload();
  }
};
```

Both CTA locations use the computed label/helper/action. Validation click must never trigger a download.

- [ ] **Step 5: Add readiness focus/progress feedback**

Add `aria-live="polite"` helper copy. During validation show `Bước 1/2`; during export show `Bước 2/2`.

- [ ] **Step 6: Run all frontend utility tests**

```bash
cd frontend
node --test src/utils/*.test.mjs src/hooks/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Run lint and production build**

```bash
cd frontend
npm run lint
npm run build
```

Expected: both exit 0.

---

### Task 5: Full local browser QA with real accounting file

**Files:**

- Create QA artifacts only under `.artifacts/converter-usability-qa/`.
- Do not add credentials or raw accounting files to tracked paths.

- [ ] **Step 1: Verify service health**

Check frontend, backend, converter and AI Gateway endpoints return HTTP 200.

- [ ] **Step 2: Test the real 1.930-row file on desktop**

Verify:

- Mapping summary totals exactly 59.
- Current source+default field appears under `Nhiều cách điền`.
- Master-data card is collapsed when only `not_checked` items exist.
- Expanded master-data table shows at most 20 rows.
- Validation issues show at most 25 rows.
- CTA initially says `Kiểm tra trước khi tải`.
- Clicking it runs validation but creates no browser download.
- Warning acknowledgement enables `Tải file MISA`.
- Downloaded `.xls` remains structurally valid.

- [ ] **Step 3: Test 390 px mobile viewport**

Verify no global horizontal overflow, summary filters wrap, master-data controls stack and CTA remains readable.

- [ ] **Step 4: Measure page height regression**

Record page height after preview. It must be bounded and substantially lower than the previous 58.347 px result.

- [ ] **Step 5: Run workspace gate**

Use a valid Windows `TEMP/TMP` path when invoking Windows Node from WSL:

```bash
npm run qa:fast
git diff --check
```

Expected: QA 5/5 and no whitespace errors.

- [ ] **Step 6: Produce QA report**

Write `.artifacts/converter-usability-qa/REPORT.md` containing timings, screenshots, page height, test counts, remaining risks and confirmation that no real PayOS transaction was created.
