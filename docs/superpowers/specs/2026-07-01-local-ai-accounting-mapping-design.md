# Local AI Accounting Mapping Design

## Goal

Improve Local AI mapping for heterogeneous Vietnamese purchase-input workbooks by giving the AI gateway a compact, source-backed accounting/MISA knowledge context and 100 deterministic synthetic scenarios.

## Safety boundary

- The real MISA template remains the target schema and source of truth.
- AI proposes mapping only; backend filters unknown source/target headers.
- AI must not invent item/vendor/account codes, VAT rates, or legal conclusions.
- Required fields come from template `(*)` and backend contracts.
- Account/VAT/business classification uncertainty is a warning for accountant review.
- Synthetic scenarios contain no partner/customer data.

## Scenario model

Generate exactly 100 stable scenarios from a deterministic matrix. Each scenario contains an id, category, workbook layout, header aliases, value formats, expected mapping, expected classification, expected warnings/blockers, and seed.

Coverage axes:

- goods, service, and mixed invoices;
- title/header rows 1-20 and multiple sheets;
- Vietnamese, no-accent, abbreviation, accounting-code, and English headers;
- reordered/extra/duplicate columns;
- ISO, Vietnamese, Excel-serial dates;
- Vietnamese/English numeric formats, blank versus zero;
- VAT 0/5/8/10/KCT and mixed rates;
- cash, bank, and payable payment methods;
- discounts, negative adjustment, formulas, hidden rows, merged title cells;
- missing required source data and uncertain master-data/account situations.

## Runtime context

The gateway selects only the nearest scenarios based on normalized header overlap and category signals. It injects a compact knowledge block plus at most six few-shot examples into the Ollama prompt. This avoids sending all 100 scenarios on every request.

## Evaluation

- 100/100 scenarios must generate and parse without crashes.
- Scenario ids and schemas must be unique.
- Coverage categories must meet minimum counts.
- Prompt must stay under a deterministic size budget.
- Unknown AI headers must still be rejected by the existing normalizer.
- Live Local AI QA uses a representative subset; deterministic unit tests do not depend on Ollama availability.

## Official operational basis

- https://helpact.misa.vn/kb/html_10050000/
- https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/

