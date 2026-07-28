# philo — Claude Code Guide

The full agent guide is [`AGENTS.md`](AGENTS.md) — project scope, naming,
guardrails, shippability bar, triage rules, and release workflow. Read it
before making changes. This file carries only what must load every session.

- **Sync with origin before and after every task** — see the top of
  [`AGENTS.md`](AGENTS.md) for the exact procedure. Never checkout from a
  dirty tree; never force a diverged `main`.
- **Design phase:** no application code yet. Decisions live in `docs/` and
  `docs/adr/`. Don't scaffold implementation without an approved design.
- **Scope guardrail:** recruiting use case is pre-screening only — no DOT/DQ
  fields, no SSN, no license number, no DOB. Flag, don't build.
- **Single-tenant, permanently.** One business per instance. Take every
  simplification that follows.
- **Commits:** conventional prefixes, `git commit -s` (DCO enforced),
  co-author `Claude with <model-name>`.
