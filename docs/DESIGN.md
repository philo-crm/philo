# Philo MVP Design

- **Status:** Accepted (kickoff session, 2026-07-28)
- **Scope:** MVP — lead intake, lead management, user-definable funnel, PWA
  push, customizable email, agent-usable MCP surface

This document captures the decisions made in the kickoff design session and,
just as importantly, the ones consciously deferred. Contested calls have full
rationale in [docs/adr/](adr/). The scope guardrail and naming table live in
[AGENTS.md](../AGENTS.md) and are not repeated here.

## Product definition

Philo is a self-hosted, open-source CRM deployed as **one instance per
business** — single-tenant by design, permanently. The MVP serves driver
recruiting pre-screening at a small trucking company; a later sales-CRM use
case (a consulting practice) constrains generality but is not built for.

Philo is **agent-usable from day one**: MCP is a first-class API surface, not
a bolt-on.

## Stack

Full rationale: [ADR-0001](adr/0001-typescript-node-over-rust.md),
[ADR-0002](adr/0002-sqlite-over-postgres.md).

| Layer | Choice |
|---|---|
| Runtime | Node.js (current LTS), TypeScript |
| HTTP framework | Hono |
| Database | SQLite via better-sqlite3, Drizzle ORM + drizzle-kit migrations |
| Search | SQLite FTS5 (vectors deferred; upgrade path is sqlite-vec) |
| Frontend | Vite + React PWA, a client of the API through `@philo/sdk` |
| SDK | `@philo/sdk`: typed API client plus OIDC/PKCE helpers, no runtime dependencies |
| Email | Nodemailer over SMTP (provider-agnostic; Resend via SMTP in docs) |
| Push | Web Push (VAPID) with Declarative Web Push payloads |
| MCP | `@modelcontextprotocol/sdk`, streamable HTTP; a client of the API through `@philo/sdk` |
| Identity | Built-in OIDC IdP (authorization code + PKCE), replaceable by an external OIDC provider |
| Container | Single Docker image, `ghcr.io/philo-crm/philo` |

## Architecture

A headless server, an SDK that tracks it, and two clients of the SDK —
[ADR-0006](adr/0006-headless-server-sdk-clients.md):

```
  human ──▶ PWA (apps/web) ─────┐
                                ├──▶ @philo/sdk ──▶ ┌──────────────────────────────┐
  agent ──▶ MCP (apps/mcp) ─────┘    bearer token   │ headless server              │
                                                    │  /api/v1/*   REST            │──▶ service layer ──▶ SQLite
  form POST ───────────────────────────────────────▶│  /api/intake/{form_key}      │        │            (PHILO_DATA_DIR)
                                                    │  /oauth/*    OIDC IdP + its  │        └─▶ SMTP, Web Push
  sign-in (browser redirect) ──────────────────────▶│              dialogs         │
                                                    └──────────────────────────────┘
```

- **The server is headless.** It serves the API, form intake, and the IdP —
  whose sign-in, consent and first-boot setup pages are the only HTML it
  renders. It serves no UI files.
- **The SDK is the only way a client reaches the API.** A response shape and
  the SDK type that mirrors it change in the same PR.
- **The PWA and MCP are clients on equal footing** with any third-party
  integration. MCP holds no credential and no data: it forwards each caller's
  token to the API, which decides what the caller may do.
- **One container by default.** `apps/standalone` hosts the server, the MCP
  app and the built PWA on one origin, and is what the image runs. Each can
  also be deployed apart — `PHILO_APP_URL` and `PHILO_MCP_URL` say where.

- All state lives under `PHILO_DATA_DIR` (default `/data` in the container):
  the SQLite database plus auto-generated secrets (VAPID keys, the IdP's
  id_token signing key). **Backup = copy that directory.**
- Install story: `docker run -d -p 3000:3000 -v philo-data:/data
  -e PHILO_PUBLIC_BASE_URL=https://philo.example.com ghcr.io/philo-crm/philo`
- Configuration philosophy: env vars for what the process needs before it can
  serve (`PHILO_PORT`, `PHILO_DATA_DIR`, `PHILO_PUBLIC_BASE_URL`,
  `PHILO_TRUSTED_PROXY`); the DB `settings` table for everything else
  (SMTP config, sender identity, business name), editable in the UI. Secrets
  that Philo can generate itself are generated, persisted in the data dir, and
  never asked of the operator.
