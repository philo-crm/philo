# 0001 — TypeScript on Node over Rust

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Philo's sibling project (Ollie) is Rust, which argued for consistency. But the
project's constraints shifted the calculus: all code is written by AI agents
("vibe-coded") rather than by hand; Philo must be usable by AI agents via MCP;
and the self-hosting bar is "runs in a Docker container," not "single static
binary." The maintainer knows Node well and no longer writes code directly.

## Options considered

### Option A — Rust (Axum), Ollie's shape

- Pro: sibling consistency; Ollie's conventions and hard-won lessons transfer;
  compiler as correctness backstop; true single-binary distribution.
- Con: Ollie had to hand-roll its entire MCP server and OAuth surface; every
  integration Philo needs (MCP SDK, web-push, Resend/SMTP, templating) is a
  less-traveled crate; agent iteration is slower.

### Option B — TypeScript on Node LTS

- Pro: the official MCP SDK is TypeScript-first, including its OAuth/auth
  framework — entire subsystems Ollie built by hand come off the shelf; the
  canonical `web-push`, Nodemailer, and Handlebars libraries are TS-native;
  coding agents are strongest and fastest in TS; one language across backend
  and PWA frontend.
- Con: no compiler-grade correctness backstop; Docker image carries a Node
  runtime; weaker bare-binary story.

### Option C — Bun

- Pro: Option B's ecosystem plus single-binary compile.
- Con: maturity risk in the foundation of a long-lived self-hosted product.

## Decision

**TypeScript on Node current LTS, with Hono as the HTTP framework.** The MCP
requirement tips it: agent-usability is a core product requirement, and the
TS SDK provides the MCP server and OAuth machinery that consumed significant
Ollie effort. Bun stays a later experiment, not a foundation.

## Consequences

- MCP, OAuth, push, and email ride on first-party or canonical libraries.
- The install story is Docker-first; no bare static binary.
- Type safety relies on TypeScript strictness + tests rather than a compiler
  that refuses to build unsound code; CI must hold that line.
- Revisit if: the project ever needs the performance/footprint of a compiled
  binary, or the TS MCP SDK stops being the reference implementation.
