# 0006 — Headless server, an SDK that tracks it, and the PWA and MCP as clients

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** the "a token reaches `/mcp` only" and "one scope" decisions
  of [ADR-0005](0005-oauth-server-on-hono.md); the rest of ADR-0005 stands.

## Context

The MVP shipped as one process that did everything: the REST API, the MCP
endpoint, the OAuth server, the PWA's static files, and a cookie session that
only the PWA could use. Each surface reached the service layer by its own road
— the PWA over REST with a cookie, MCP by calling service functions in-process
— so there were two implementations of "what an agent may do" and two places
a contract could drift.

The maintainer's other projects use a different shape, and Philo should match
it: the server is headless and serves the API plus the identity provider's own
dialogs; an SDK that tracks the server is the only way clients reach the API;
the PWA (the human UI) and the MCP server (the agent UI) are clients of that
SDK, on equal footing with any third-party integration. Operators who already
run an identity provider should be able to point Philo at it instead of the
built-in one.

## Options considered

### Option A — Keep the monolith, add an SDK beside it

- Pro: least churn.
- Con: the PWA keeps a cookie path nobody else can use, MCP keeps calling the
  service layer directly, and the SDK becomes a third consumer rather than the
  only one. It would drift, because nothing in the repo would depend on it.

### Option B — Headless server; SDK; PWA and MCP as SDK clients

- Pro: one contract (`/api/v1`), one way to reach it (a bearer token through
  `@philo/sdk`), and the two UIs exercise the SDK on every change.
- Pro: identity is replaceable. Because every client holds a bearer token
  obtained by standard OIDC, swapping the built-in IdP for an external one
  changes where tokens come from, not how they are used.
- Con: a real reorganisation, and the PWA's login becomes a redirect flow.

### Option C — Split into separate repositories

- Con: the server and SDK must move in lockstep; a monorepo keeps that a single
  PR. Rejected.

## Decision

**Option B, in the existing monorepo.** Layout:

| Path | Package | Role |
|---|---|---|
| `packages/server` | `@philo/server` | Headless. `/api/v1`, form intake, the OIDC IdP and its dialogs, `/version`, `/llms.txt`. Serves no UI files. |
| `packages/sdk` | `@philo/sdk` | Typed client for `/api/v1`, plus an OIDC authorization-code + PKCE helper for public clients against any issuer. No runtime dependencies. |
| `apps/web` | `@philo/web` | The PWA. Signs in through the IdP, then talks to the API only through the SDK. |
| `apps/mcp` | `@philo/mcp` | The MCP server. A protected resource that forwards the caller's bearer token to the API through the SDK. |
| `apps/standalone` | `@philo/standalone` | The single-container deployment: hosts the server, the MCP app and the built PWA in one process, so `docker run` stays one command. |

The standalone host is composition, not a back door: the MCP app is handed
the server's `fetch` as the SDK's transport, so an in-process call goes through
exactly the HTTP handling a remote one would, auth included.

### Auth, as built

- **`/api/v1` is bearer-only.** The session cookie, and with it the CSRF and
  JSON-content-type layers that existed only to protect a cookie, are gone.
  No ambient credential means CORS adds no authority, so the API answers any
  origin — which is what lets the PWA be hosted elsewhere.
- **Three kinds of bearer, two levels of authority.** An *operator* holds a
  token with the `operator` scope; an *agent* holds a `philo_` API key or a
  token with the `mcp` scope. Agents reach everything except what ADR-era
  `requireUser` already withheld from keys: minting keys, push subscriptions,
  SMTP credentials, and the account itself. The timeline actor follows the
  credential: `user:<id>`, `api_key:<id>`, or `oauth:<client>`.
- **The PWA is a pre-registered first-party public client**, `philo-web`,
  whose redirect URI is built from `PHILO_APP_URL` (default: the public base
  URL). Only it is granted `operator`; a dynamically registered client is
  granted `mcp`, whatever it asks for.
- **The built-in IdP is OIDC.** Discovery at
  `/.well-known/openid-configuration`, an ES256 signing key generated into the
  data dir on first boot, `id_token` when `openid` is requested (nonce carried
  through), `/oauth/userinfo`, `/oauth/jwks`, and RFC 7009 `/oauth/revoke` so
  signing out actually ends the grant. Access tokens stay opaque and
  database-backed, so revoking a client still cuts it off at once.
- **First-boot setup is an IdP dialog.** While no account exists, the
  authorize page for the first-party client asks for one instead of a
  password; creating it completes the authorization in the same POST.
- **External IdP.** With `PHILO_OIDC_ISSUER` set, the built-in dialogs and
  token endpoints are switched off and the API accepts JWT access tokens from
  that issuer, verified against its JWKS (`PHILO_OIDC_AUDIENCE`, optional).
  The token's `email` claim names the account; on an instance with no account
  yet, the first valid token creates it. A token whose `azp`/`client_id` is
  `PHILO_OIDC_CLIENT_ID` — the PWA's client at that IdP — carries operator
  authority; any other client is an agent. The PWA learns which issuer to use
  from `GET /api/v1/auth/config`.

## Consequences

- One contract to keep stable, and two in-repo clients that fail their tests
  when it moves. A change to a response shape is a change to the SDK in the
  same PR.
- The PWA no longer works without JavaScript-held tokens. The access token
  lives in memory; the refresh token in `localStorage`, rotated on every use.
  That trades the cookie's immunity to script theft for portability; the CSP
  and the absence of third-party script are what bound it.
- The IdP has no session of its own, so every authorization asks for the
  password. With 30-day rotating refresh tokens a person signs in about once a
  month per device, which is the same cadence the cookie had.
- MCP gained a network hop when deployed apart from the server. In the
  standalone image it is an in-process function call.
- The `sessions` table is unused and left in place; dropping it is a migration
  for a release that wants one.
- Revisit if a second human role appears (scopes would need to grow), or if an
  external-IdP deployment needs group-based authorization rather than "this
  email is the operator".
