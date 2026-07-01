# Local AI Accounting Mapping Implementation Plan

**Goal:** Add 100 deterministic purchase-input scenarios and feed relevant accounting/MISA knowledge into the Local AI gateway without allowing AI to bypass backend validation.

## Task 1: Scenario contracts and generator

**Create:**
- `converter/app/purchase_scenarios.py`
- `converter/tests/test_purchase_scenarios.py`

Steps:
1. Write failing tests asserting exactly 100 unique scenarios, required category coverage, stable generation, and valid expected mappings.
2. Implement immutable scenario dataclasses and deterministic matrix generation.
3. Add workbook generation supporting title rows, multiple sheets, aliases, reordered columns, hidden/formula rows, and format variants.
4. Verify all generated workbooks can be read by the converter.

## Task 2: Knowledge retrieval for Local AI

**Create:**
- `converter/app/accounting_ai_context.py`
- `converter/tests/test_accounting_ai_context.py`

Steps:
1. Write failing tests for nearest-scenario retrieval, accounting safety instructions, no fabricated headers, and prompt-size limits.
2. Implement normalized-header similarity and select at most six examples.
3. Return a compact JSON-serializable context with aliases, MISA constraints, selected examples, and review warnings.

## Task 3: Gateway prompt integration

**Modify:**
- `converter/app/ai_gateway.py`
- `converter/tests/test_misa_profile_api.py`

Steps:
1. Write failing tests showing purchase prompts contain the accounting context and sample values while sales prompts remain bounded.
2. Integrate the context into `_build_prompt` only for purchase targets.
3. Preserve strict JSON output and existing response normalization.

## Task 4: Scenario export and benchmark

**Create:**
- `converter/scripts/generate_purchase_scenarios.py`
- `converter/tests/test_purchase_scenario_benchmark.py`

Steps:
1. Add CLI options for output directory, count, and seed.
2. Export scenario catalog plus optional `.xlsx` files into `.artifacts`, never into production storage.
3. Benchmark parse/detect/mapping coverage over all 100 scenarios and write JSON evidence.

## Task 5: QA/QC

1. Run focused RED/GREEN tests for each task.
2. Run full converter test suite.
3. Run frontend build.
4. Start Ollama, AI gateway, converter, and frontend locally.
5. Run representative live Local AI requests and website upload/preview/download.
6. Record timings, mapping results, failures, and remaining accountant-review warnings under `.artifacts/qa-accounting-ai/`.

