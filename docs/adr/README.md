# Architecture Decision Records

This directory records the architectural decisions behind Philo — the
genuinely contested calls, not every choice. Each ADR captures the context at
the time, the options considered, the decision, and its consequences.

## Format

ADRs follow a lightweight MADR-style template — see
[0000-template.md](0000-template.md). Files are numbered sequentially and
named `NNNN-short-kebab-title.md`.

## Statuses

- **Proposed** — under discussion, not yet binding.
- **Accepted** — the current decision; code should conform to it.
- **Superseded by [NNNN]** — replaced by a later ADR. Never edit an accepted
  ADR's decision retroactively; write a new one that supersedes it.

## Index

- [0001 — TypeScript on Node over Rust](0001-typescript-node-over-rust.md)
- [0002 — SQLite over Postgres (and over LanceDB)](0002-sqlite-over-postgres.md)
- [0003 — Hardcoded Lead entity with a JSON fields column](0003-lead-entity-with-json-fields.md)
- [0004 — Notifications: best-effort declarative web push, email guaranteed](0004-push-best-effort-email-guaranteed.md)
