# 0008 — Operator-entered lead details and attachments, PII included

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Kickoff set a scope guardrail: recruiting is pre-screening only, collected
PII stays minimal, and no government identifiers or dates of birth are ever
stored. It kept attachments off the MVP for the same reason
([DESIGN.md](../DESIGN.md), "Deliberately deferred"), and
[ADR-0003](0003-lead-entity-with-json-fields.md) leaned on it to keep the
schema clear of sensitive fields.

That line came from one deployment's first use case, not from what a CRM is.
In practice a lead gathers information as it moves through the funnel —
details learned on a call, a document the lead sends over, the identifiers
a later stage needs. With nowhere to put them in Philo, they go to email
threads and shared drives, which is worse for the lead's privacy, not better.
The sales use case wants the same thing (proposals, contracts). Philo is
single-tenant and self-hosted: the operator owns the data, the box, and the
legal obligations that come with what they collect.

Two things are missing: a place for information added after intake, and
files. The intake payload in `fields` is the record of what the form
submitted and stays untouched (ADR-0003); new information needs its own home.

## Options considered

### Option A — Keep the guardrail

- Pro: least sensitive data at rest; nothing to build.
- Con: the operator keeps that information anyway, just outside the system
  of record; Philo stays unfit for any funnel past first contact.

### Option B — Make `fields` editable

- Pro: one place, no schema change.
- Con: loses the record of what was actually submitted; intake answers and
  later additions become indistinguishable.

### Option C — Typed sensitive columns (SSN, licence, DOB…)

- Pro: validation and masking per field.
- Con: hardcodes one use case's PII into a generic schema — the opposite of
  ADR-0003 — and invites a compliance-system feature set Philo does not want.

### Option D — A free-form `details` column plus attachments

- Pro: mirrors ADR-0003's shape — operator-defined key/values, no field
  engine; intake `fields` stays immutable; works for both use cases.
- Con: no per-key typing or masking; the operator decides what goes in.

For file storage specifically:

- **Files on disk under the data dir** — keeps the database small, but a
  crash between file write and row commit leaves orphans, deletion is two
  steps, and paths need guarding.
- **BLOBs in SQLite** — one transaction covers metadata and bytes, deletes
  cascade, backup stays "copy the data dir" with no consistency gap
  ([ADR-0002](0002-sqlite-over-postgres.md)). At single-business volume and a
  per-file cap, the database growth is acceptable.

## Decision

**Option D, with attachments stored as BLOBs in SQLite.**

- **Details.** `leads.details` is a JSON object of operator-entered
  key/values, editable from the PWA, REST and MCP. Intake never writes it;
  `fields` stays read-only. Details are indexed by FTS5 like `fields`.
- **Attachments.** A `lead_attachments` table holds the metadata (`id`,
  `lead_id`, `filename`, `content_type`, `size`, `sha256`, `created_at`,
  `actor`); the bytes live in a separate `lead_attachment_blobs` table so a
  lead read never pulls file content. A per-file cap (10 MB) applies on the
  upload route only; the global request-body limit is unchanged elsewhere.
  Upload, list, download and delete are available to any credential, per
  [ADR-0007](0007-agents-act-as-their-user.md). Removing an attachment
  deletes its bytes. Downloads are always served
  as `Content-Disposition: attachment` with `nosniff` and a sandbox CSP, so
  an uploaded file can never execute as the app's origin. Attachment content
  is not indexed for search.
- **Intake stays narrow.** The public intake endpoint accepts neither details
  nor files; both are added by signed-in users and agents.
- **Timeline.** `details_changed` events record which keys changed, never
  their values; `attachment_added` and `attachment_removed` record the
  filename and size. The timeline must not become a second copy of the PII.
- **No app-level encryption.** Protection is the data dir: access control on
  the host and disk encryption, which are the operator's job. Bearer-only
  auth and single-tenancy bound who can read it.
- **The scope guardrail is replaced** by a narrower one: Philo does not
  implement regulated workflows — compliance-mandated forms, background or
  consumer-report checks, or integrations with them — and the hardcoded
  schema carries no use-case-specific PII columns. What an operator chooses
  to store about a lead is theirs to decide.

## Consequences

- Leads can carry everything a funnel needs, including sensitive data and
  documents, in one system of record.
- The database holds more sensitive data and grows with attachments; backup
  and host security matter more. Docs should say so plainly.
- No masking, per-key access control, or retention automation. Deletion is
  manual, and Philo has no lead deletion yet, so erasing everything held
  about one person is a gap this decision makes more pressing. (Since closed:
  a lead can be deleted for good — DESIGN.md (Erasure).)
- This supersedes the guardrail in AGENTS.md and the attachments deferral in
  DESIGN.md, and replaces ADR-0003's reliance on that guardrail; ADR-0003's
  data-model decision itself stands.
- Revisit if a deployment needs per-key masking or access control, if
  attachment volume makes the database unwieldy (move bytes to disk or
  object storage behind the same metadata table), or if a retention
  obligation calls for automatic deletion.
