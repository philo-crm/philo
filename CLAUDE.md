# philo — Claude Code Guide

The full agent guide is [`AGENTS.md`](AGENTS.md) — project scope, naming,
guardrails, shippability bar, triage rules, and release workflow. Read it
before making changes. This file carries only what must load every session.

- **Sync with origin before and after every task** — see the top of
  [`AGENTS.md`](AGENTS.md) for the exact procedure. Never checkout from a
  dirty tree; never force a diverged `main`.
- **Design-first:** [`docs/DESIGN.md`](docs/DESIGN.md) and `docs/adr/` are the
  source of truth for architecture. Implement against an approved design and a
  scoped issue; a contested call gets an ADR, not a unilateral change.
- **Scope guardrail:** recruiting use case is pre-screening only — no DOT/DQ
  fields, no SSN, no license number, no DOB. Flag, don't build.
- **Single-tenant, permanently.** One business per instance. Take every
  simplification that follows.
- **No real-world names in repo content.** Public repo: no real businesses,
  individuals, or deployment domains in docs, code, issues, or fixtures —
  generic descriptions and `example.com` placeholders only (see AGENTS.md).
- **Commits:** conventional prefixes, `git commit -s` (DCO enforced),
  co-author `Claude with <model-name>`.
