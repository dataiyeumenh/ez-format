# Student Assistant Phase 4 Voucher And Accounting Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect source rows to canonical voucher groups, supported business events, reviewable debit/credit suggestions and MISA output rows.

**Architecture:** The accounting map reuses preview rows, canonical grouping and field provenance. Accounts are read only from submitted data, confirmed profile/workspace context or explicit template defaults; unknown choices stay unresolved.

**Tech Stack:** Python, Decimal, existing voucher reconstruction/provenance modules, React.

## Global Constraints

- Account choice is `suggested` unless deterministically configured.
- Every entry contains evidence and source status.
- An unbalanced exercise map is a blocker for the exercise only; it does not silently alter MISA readiness.

---

### Task 1: Accounting-map builder

**Files:**
- Create: `converter/app/student_accounting_map.py`
- Test: `converter/tests/test_student_accounting_map.py`

**Interfaces:**
- `build_accounting_maps(session_state) -> list[AccountingMap]`.
- Groups by stable document key and emits `businessEvent`, entries, balance, issues and bidirectional evidence.

- [ ] Write failing tests for sales goods, purchase goods, service, missing accounts and unbalanced entries.
- [ ] Implement Decimal grouping and account extraction from actual target fields/default provenance.
- [ ] Mark AI-only or unsupported account choices `needs_review`; never invent an account.
- [ ] Run accounting-map tests plus voucher reconstruction tests.
