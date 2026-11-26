# 0012 — Several users, with a user and an admin role

- **Status:** Accepted
- **Date:** 2026-11-26
- **Supersedes:** the single-account parts of
  [ADR-0005](0005-oauth-server-on-hono.md),
  [ADR-0006](0006-headless-server-sdk-clients.md) and
  [ADR-0007](0007-agents-act-as-their-user.md), listed under
  [What this replaces](#what-this-replaces); the rest of each stands.

## Context

Philo was built around one account. The built-in IdP creates it at first-boot
setup and never another (ADR-0006). An external IdP binds the first verified
token to it and refuses every later person (`findOrProvisionUser`). ADR-0007
gave every credential "one level of access", and backfilled API keys "to the
instance's account — single-tenant, there is only one." DESIGN.md left
ownership out because an instance has "1–2 users".

That was never the intent. A small business has several people working its
leads — a recruiter and an owner, two partners in a practice — and today they
either share one login, which makes the timeline's `user:<id>` say nothing, or
cannot use Philo at all. ADR-0006 named the trigger for revisiting this: "a
second human role appears, or an external-IdP deployment needs group-based
authorization rather than 'this email is the operator'." Both have arrived.

Two needs pull against each other. Everyone who works leads needs the same
reach over them, or the funnel stops being shared. But configuring the
instance — the funnels and their stages, the website forms, the mail server,
the emails Philo sends in the business's name, the webhooks that copy every
lead elsewhere, and who may sign in — is a different job, and in a business
of three it usually belongs to one person. Single-tenancy still holds: one
business per instance, permanently. This is several people in one business.

## Options considered

### Option A — A shared account

Every person signs in as the one account (with an external IdP: every holder
of an admission scope maps to it, whatever their `sub`).

- Pro: almost no code.
- Con: the timeline records `user:1` for everyone, so it no longer says who
  moved a lead — the accountability ADR-0007 keeps ("the timeline still names
  the credential") is lost. API keys, push subscriptions and sign-out become
  shared; removing one person means changing everyone's password.
- Con: no way to keep configuration with one person.

### Option B — Several equal users

One account per person, every account with full authority.

- Pro: small. ADR-0007 already anticipates it.
- Con: anyone who works leads can also repoint the mail server, add a webhook
  that copies every lead to an outside URL, delete a funnel, or — once people
  can be added — add more people. In a business the person who works leads
  and the person who runs the system are often not the same.

### Option C — Two roles: user and admin

One account per person. A **user** works leads; an **admin** also configures
the instance and manages people.

- Pro: the line most small teams draw anyway, and maps onto what an external
  IdP can already express as two scopes.
- Con: every route needs a role, and the PWA and MCP have to follow it.

### Option D — More roles, or per-lead ownership

A read-only viewer, a per-funnel manager, `assigned_to` with leads visible
only to their owner, per-lead ACLs.

- Con: each is a policy engine Philo would have to grow, test and explain, for
  a business of a handful of people who already trust each other with the
  whole funnel. DESIGN.md defers `assigned_to` until a real second user needs
  it; visibility rules on top of it are further out still.
- Con: a viewer role is easy to add later on the same mechanism if anyone asks.
  Nobody has.

## Decision

**Option C.** Every account has exactly one role, `user` or `admin`. An admin
can do everything a user can. There are no other roles, no per-funnel roles,
and no per-lead permissions: **leads stay unowned**, and every user sees and
works every lead in every funnel, as DESIGN.md has it.

### What each role may do

- **user** — everything about leads: list, search, read, create, edit
  (`details`), move between stages, add notes, add/fetch/remove attachments,
  promote out of spam, and **delete**. Read the funnels and stages, which the
  board needs. Their own API keys, push subscriptions and account. Read the
  list of people (names and roles, so the timeline can name them).
- **admin** — also: create, change and delete funnels and stages (which
  includes each funnel's intake form and sender overrides); the instance's
  email settings (SMTP, sender identity, business name) and test-send; email
  templates (read, edit, preview, test-send); webhooks (all of it, reading
  included); and people — invite, change role, deactivate, reactivate, issue a
  password-reset link.

Deleting a lead is a user's call because it is part of working leads: spam,
duplicates and erasure requests (DESIGN.md, Erasure) arrive at whoever is on
the funnel, and making them wait for an admin would delay an erasure without
protecting anything — any user can already edit away everything a lead holds.
Everything under `/api/v1/settings`, `/api/v1/webhooks` and `/api/v1/users`
writes, and every write to `/api/v1/funnels` and `/api/v1/stages`, is admin.
The full route-by-route matrix lives in the implementation PR's tests, not
here; the rule above is the decision.

A refused call is `403` with `{ "error": "admin_required" }`. With an external
IdP it also carries `WWW-Authenticate: Bearer realm="philo",
error="insufficient_scope", scope="<admin scope>"`, so an agent whose token
lacks the admin scope can ask for it.

### Where a role lives

- **Built-in IdP:** on the account, `users.role`. Read on every request, with
  the account the credential resolves to, so a change takes effect on the
  next request of every credential that account holds.
- **External IdP:** derived from the access token's scopes **on every
  request**, never trusted from storage. Two settings name the scopes:
  - `PHILO_OIDC_USER_SCOPE` — holding it admits a person as a user.
  - `PHILO_OIDC_ADMIN_SCOPE` — holding it makes them an admin. **Admin implies
    user**: a token with the admin scope alone is admitted as an admin.

  Both or neither: setting one without the other is a startup error, because
  an instance whose IdP can name nobody an admin cannot be configured.
  Scopes are read from `scp` (an array) or `scope` (a space-separated
  string). Revoking a scope at the IdP therefore takes effect when the
  person's current access token expires. The role last derived is also
  stored in `users.role`, with `users.role_confirmed_at`, for display, for
  notification recipients and for API keys (below) — it is a cache of the
  IdP's answer, refreshed when a token shows a different one, never an
  authority over a token.

  An admin cannot change an externally-managed role in Philo (`409
  role_managed_by_idp`); they change it at the IdP. They can deactivate the
  account (below), which Philo enforces whatever the IdP says.

### External IdP: admission and provisioning

With the two scopes set, admission is: a valid signature from
`PHILO_OIDC_ISSUER`; an `aud` naming `PHILO_OIDC_AUDIENCE` when set; a client
the rules below admit; and **the user or the admin scope**. A token that
verifies but holds neither is refused with `403`, `{ "error":
"insufficient_scope" }` and `WWW-Authenticate: Bearer realm="philo",
error="insufficient_scope", scope="<user scope>"` — not 401, which would send
a client round the same authorization again. The check runs **before** any
binding or provisioning, so a token without the scope can never claim or
create an account. The MCP endpoint passes that 403 through with its header,
adding `resource_metadata`.

An admitted token then resolves to its account by `iss`+`sub`:

- **Bound subject:** that account.
- **Unbound, and an account that was never bound has the token's verified
  email** (from the token, or the provider's userinfo when the token carries
  none): that account is bound to the subject, once — today's rule, unchanged.
- **Otherwise:** a new account is provisioned for this subject, with the
  verified email and the token's `name`. One account per `iss`+`sub`. A
  verified email already held by an account bound to another subject is
  refused, as now: two people cannot share an address.

**Without the scopes set,** an external IdP behaves exactly as before this ADR:
one account, provisioned by the first verified token, every other subject
refused, and that account is an admin. Several users through an external IdP
need the scopes, because without them the IdP has no way to say who may come
in, and every person able to sign in to any application at that IdP through
Philo's client would become a user.

**A person who loses the scope** is refused at their next token, with the 403
above. Their account stays, with everything it did on the timeline. When a
bound subject's token is refused for want of the scope, Philo records the
account as having no access (`users.role` null) — so its API keys stop
working, its push subscriptions are deleted, and it receives no notification
email. If the scope comes back, the next token restores the role.

**The PWA's client and agents.** A token from `PHILO_OIDC_CLIENT_ID` is the
person (`user:<id>` on the timeline); a token from any other admitted client
is an agent acting for them (`oauth:<client_id>`). With the scopes **and** the
audience both set, `PHILO_OIDC_AGENT_CLIENT_IDS=*` admits **any client** as an
agent, which is how self-registering MCP clients (RFC 7591 dynamic
registration) connect, since their client ids cannot be listed ahead of time.
The audience proves the IdP minted the token for this instance; the scope
proves the IdP's policy let this person in. Together they do the job the
allow-list did — "a valid signature alone grants nothing" — so the wildcard is
a startup error without both, and mixing `*` with listed ids is a startup error
too. A token that names no client is still refused. Listed ids work as today.
The MCP endpoint's protected-resource metadata advertises the scopes agents
should ask for: the user scope (plus `offline_access`), or a configured value.

### Built-in IdP: people

- **First boot:** the setup dialog creates the first account, and it is an
  **admin**. Setup is open only while no account exists, as now.
- **Adding someone:** an admin invites them by email address and role. Philo
  creates the account with no usable password and returns a **one-time invite
  link**, shown once, like an API key's secret, for the admin to pass on by
  whatever channel they like. The link opens an IdP dialog where the person
  sets their own name and password; it is single-use, stored hashed, and
  expires after 7 days. An invite link rather than an initial password,
  because the admin never knows anyone's password and nothing needs a
  forced-change flow; and not an emailed link, because sign-in must never
  depend on SMTP (DESIGN.md, Auth and access) — though when SMTP is set up
  Philo may also offer to email it.
- **Changing a role:** an admin sets it. Takes effect on the next request.
- **Removing someone:** an admin **deactivates** the account. It is never
  deleted: the timeline's `user:<id>` must keep resolving to a name. On
  deactivation every OAuth grant (access, refresh tokens and codes) and API key
  the account holds is revoked and its push subscriptions deleted; sign-in is
  refused; nothing it did on any lead changes. Reactivating restores sign-in,
  not the revoked credentials. Deactivation works the same with an external IdP,
  where it also refuses the subject whatever scopes its tokens carry.
- **The last admin** cannot be demoted or deactivated (`409 last_admin`), and
  nobody can deactivate or demote themself, so an instance always has an
  active admin who knows it.
- **Password reset:** an admin issues a one-time reset link for another
  account, on the same mechanism as an invite (24 hours). Using it sets the
  new password and revokes the account's OAuth grants. A person changes their
  own password on their account screen, giving the current one. An admin who
  is the only admin and has lost their password has no one to ask; for them
  the server ships a command that prints a reset link for an address, run
  where the data directory is (`docker exec`), since whoever can run it can
  already read the database.

### Credentials

ADR-0007 stands with one word changed: every credential acts as its user
**with that user's role**, no more and no less.

- **API keys** act with their user's current role, read on every request.
  With an external IdP, that is the stored role — the IdP never sees an API
  key — so a key works only while the role was confirmed by one of the
  person's tokens in the last 30 days. Someone whose scope is revoked at the
  IdP and who never signs in again loses their keys within that window, or at
  once when an admin deactivates them.
- **Built-in OAuth tokens** (the PWA, connectors) act with their user's
  current role. The `operator` and `mcp` scopes still only say which kind of
  client holds the grant.
- **External tokens** act with the role their scopes name — never more than
  the token holds, even when the person is an admin and asked for less.
- A deactivated user's credentials were revoked at deactivation; one that
  somehow survives is refused, because every resolver checks the account.

### What changes that assumed one account

- **New-lead notification email.** The funnel's `notify_recipients` list
  decides, as today: who works a funnel's leads is configuration, and an
  admin sets it. With an empty list it goes to every active admin, where
  today it goes to the only account. There is no per-person toggle.
- **Web push** already goes to every subscription; subscriptions are per
  device, so turning push on is each person's own choice. A deactivated or
  no-access account's subscriptions are deleted.
- **The VAPID contact**, used for a non-https base URL only, becomes the
  earliest active admin's email rather than the earliest account's.
- **"First user" lookups:** first-boot setup still keys on "no account
  exists"; nothing else may assume an account is the only one.
- **`/api/v1/auth/session` and `/auth/principal`** gain `role`. **`GET
  /api/v1/users`** lists people (id, name, email, role, status) for every
  user, so the timeline can name them; changing them is admin-only.
- **The PWA:** an account screen of one's own (name, email, password, email
  notifications); a People section for admins; Server settings, funnel
  settings, stage editing and webhooks shown to admins only. The timeline
  names a colleague instead of "A user".
- **Timeline actors** keep naming the credential (`user:<id>`, `api_key:<id>`,
  `oauth:<client>`). A lead event also records which user the credential
  acted for, so an agent's action is attributable to a person once there is
  more than one.
- **MCP** lists only the tools the caller's role can use; the API still
  enforces every call.

### Migration

Every existing account becomes an **admin** — on any instance today there is
at most one, and it could already do everything. No account, key, token,
lead or setting changes otherwise. An external-IdP instance keeps its
single-account behaviour until the operator sets the two scopes; its account's
role is then whatever its next token says.

### What this replaces

- **ADR-0005**, "One scope, `mcp`": its premise "Single-tenant with one
  operator account". (The scope decision itself was already superseded by
  ADR-0006.)
- **ADR-0006**, "Auth, as built", External IdP: "The operator is bound to the
  token's `iss`+`sub`" becomes *each account*; "On an instance with no account
  yet, the first valid operator token … creates it" holds only without the
  scopes; "A token whose `azp`/`client_id` is `PHILO_OIDC_CLIENT_ID` … carries
  operator authority" becomes *carries the role its scopes name*; "Agents are
  allow-listed in `PHILO_OIDC_AGENT_CLIENT_IDS`; a token from any other client
  … is refused" gains the wildcard rule above. "First-boot setup is an IdP
  dialog" gains invites. The "Revisit if a second human role appears"
  consequence is this revisit.
- **ADR-0007**, Decision: "There is one level of access, and it belongs to the
  person" becomes two levels, each belonging to the person; "External-IdP
  tokens from the PWA's client or an allow-listed agent client" gains clients
  admitted by the wildcard, and their authority is capped by the token's
  scopes. Its consequences on SMTP settings and API keys now apply to an
  admin's agents; a user's agents cannot reach the SMTP settings. Its last
  consequence — "agents inherit whatever their own user has" — is this ADR.
- **DESIGN.md**, Auth and access, the Erasure section's "open to any
  credential", and the deferred `assigned_to` line are updated with the code.

## Consequences

- Several people can share an instance and stay distinguishable on the
  timeline, and configuration can sit with one of them.
- Every route has a role, which is one more thing a new route must declare.
  Admin-only is the default for anything outside leads, mirroring "private
  until listed public": a route is user-reachable only when it is listed so on
  purpose, and a test walks every route.
- With an external IdP, who may use Philo and as what is decided at the IdP.
  Philo's only override is deactivation. An IdP that refuses a request for a
  scope the person lacks, rather than leaving it out, needs the PWA's
  requested scope configured with that in mind.
- No owner on leads, no viewers, no per-funnel admins. If a team needs any of
  them, they are a new ADR on top of these two roles.
- An admin's agent can invite people and change roles, as ADR-0007 implies.
  That is no more than an admin's agent can already do by adding a webhook
  that copies every lead out; a narrower per-credential scope remains the
  upgrade if it ever matters.
- Deactivated accounts keep their email address, which an erasure request
  from a former colleague would have to deal with by hand. Revisit if that
  becomes real.
