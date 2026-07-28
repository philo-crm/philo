# 0003 — Hardcoded Lead entity with a JSON fields column

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Philo's two use cases want very different lead fields: driver recruiting
(years of experience, endorsements, equipment type, availability) versus
sales prospecting (company, budget, timeline). A user-definable custom-field
system buys generality but costs a field-definition model, admin UI, typed
validation, and query complexity — a large fraction of total MVP effort. A
rigid recruiting-only schema paints the sales use case into a corner. The
scope guardrail also applies: the schema must not invite DQ-file PII.

## Options considered

### Option A — Rigid, recruiting-specific columns

- Pro: simplest possible queries and UI.
- Con: every form change is a migration; the sales use case forks the schema.

### Option B — Full custom-field engine (field definitions / EAV)

- Pro: maximal generality; fields definable in the app.
- Con: the complexity cliff — field-type system, validation, admin UI,
  query indirection — serving a single-tenant instance whose operator can
  already control the form.

### Option C — Hardcoded universal columns + raw-payload JSON column

- Pro: universal contact fields (name, email, phone, source, stage) stay
  first-class and indexed; everything else the form submits lands untouched
  in a `fields` JSON column — different forms produce different fields with
  zero schema work; no submission is ever rejected or truncated by schema;
  SQLite `json_extract` keeps JSON queryable and FTS5 can index it.
- Con: JSON fields are untyped and render generically (labeled key/values);
  no per-field validation or admin UI.

## Decision

**Option C.** Single-tenancy makes form-level field definition sufficient:
the operator controls the form, so reserved names (`name`, `email`, `phone`)
map to columns by convention and the rest is preserved as submitted.

## Consequences

- Recruiting and sales coexist without a custom-field engine; generality
  comes from forms, not schema.
- The lead detail page renders `fields` generically; no typed widgets.
- **Migration path if this proves wrong:** add a field-definitions table and
  backfill from the JSON — the raw payload was never thrown away, so the
  risk of the cheap choice is rework, not data loss.
- The hardcoded schema contains no DQ-file fields; qualification answers
  live in form-defined JSON, keeping the PII guardrail enforceable at the
  form level.
