# Student Assistant Phase 2 Ask About This File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer bounded questions about the active workbook using deterministic queries and inspectable evidence.

**Architecture:** A deterministic intent router executes file queries first. Optional AI can rephrase only selected evidence; citation validation rejects invented rows, fields or values.

**Tech Stack:** Python, FastAPI, Pydantic, Decimal, React.

## Global Constraints

- Requires Phase 1 overview/explanation state.
- No evidence means no file-specific answer.
- Questions never escape the signed session and owner scope.

---

### Task 1: Deterministic intent and evidence query engine

**Files:**
- Create: `converter/app/student_queries.py`
- Test: `converter/tests/test_student_queries.py`
- Create: `converter/tests/fixtures/student_question_benchmark.json`

**Interfaces:**
- `answer_question(question, session_state) -> StudentAnswer`.
- Supported intents are the 12 families in the design.

- [ ] Create at least 50 benchmark cases across sales, purchase, duplicates, VAT, required actions and unsupported judgment.
- [ ] Run tests and verify they fail before implementation.
- [ ] Implement normalized Vietnamese shortcut matching, bounded row selection and evidence validation.
- [ ] Return `unsupported_legal_or_business_judgment` for VAT eligibility/account certainty questions without deterministic context.
- [ ] Run the 50-case benchmark.