- **`PHILO_TRUSTED_PROXY` is how rate limits learn who the caller is.** Philo's
  limits — login, first-boot setup, form intake — key on the socket's peer
  address, and behind the TLS-terminating proxy of the install story above that
  is one address for the whole deployment: every caller shares one budget, so
  one flood spends everyone's. Set it to `true` and the caller comes from
  `X-Forwarded-For` instead. Default `false`: read no header at all.
  - The rule is **the rightmost public entry, and only when the socket's peer is
    itself private.** Each hop appends the address it saw, so an attacker's
    injected entries sit left of what the proxy wrote and the right-to-left walk
    never reaches them. A count of trusted hops is the other common design and
    it is worse: an operator who miscounts by one lets an attacker pad the header
    until the entry the count selects is one they wrote. There is no equivalent
    mistake available here.
  - **`true` requires that only the proxy can reach the port.** The private-peer
    condition is what enforces it — publish on `127.0.0.1:3000:3000` or a private
    network, and a caller who reaches the app directly is throttled on their own
    address because their peer address is public.
  - Failure directions are all over-restrictive, never permissive: a public proxy
    (a CDN whose egress addresses are public) collapses to the proxy rather than
    the visitor, and anything unparseable or absent falls back to the peer.

## Data model

Full rationale for the generality decision:
[ADR-0003](adr/0003-lead-entity-with-json-fields.md).

### Core tables

- **`leads`** — hardcoded universal columns: `id`, `name`, `email`, `phone`,
  `source`, `form_id`, `current_stage_id`, `is_spam`, `created_at`,
  `updated_at`; plus **`fields` (JSON)** holding the raw intake payload's
  non-reserved keys. No user-definable custom-field engine; the intake form
  defines what lands in JSON. `json_extract` keeps it queryable; if
  first-class custom fields are ever needed, a field-definitions table
  backfills from the JSON with zero data loss. `fields` is the intake record
  and stays read-only; **`details` (JSON)** holds what users and agents add
  as the lead moves through the funnel, sensitive data included
  ([ADR-0008](adr/0008-lead-details-and-attachments.md)).
- **`lead_attachments`** / **`lead_attachment_blobs`** — files on a lead:
  metadata (`id`, `lead_id`, `filename`, `content_type`, `size`, `sha256`,
  `created_at`, `actor`) apart from the bytes, both in SQLite. 10 MB per
  file; downloads always served as attachments. Not accepted at intake.
- **`lead_events`** — append-only unified timeline: `id`, `lead_id`, `type`
  (`created` | `stage_changed` | `note_added` | `email_sent` |
  `details_changed` | `attachment_added` | `attachment_removed`), `payload`
  (JSON), `actor` (user/API key/OAuth client/form), `created_at`. Written in the same
  transaction as the mutation it records. Events are a log, never the source
  of truth — nothing replays them; on disagreement the lead row wins.
- **`pipelines`** — seeded with one Default row; **no pipeline-management UI
  in MVP**. The one place future generality is deliberately bought.
- **`stages`** — `id`, `pipeline_id`, `name`, `position`, `is_terminal`.
  User-definable in the app: create, rename, reorder, delete-if-empty.
  Transitions are unrestricted — any stage to any stage. First boot seeds
  `New → Contacted → Qualified → Closed` (terminal), renamed in-app to the
  operator's real funnel.
- **`intake_forms`** — `id`, `name`, `form_key` (unguessable slug),
  `allowed_origins`, `created_at`. Per-form keys support the future second
  use case (second form, same instance).
- **`email_templates`** — `id`, `trigger` (`new_lead_notify` |
  `new_lead_ack`; enum grows to `stage_changed:<stage>` post-MVP),
  `subject`, `body`, `enabled`, `updated_at`. Two rows seeded at first boot.
- **`push_subscriptions`**, **`users`**, **`api_keys`**, **`oauth_clients`**,
  **`authorization_codes`**, **`access_tokens`**, **`refresh_tokens`**,
  **`settings`** — supporting tables per the sections below. (`sessions` is a
  leftover of the cookie era and unused — ADR-0006.)

### Entity decisions

- A driver applicant **is a Lead**. No Contact/Application/Deal split — with
  one business per instance that split is ceremony. If the sales use case
  ever needs one-person-many-deals, that is the moment to introduce it.
