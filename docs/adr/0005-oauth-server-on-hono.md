# 0005 — OAuth 2.1 server built on the MCP SDK's primitives, served by Hono

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

DESIGN.md (Auth and access) requires an OAuth 2.1 authorization server so
that connector-style MCP clients — which will not carry an API key — can
reach `/mcp`. It also says the server is "implemented against the MCP
TypeScript SDK's auth framework rather than hand-assembled", because
hand-rolling an authorization server is exactly the kind of security-critical
work worth borrowing.

On implementing it, the SDK's auth framework turned out to be two layers with
very different portability:

- **Protocol layer, framework-agnostic** — the RFC 7591/8414/9728 zod
  schemas in `shared/auth.js`, the OAuth error hierarchy in
  `server/auth/errors.js`, the `OAuthRegisteredClientsStore` and
  `AuthInfo` contracts, and `redirectUriMatches`, which implements the
  RFC 8252 §7.3 loopback-port rule.
- **HTTP layer, Express-only** — `mcpAuthRouter` and every handler under
  `server/auth/handlers/`, each an `express.Router` wired to `cors`,
  `express-rate-limit`, and `express.json()`. `OAuthServerProvider.authorize`
  takes an Express `Response` in its signature, so even the provider
  interface cannot be implemented without Express.

Philo serves everything on Hono (ADR-0001's stack). There is no Hono
equivalent in the SDK: the only Hono code it ships is an example of the
streamable-HTTP transport, which is the piece Philo already uses at `/mcp`.

## Options considered

### Option A — Add Express and mount `mcpAuthRouter`

- Pro: the closest reading of "not hand-assembled"; the SDK owns the
  endpoint behaviour outright.
- Con: two HTTP frameworks in one process. Hono on `@hono/node-server`
  exposes the raw Node request only as an escape hatch, and Express's
  handlers depend on prototypes an Express *app* installs — so this means
  running a real Express app behind Hono and handing requests across.
- Con: it does not survive the test suite. Every route test drives
  `app.request()` with a Web `Request` and no socket behind it; an Express
  app needs `IncomingMessage`/`ServerResponse`. The OAuth flow would be the
  one surface with no integration coverage, which is the opposite of the
  issue's acceptance criteria.
- Con: the SDK's rate limiting is `express-rate-limit`, a second and
  differently-behaved limiter next to `FailureThrottle` — including on the
  endpoint that checks the operator's password.

### Option B — Hono endpoints over the SDK's protocol layer

- Pro: one framework, one limiter, one test harness; the flow is covered by
  the same `app.request()` integration tests as every other surface.
- Pro: the parts most worth borrowing are still borrowed — request and
  response shapes are validated by the SDK's own zod schemas, errors are the
  SDK's error classes, and redirect-URI matching is the SDK's implementation
  rather than a second attempt at RFC 8252.
- Con: the HTTP wiring — endpoint routing, grant dispatch, client
  authentication — is Philo's code, and moves with the RFCs on its own.

### Option C — A different OAuth server library

- Con: every candidate is either Express middleware with the same problem,
  or a full identity product aimed at a multi-tenant deployment Philo does
  not have and never will.

## Decision

**Option B.** The authorization server lives in `server/src/oauth/`, served
by Hono, built on the SDK's schemas, error classes, and `redirectUriMatches`.
`OAuthServerProvider` is deliberately *not* implemented: its signature is
Express-bound, so implementing it would be a shape with no consumer.

Shape of what was built, where a choice was open:

- **One scope, `mcp`.** Single-tenant with one operator account: a token
  either reaches the agent surface or it does not. Requested scopes are not
  honoured, and the token response says what was granted.
- **A token reaches `/mcp` only.** `/api/v1` still takes a session cookie or
  a `philo_` key — OAuth exists here for connector clients, and widening it
  would mean two ways to hold the same authority.
- **Rotating refresh tokens**, sharing the 30-day window a browser session
  gets. Reuse of a spent token fails; it does not revoke the family, so
  whichever holder refreshes first keeps the grant. Family revocation on
  reuse is the upgrade if a real deployment ever needs it.
- **https and loopback-http redirect URIs only.** A private app scheme is
  claimable by any installed app, and the clients this exists for — connector
  clients, and local ones on an ephemeral loopback port — need neither. A
  local MCP client that insists on a private scheme uses an API key instead.
- **Non-expiring client secrets** (`client_secret_expires_at: 0`), against
  the SDK's 30-day default: an expiring secret breaks a working connector a
  month later with nothing on screen saying why.
- **The consent page is server-rendered HTML**, not a PWA screen — it is
  reached by a browser redirect from another origin, before any session
  exists, and the PWA's router has no business in that flow.
- **One POST authenticates and consents**, per DESIGN.md. The password in
  the form is what proves who is approving, which is why no session-backed
  consent step and no CSRF token are needed; `csrf()` is still applied as
  defence in depth.

## Consequences

- Philo owns the OAuth endpoint behaviour and must track the RFCs itself.
  The flow tests in `server/test/oauth.test.ts` are the guard: they exercise
  discovery, registration, consent, exchange, and refresh end to end.
- If the SDK ever ships a Web-standard (Hono/fetch) auth router — as it did
  for the streamable-HTTP transport — this is worth revisiting, and the
  protocol layer already lines up.
- No UI for reviewing or revoking a connector's grant. Deleting the
  `oauth_clients` row cascades every token; a screen for it is post-MVP.
