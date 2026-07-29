# philo — Agent Guide

This file is for AI coding agents working on this codebase. Read it before making changes.

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

## Project Overview

Philo is a self-hosted, open-source **CRM**, deployed as **one instance per
business** — single-tenant by design, permanently. Every simplification that
falls out of single-tenancy should be taken.

**Status: design phase.** No application code exists yet. The design document
lives in `docs/`, and contested architectural calls are recorded in
`docs/adr/`. Read both before proposing implementation work.

First production use case: pre-screening driver applicants for a trucking
company. Second (future) use case: sales CRM for a consulting practice.
The data model must not paint the second case into a corner, but we do not
build for it yet.

## No real-world names in repo content

This is a public open-source repository. Never reference real-world
businesses, individuals, domains, or other identifying details of any
deployment in docs, plans, issues, code, comments, tests, or fixtures —
describe use cases generically ("a small trucking company", "the operator")
and use `example.com`-style placeholder domains. Two exceptions: the
maintainer's GitHub handle in functional files (CODEOWNERS, trust lists),
and other open-source projects (e.g. Ollie), which may be referenced freely
— link to the project on first mention in each document.
If deployment-specific detail is needed to do the work, it belongs in the
conversation, not the repo.

## Naming — decided, do not relitigate

| Thing | Value |
|---|---|
| Product name (UI, docs, emails) | Philo |
| Org / repo | `philo-crm/philo` |
| Binary / package | `philo` |
| Docker image | `ghcr.io/philo-crm/philo` |
| Env var prefix | `PHILO_` |
| Database name | `philo` |
| PWA `short_name` | Philo |
| Config dir | `~/.config/philo/` |

## Scope Guardrail — recruiting is pre-screening ONLY

Philo is **not** a DOT-compliant employment application system and must not
become one by accident. Out of scope, permanently:

- DOT driver qualification (DQ) files
- The FMCSA-mandated application for employment
- Background checks, MVR pulls, drug & alcohol clearinghouse queries
- Anything touching FCRA-regulated consumer reports

Practical consequence: collected PII stays minimal — contact info and basic
qualification questions (years of experience, endorsements, equipment type,
availability). **No SSN, no license number, no DOB.** If you find yourself
designing a field that belongs on a DQ file, stop and flag it to the human
instead of building it.

## Shippability Bar

"Done" means **all** of:
- No correctness, security, or data-loss bugs
- Critical paths covered by tests
- No broken contracts (API, schema, public types)

Style, taste, micro-optimizations, and refactor opportunities are **not**
shippability blockers. They get noted in the PR description under `## Notes`
if worth mentioning, then discarded. They do **not** become GitHub issues
unless the user explicitly files one. The backlog is not a landfill for robot
homework.

## Triage Rules

Every review finding (self-review or subagent review) is classified:

- **blocker** — violates the Shippability Bar. Must fix before merge.
- **significant** — meaningful issue that affects maintainability or correctness in edge cases. Fix in-PR if < 30 min; otherwise stop and discuss with the user. Never defer with a "tracked elsewhere" handwave.
- **nit** — style, taste, micro-opt, refactor opportunity. Note in PR `## Notes` if a pattern, otherwise discard. Never file as an issue.

**Hard cap: 2 review iterations.** If iteration 2 still finds blockers, stop
and escalate to the user. Looping further is a sign the change needs human eyes.

## Release Workflow

Trunk-based. Three skills cover the workflow:

- **`/work-issue <N>`** — default unit of work. One issue → branch off main → PR back to main → self-merge if Shippability Bar is met.
- **`/sprint-plan`** — exception, for cross-cutting work that must land atomically. Plans + executes on a feature branch, one PR to main.
- **`/cut-release`** — when main has accumulated enough work to ship. Bumps version, tags, generates release notes. No release branch involved.

### Version increment
- **Patch (x.y.Z):** bug fixes only, no new API surface or features
- **Minor (x.Y.0):** any new feature, endpoint, or UI capability

## Commit Style

- Use `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:` prefixes
- **Sign off every commit** with `git commit -s` — this repo enforces DCO; a CI check blocks merge for any commit lacking a valid `Signed-off-by` trailer matching the commit author.
- Co-author with the current model name:
  ```
  Co-Authored-By: Claude with <model-name>
  ```
