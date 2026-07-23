# Student Assistant Phase 1 Explain My File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, evidence-backed explanation workspace for an analyzed sales or purchase workbook.

**Architecture:** FastAPI reuses the existing analyze/mapping/readiness pipeline and emits a stable explanation contract. React renders one student workspace with summary, mapping/preview and an inspector; AI is optional phrasing only.

**Tech Stack:** FastAPI, Pydantic, existing MISA template registry, React, Tailwind.

## Global Constraints

- Requires Phase 0 signed context and owner-bound upload state.
- Template IDs must match repository IDs exactly.
- Every explanation must contain source evidence or a rule source; otherwise return `unsupported`.

---

### Task 1: Field dictionary and explanation schemas

**Files:**
- Create: `converter/app/student_models.py`
- Create: `converter/app/student_field_dictionary.py`
- Test: `converter/tests/test_student_explanations.py`

**Interfaces:**
- `StudentEvidence`, `StudentExplanation`, `StudentFileSummary` Pydantic models.
- `field_definition(template_id, header)` returns meaning, aliases, required source, mistakes, fix hint and source metadata.

- [ ] Write failing coverage test that iterates all headers from all seven templates and requires a dictionary entry; every `(*)` header must have meaning and source.
- [ ] Implement exact definitions for accounting-critical fields and safe generated fallback definitions for optional template fields.
- [ ] Run `python -m pytest tests/test_student_explanations.py -q`.
