# philo — Claude Code Guide

The full agent guide is [`AGENTS.md`](AGENTS.md) — project scope, naming,
guardrails, shippability bar, triage rules, and release workflow. Read it
before making changes. This file carries only what must load every session.

## Sync with origin — before and after every task

**Before doing anything else in a session** — before reading issues, branching, or editing a single file — make the local checkout match origin. Skip only if the human EXPLICITLY says to work offline or against a stale state.

```bash
git fetch origin
git status --porcelain        # MUST be empty before switching branches
```

- If `git status --porcelain` prints anything, **STOP.** The tree is dirty — do NOT `git checkout`. A checkout from a dirty branch can silently carry uncommitted edits onto `main`. Tell the human; let them commit, stash, or discard first.
- Only with a clean tree, update the default branch:

  ```bash
  git checkout main && git pull --ff-only origin main
  ```

- If `git pull --ff-only` fails, local `main` has **diverged** from `origin/main`. STOP and tell the human. Never force-push, hard-reset, or rebase to force it.
- **Resuming mid-task on a feature branch?** `git fetch` is still mandatory, but stay on that branch — don't switch to `main`. Only rebase/merge onto it when asked. The non-negotiable part is that `main` is current before cutting a NEW branch.

**After a PR merges, or after tearing down a git worktree,** bring local `main` back in line with `origin/main` — from the primary checkout, AFTER leaving the worktree (`main` can't be checked out in two worktrees at once), clean tree only:

```bash
git checkout main && git pull --ff-only origin main
```

This applies to every agent and session unless explicitly told otherwise.

## Non-negotiables

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