- Current stage is a mutable `current_stage_id` column (fast queries); stage
  history comes from `lead_events` (cheap history, no event sourcing).
- **No `assigned_to`** on leads for now (1–2 users per instance).
- Duplicate handling is a short intake dedupe window only — a reapplicant
  months later is a **new lead**, never auto-merged. A repeat inside the
  window whose lead has since been deleted is filed again.

### Erasure

`DELETE /api/v1/leads/{id}` is a hard delete, open to any credential
(ADR-0007). `lead_events`, `lead_attachments` and `lead_attachment_blobs`
cascade from `leads`, and `leads_fts_delete` drops the search row. Nothing is
written in its place — a timeline entry or tombstone that named the person
would keep the thing that was asked to go; the server log gets the id and the
actor only. No soft delete, undo window, bulk delete or retention schedule.

Gone from the tables is not gone from the file. Three things, all of them
needed (measured: drop any one and the deleted values can still be read out of
the file with `grep`):

- **`PRAGMA secure_delete = ON`** for every connection, so freed pages and
  freed space inside pages are zeroed. This also covers a removed attachment
  or an overwritten detail.
- **FTS5 `secure-delete`** on `leads_fts` (migration 0009). FTS5 normally
  deletes by appending a marker, so the cancelled tokens survive in older
  index segments that are never freed for `secure_delete` to zero.
- **`PRAGMA wal_checkpoint(TRUNCATE)`** after the delete. The old page images
  stay in the WAL until a checkpoint writes the zeroed pages over the file and
  empties it; SQLite's automatic checkpoints never empty it. A reader holding
  the WAL (an online backup) makes it return busy without waiting, and it is
  retried every 30 seconds until it completes, and again at every boot.

Cost, measured on 5,000 leads with a 256 KB file on every tenth: deleting a
lead went from 0.16 ms to 0.75 ms; updating a lead (which rewrites its search
row) from about 0.05 ms to 0.24 ms; inserts unchanged. Negligible at a
single business's scale, so it is always on rather than an option.

A database written before this was on has free space that was never zeroed,
holding values earlier edits overwrote. The boot that applies migration 0009
merges the search index and then runs a one-time `VACUUM`, which rebuilds the
file without it. Backups taken before a deletion still hold the lead —
DEPLOYMENT.md (Backup).

## Intake endpoint

`POST /api/intake/{form_key}` — accepts both `application/json` and
`application/x-www-form-urlencoded` (a plain no-JS HTML form works).

- **Identification, not authentication.** The form POSTs from a visitor's
  browser, so any embedded secret is public. The unguessable `form_key`
  routes and is revocable (leak it → rotate it). Server-side proxying with a
  real secret is a documented upgrade, not a requirement.
- **Field mapping: convention over configuration.** Reserved names — `name`
  (or `first_name` + `last_name`), `email`, `phone` — map to columns;
  everything else lands untouched in `fields` JSON. A renamed or added form
  field can never drop a submission. Only validation: at least one of email
  or phone, else 422.
- **Spam:** hidden honeypot field (`_hp`) + per-caller rate limit (in-process;
  single instance) + request size cap. Honeypot hits are **accepted with
  `is_spam = true`** — the same `201` and the same body a real submission gets,
  so bots learn nothing — but no notifications and no acknowledgment email, and
  visible in a spam view with a "not spam" action that promotes the lead and
  fires the pipeline. No silent drops. (Kickoff wrote "normal 200" here; what
  mattered was that the answer be indistinguishable, and every accepted
  submission creates a lead, so `201` is the one answer both cases give.)
- **CORS:** per-form `allowed_origins` allowlist, echoed on preflight.
  Understood to be browser etiquette, not security — the rate limit and
  honeypot carry the load.
- **Idempotency:** hash of `form_key` + normalized payload; an identical
  submission within ~10 minutes returns the original lead's response and
  fires nothing twice.
- On accepted non-spam lead: create lead + `created` event, send both
  emails, send push — each downstream failure is logged, never blocks the
  201 to the form.

## Notifications

Full rationale: [ADR-0004](adr/0004-push-best-effort-email-guaranteed.md).

- **Push is the fast path; email is the guaranteed path.** Push is
  best-effort by design; the new-lead notification email (already MVP scope)
  is the channel that must always work. No PWA-independent third channel in
  MVP (ntfy/webhook deferred).
