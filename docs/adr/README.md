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
- [0003 — Hardcoded Lead entity with a JSON fields column](0003-lead-entity-with-json-fields.md) (reliance on the PII guardrail superseded by 0008)
- [0004 — Notifications: best-effort declarative web push, email guaranteed](0004-push-best-effort-email-guaranteed.md)
- [0005 — OAuth 2.1 server built on the MCP SDK's primitives, served by Hono](0005-oauth-server-on-hono.md) (scope and token-reach decisions superseded by 0006)
- [0006 — Headless server, an SDK that tracks it, and the PWA and MCP as clients](0006-headless-server-sdk-clients.md) (authority levels superseded by 0007)
- [0007 — An agent acts with its user's authority, no more and no less](0007-agents-act-as-their-user.md)
- [0008 — Operator-entered lead details and attachments, PII included](0008-lead-details-and-attachments.md)
- [0009 — Multiple funnels per instance, with funnel-scoped settings](0009-multiple-funnels.md)
- [0010 — One change feed for the live app and for webhooks](0010-change-feed-and-webhooks.md)
- [0011 — An optional auth header on webhook deliveries, beside the signature](0011-webhook-auth-header.md)
