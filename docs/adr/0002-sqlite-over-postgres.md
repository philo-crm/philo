# 0002 — SQLite over Postgres (and over LanceDB)

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Philo is permanently single-tenant with hobby-scale volume (a recruiting
funnel measured in dozens of leads per week). The install story must be
embarrassingly short. The maintainer has existing Postgres infrastructure,
which argued for Postgres; the sibling project
([Ollie](https://github.com/olliefms/ollie)) used LanceDB, chosen there for
vector search over document embeddings. Philo needs full-text search and must
be searchable by AI agents; it has no embedding corpus at MVP.

## Options considered

### Option A — Postgres

- Pro: the "real database" default; the maintainer already runs it.
- Con: a second container, connection config, and a Compose file — the
  install story doubles for zero benefit at this scale. Existing infra is an
  argument about one instance, not about the product.

### Option B — SQLite (better-sqlite3 + Drizzle migrations)

- Pro: one file holds the entire instance state (backup = copy the data
  dir); no second process; `docker run` one-liner stands; FTS5 covers
  full-text search; sqlite-vec adds vector columns to the same file if
  semantic search ever materializes; Drizzle gives deterministic,
  reviewable SQL migrations — the antidote to the LanceDB migration lore
  that fills Ollie's AGENTS.md.
- Con: single-writer concurrency (irrelevant single-tenant); no network
  clients (a feature here).

### Option C — LanceDB (sibling consistency)

- Pro: consistency with Ollie.
- Con: chosen there for vector search Philo doesn't need; no SQL migration
  tooling — Ollie shipped the same migration bug in three separate releases.

## Decision

**SQLite via better-sqlite3, schema and migrations via Drizzle, FTS5 for
search.** Vector search deferred; the documented upgrade path is sqlite-vec
in the same database file.

## Consequences

- The one-container, one-volume install story holds; backup stays trivial.
- Search is FTS5 + structured filters; "semantically similar leads" waits
  for a corpus worth embedding.
- Revisit if: multi-instance HA ever matters (it shouldn't — single-tenant),
  or write concurrency exceeds SQLite's comfort (it won't at this scale).