- Standard Web Push protocol via the `web-push` library. **VAPID keys
  auto-generate at first boot** into the data dir — zero operator setup.
- **Payloads use the Declarative Web Push JSON format.** iOS 18.4+ renders
  them with no service worker (the reliable path); other browsers fall
  through to a ~20-line service worker that parses the same JSON.
- iOS constraint (verified 2026-07): push works **only** for Home Screen web
  apps; iOS 26 opens any Home-Screen-added site as a web app by default; EU
  iOS has no PWA push at all (DMA) — a docs footnote for self-hosters.
  The PWA ships an install-helper screen (detect iOS Safari, walk through
  Add to Home Screen, request permission from a tap).
- Subscriptions stored in `push_subscriptions`; pruned on 404/410.
- **In-app fallback.** The push service is the browser vendor's choice, and
  some browsers grant notification permission with none to subscribe to
  (Brave with Google's push messaging off, de-Googled Chromium). When
  `pushManager.subscribe()` refuses, the toggle switches to in-app
  notifications instead: while Philo is open, the app holds
  `GET /api/v1/push/live` — Server-Sent Events, read with `fetch` because
  `EventSource` cannot send the bearer token — and shows each lead through
  the service worker. The stream is fed by the same lead-created hook as
  email and push, so it fires for exactly the same leads, and carries the
  push payload's `notification` object unchanged. In memory (one process per
  instance); the server ends each stream after 15 minutes so the client
  reconnects with a current credential. A browser with a working
  subscription never opens it.
- **Trigger: new lead only.** No stage-transition push in MVP — the person
  moving the card is the person who'd be notified.

## Email

- **SMTP is the interface; Resend is a provider.** Nodemailer over SMTP
  configured in the settings UI (host/port/credentials or URL, sender
  identity, reply-to), with a test-send button. Quick-start docs walk
  through Resend (`smtp.resend.com`); any SMTP provider works without code
  changes. SPF/DKIM/domain verification is provider-side — a docs section.
- **Replies go to a real inbox.** The acknowledgment sets `Reply-To` to the
  configured business address. Philo does not receive inbound email.
- **Templates live in the DB**, editable in the UI and via MCP. Engine:
  **Handlebars** (HTML-escaping by default). Variables: `{{lead.name}}`,
  `{{lead.email}}`, `{{lead.phone}}`, `{{lead.source}}`,
  `{{lead.fields.*}}`, `{{business.name}}`, `{{lead_url}}`. First boot
  seeds a working notify + ack pair.
- **Triggers: lead creation only** (notify owner + acknowledge submitter).
  The `trigger` enum on `email_templates` is the designed-in door for
  stage-transition emails (e.g. a templated rejection) as a fast-follow.
- **A submission, not every new row.** A lead *entered* through MCP or REST
  — an agent writing up a phone screen — sends neither email. Both
  templates are written for something that just arrived: the
  acknowledgment would thank a person for an application they never sent,
  and the notification would announce a lead to the operator whose own
  agent filed it. An email nobody asked for is the one failure here that
  cannot be taken back, so the default is silence.
  - Withholding the in-process hook does not carry that on its own. The
    boot sweep exists to catch up anything a crash left owed, and it asks
    only "recent, non-spam, nothing sent yet" — to which an entered lead
    and an interrupted one look identical. So the fact is recorded
    durably: `createLead` stamps `via: "api"` on the `created` event, and
    the send path reads it.
- Sends are recorded as `email_sent` events on the lead's timeline.

## Auth and access

Every credential is a bearer token on `/api/v1` — there is no cookie, and so
no CSRF surface. Every credential acts for a user with exactly that user's
authority — the PWA's token, an API key, a connector's grant alike — and the
timeline records which credential acted. Details in
[ADR-0006](adr/0006-headless-server-sdk-clients.md) and
[ADR-0007](adr/0007-agents-act-as-their-user.md).

1. **UI: OIDC sign-in.** The PWA is a public OIDC client of the built-in IdP:
   authorization code + PKCE, an operator-scoped access token in memory and a
   rotating 30-day refresh token. The IdP's dialog takes the local email and
   password (argon2id, rate-limited) and, on an empty instance, creates the
   account — first-boot setup. Set `PHILO_OIDC_ISSUER` and an external OIDC
   provider replaces the built-in one. Rejected: magic links (login would
   depend on SMTP config — break email, get locked out of the thing that
   configures email). No 2FA in MVP; passkeys, or the external IdP's own, are
   the upgrade.
