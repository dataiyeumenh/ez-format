# Student Assistant Phase 3 Check My Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate student mapping/data/classification work deterministically, reveal progressive hints and store reproducible skill evidence.

**Architecture:** FastAPI owns expected state, scoring and hint boundaries. MongoDB stores immutable attempt revisions and aggregate progress; the browser never receives future hint content before reveal.

**Tech Stack:** FastAPI, Decimal, Node/Express, MongoDB, React.

## Global Constraints

- AI cannot mark an answer correct or alter a score.
- Same input, rubric version and state must produce the same score.
- Expected state remains server-side until hint level permits disclosure.

---

### Task 1: Deterministic scoring and hint engine

**Files:**
- Create: `converter/app/student_scoring.py`
- Test: `converter/tests/test_student_scoring.py`

**Interfaces:**
- `score_attempt(kind, submitted, expected, rubric_version='student-v1') -> AttemptEvaluation`.
- Weights: mapping 30, required completeness 20, date/number 15, VAT/amount 20, classification 10, correction after hints 5.
- `hint_for(evaluation, issue_id, level)` returns only that level.

- [ ] Write failing tests for exact 100/partial/zero scores, deterministic repeatability and hint level leakage.
- [ ] Implement canonical state hashing, Decimal score calculation and progressive hints levels 0–4.
- [ ] Run scoring tests.
