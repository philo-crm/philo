# 0007 — An agent acts with its user's authority, no more and no less

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** the two-level "operator / agent" authority of
  [ADR-0006](0006-headless-server-sdk-clients.md), and the narrower guard
  (`requireUser`) that DESIGN.md's Auth and access section gave API keys

## Context

ADR-0006 kept a rule from the MVP: an API key, and then any connector's OAuth
token, reached everything except creating and revoking API keys, push
subscriptions, the SMTP settings and their test-send, and the account itself.
Those answered 403 `session_required`.

That is not what an agent is for here. The person who creates a key in
Settings, or approves a connector on the consent page with their own
password, is delegating to it. An agent that can do less than its user has to
send the person back to the app for part of every job. An agent that can do
more would be a privilege escalation. The intent is that an agent can do
exactly what its user can.

## Decision

**Every credential acts as a user, with that user's authority.** There is one
level of access, and it belongs to the person.

- **API keys belong to the user who created them** (`api_keys.user_id`,
  cascading on delete). Keys minted before this change are backfilled to the
  instance's account — single-tenant, there is only one.
- **OAuth tokens carry the user who approved them**, as they always did. The
  `operator` and `mcp` scopes remain on the wire, but only say which kind of
  client holds the grant. Neither grants or withholds anything.
- **External-IdP tokens** from the PWA's client or an allow-listed agent
  client resolve to their user by the bound `iss`+`sub`, exactly as the PWA's
  do.
- **The timeline still names the credential**: `user:<id>`, `api_key:<id>` or
  `oauth:<client>`. Same authority, still distinguishable afterwards.
- `requireUser` and the 403 `session_required` answer are gone.

## Consequences

- An agent can mint and revoke API keys. A key minted by an agent belongs to
  the same user, and it does not die when the key or grant that minted it is
  revoked. Revoking everything an agent left behind means reviewing the key
  list. That is the price of "no less"; a per-credential scope is the upgrade
  if it ever becomes a problem.
- An agent can read and change the SMTP settings. The stored password is still
  write-only: no credential can read it back.
- An agent can register a push subscription for its user. That is harmless,
  and useless without a browser to receive it.
- If Philo ever has a second user with less authority than the first, it
  follows automatically: agents inherit whatever their own user has.