2. **API keys** (`philo_`-prefixed, hashed at rest, created in settings) for
   headless callers — Claude Code, scripts, cron — against MCP and REST.
3. **OAuth 2.1 authorization server** for OAuth-demanding MCP clients
   (claude.ai connectors): `401` + `WWW-Authenticate`, protected-resource
   metadata (RFC 9728), AS metadata (RFC 8414), dynamic client registration
   (RFC 7591), authorization-code + PKCE, refresh tokens. Single
   login+consent page (one POST authenticates and consents — a
   simplification proven in [Ollie](https://github.com/olliefms/ollie)). Built on the MCP TypeScript SDK's auth
   primitives — its schemas, error classes, and redirect-URI matching —
   served by Hono rather than the SDK's Express router; see
   [ADR-0005](adr/0005-oauth-server-on-hono.md), which also records the
   token-lifetime and consent-page decisions. A connector's token carries agent
   authority, the same as an API key.

## MCP surface

Streamable HTTP at `/mcp`, served by `apps/mcp` — a client of the API like the
PWA, calling it through `@philo/sdk` with the caller's own token. Auth: an API
key bearer, or an OAuth access token for a connector client — the `401` names
the protected-resource metadata that leads one to the authorization server.

MVP tool set:

- **Leads:** `list_leads` (filters: stage, form, spam, date; FTS5 `search`),
  `get_lead` (record + timeline), `create_lead`, `update_lead`,
  `move_lead_stage`, `add_lead_note`, `delete_lead` (`destructiveHint`,
  permanent — see Erasure); `update_lead` edits `details`, and
  attachments get add, fetch and remove tools — `get_lead` lists them (ADR-0008)
- **Funnel:** `list_stages`, `create_stage`, `update_stage` (rename,
  terminal flag), `reorder_stages` (whole funnel), `delete_stage` (empty,
  non-last stages only)
- **Email templates:** `list_email_templates`, `get_email_template`,
  `update_email_template`, `preview_email_template` (renders against a
  sample or real lead) — so an agent can design the emails
- Read-write from day one; a recruiting agent that can pre-screen and
  advance a lead is the point of the requirement.

Alongside MCP, the server serves a public, hand-written `GET /llms.txt` —
an agent-oriented tour of every surface (a convention carried from Ollie).

## Deliberately deferred (decisions, not omissions)

| Deferred | Why / trigger to revisit |
|---|---|
| Multi-pipeline UI | Schema supports it (seeded Default pipeline); UI when the sales use case arrives. |
| Stage-transition emails/push | `trigger` enum is the door; fast-follow after MVP. |
| Vector/semantic search | FTS5 suffices at MVP corpus size; sqlite-vec in the same file when a corpus worth embedding exists. |
| Custom-field engine | JSON `fields` + form-level convention; backfill path documented in ADR-0003. |
| ntfy / webhook third notification channel | Email is the guaranteed channel; add if push+email proves insufficient. |
| Repeat-applicant hint (email match on old lead) | Nice-to-have UI affordance, post-MVP. |
| Passkeys / 2FA | argon2id + rate limiting + single-tenant blast radius is the MVP line. |
| Delivery webhooks (bounce/open tracking) | Lost by choosing SMTP-generic; revisit only if deliverability becomes a real problem. |
| Agent automation workflows (triage, shadow review) | Ollie's are repo-proven; adopt after there's code to review. |
| `assigned_to` / ownership | 1–2 users per instance; add when a real second user needs it. |
| Logo / visual branding | Business name only in MVP; revisit once attachments ([ADR-0008](adr/0008-lead-details-and-attachments.md)) have built the upload machinery. |

## Open questions

None outstanding — all kickoff questions were resolved in review
(2026-07-28):

1. **Default seeded stages** — `New → Contacted → Qualified → Closed
   (terminal)` confirmed; the operator renames in-app.
2. **Backup guidance** — docs say "copy the data dir," nothing more; no
   replication tooling documented.
3. **`llms.txt`** — carried (see MCP surface).
4. **Instance branding** — business name only; logo deferred (see table).
5. **Intake form fields** — out of scope for this repo: the form lives in
   the website's own codebase, and any non-core field it submits flows into
   the `fields` JSON column without schema work here.
