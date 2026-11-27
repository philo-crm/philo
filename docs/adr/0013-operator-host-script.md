# 0013 — An opt-in operator host script in the PWA, with a top-bar slot

- **Status:** Accepted
- **Date:** 2026-11-26
- **Amends:** [ADR-0006](0006-headless-server-sdk-clients.md)'s "the CSP and
  the absence of third-party script are what bound it": an operator may now
  opt in to one script of their own. The rest of ADR-0006 stands.

## Context

Some operators run Philo beside other web apps under one sign-in: the same
external IdP, one account menu, a shared notification bell, an app switcher
that moves between them, and one theme that follows the person from app to
app. That shared top-bar chrome is the operator's, not Philo's. It differs
from one operator to the next and changes on its own schedule. Today the only
way to show it in Philo is to fork `AppShell.tsx` and its account menu, and
carry that patch through every upstream release.

The chrome also needs things only the PWA has: who is signed in and with what
role ([ADR-0012](0012-several-users-with-roles.md)), a token for the other
apps' APIs from the same IdP (the PWA's extra-token helper, proposed beside
this ADR, which asks the IdP for a second audience in a hidden frame), Philo's
router, its sign-out and its
theme store. A widget that cannot reach those is just a picture.

ADR-0006 keeps the PWA's refresh token in `localStorage` and says "the CSP and
the absence of third-party script are what bound it". The PWA's
Content-Security-Policy (philo-crm/philo#67) gives the first half substance:
it allows only `'self'` for script. Any seam that runs someone else's code in the page
contests the second half of that sentence, so it needs an ADR.

## Options considered

### Option A — A host script the operator names, with a slot and a context

The PWA loads one operator-supplied script after sign-in and hands it an
empty element in the top bar plus a small, versioned context object.

- Pro: the chrome renders in the page, so its popovers, focus and theme work
  like Philo's own, and it costs one script load.
- Pro: no upstream file is edited per operator. Philo keeps one seam.
- Con: the script runs with the page's authority. Nothing in a browser can
  sandbox a script that shares the document.

### Option B — The chrome in an `<iframe>`

- Pro: real isolation. The frame cannot read Philo's storage.
- Con: a popover cannot leave its frame, so an account menu or a notification
  panel is clipped to a strip of the top bar, or needs a second frame and a
  resize protocol. The theme cannot cross the frame boundary without another
  message channel, and every page load becomes two app loads.
- Con: the frame still needs tokens to be useful, so a `postMessage` API
  equivalent to Option A's context has to be built, plus the layout protocol.

### Option C — Each operator forks the top bar

- Pro: no new surface in Philo.
- Con: a merge conflict in the busiest UI file on every upstream release, and
  no shared contract, so every operator solves it again.

## Decision

**Option A, off by default.** With nothing configured, nothing loads and the
PWA's policy stays `'self'`, exactly as before.

### Configuration

All four values are environment variables, read and validated by the
server at startup. Neither goes in the settings database: a script URL is code
execution in every person's browser, and a settings field would let any admin
in the UI inject script into other people's sessions. Only whoever runs the
server can set it.

| Variable | Default | Meaning |
|---|---|---|
| `PHILO_WEB_HOST_SCRIPT_URL` | unset | A script the PWA loads after sign-in. An absolute `https:` URL (or `http://localhost` / `http://127.0.0.1` in development), or a path on the PWA's own origin. |
| `PHILO_WEB_HOST_CONFIG` | `{}` | A JSON object handed to the script verbatim as `ctx.config`. It is public — anyone can read it — so it holds no secrets. |
| `PHILO_WEB_ASSET_ORIGINS` | empty | Extra sources for the script's own assets (see [CSP](#content-security-policy)). |
| `PHILO_WEB_HOST_TOKEN_RESOURCES` | empty | A comma-separated allow-list of the resource indicators (RFC 8707) `ctx.getToken` may ask the IdP for. Empty means `getToken` always answers `null`. Philo's own audience (`PHILO_OIDC_AUDIENCE`, or the server's own URL with the built-in IdP) is refused at startup. |

A malformed URL, a `PHILO_WEB_HOST_CONFIG` that is not a JSON object, an
asset entry outside the rules below, or a token resource that is not an
absolute URL or names Philo's own audience is a startup `ConfigError`, never a
silent default.

Operators put a same-origin script beside the PWA without rebuilding it by
serving the path from the reverse proxy in front of Philo, or, with the
standalone image, from a mounted directory the image serves under a fixed
prefix; `docs/DEPLOYMENT.md` gives both.

### Delivery

A new public endpoint, `GET /api/v1/web/config`, answers
`{ "hostScriptUrl": string | null, "hostConfig": object, "hostTokenResources": string[] }` with
`Cache-Control: no-cache`. The SDK gets `philo.web.config()` and its type in
the same PR (ADR-0006). It is separate from `GET /api/v1/auth/config` so that
endpoint stays about sign-in, and it works the same when the PWA is hosted
apart from the server. It is public because the PWA reads it before it holds
a token; it reveals nothing the page would not load anyway.

### The contract

The script, when it runs, sets `window.PhiloHost`. The PWA calls its `mount`
once per signed-in shell:

```ts
interface PhiloHost {
  mount(ctx: PhiloHostContext): PhiloHostMount | void | Promise<PhiloHostMount | void>
}
interface PhiloHostMount {
  /** Philo controls the host now draws instead. Today only the account menu. */
  replaces?: ReadonlyArray<'account-menu'>
}
interface PhiloHostContext {
  /** Bumped only by a breaking change; new optional fields do not bump it. */
  version: 1
  /** An empty element at the right end of the top bar's actions. The host's until `signal` aborts. */
  slot: HTMLElement
  /** The IdP the PWA signs in with: the same values as GET /api/v1/auth/config. */
  issuer: string
  clientId: string
  user: { email: string; name: string | null }
  /** ADR-0012. */
  role: 'user' | 'admin'
  /** PHILO_WEB_HOST_CONFIG. */
  config: unknown
  /**
   * The extra-token helper, for a resource in PHILO_WEB_HOST_TOKEN_RESOURCES only.
   * null for any other resource, with the built-in IdP, or when the IdP refused.
   */
  getToken(request: { resource: string; scope: string; prompt?: string }): Promise<string | null>
  /** Client-side navigation inside Philo. Only a same-app path (one leading `/`, not `//`); anything else is ignored. */
  navigate(path: string): void
  /** Philo's own sign-out, revocation included. */
  signOut(): void
  /** The host cannot draw what it replaced: Philo shows its own account menu again. */
  fallback(): void
  /** Philo's own theme store: its stored choice, `data-theme` and the `theme-color` meta. */
  setTheme(theme: 'light' | 'dark' | 'system'): void
  /** Philo's own account-menu entries for this person's role (Server settings for an admin only). */
  accountItems: ReadonlyArray<{ label: string; path: string }>
  /** Aborted when the signed-in shell unmounts: sign-out, an expired session. The host drops its timers, listeners and tokens then. */
  signal: AbortSignal
}
```

The context hands over capabilities, not data: through it the host never
sees the refresh token or Philo's own access token, and gets tokens only for
the resources the operator allow-listed. That is a contract for a
well-behaved host, not a wall. The allow-list stops a buggy or over-curious
script from minting a token for Philo's own API or for every other API the
PWA's client may reach at the IdP. It does not stop a hostile one: such a
script can read the refresh token directly, or run the silent flow itself,
since the issuer must be in `frame-src` for the helper to work and the answer is posted to the page — see
[Trust](#trust).

### Behaviour

- The PWA injects the script (`<script async>`, classic) once per page, when
  the signed-in shell first mounts, and calls `mount` again with a fresh
  context after a later sign-in on the same page (an expired session). When
  a host script was loaded, **sign-out reloads the page**, so nothing the
  script left resident survives into the next person's sign-in. **It never
  loads the script on a signed-out screen** — loading, sign-in, sign-in
  failure, the callback, or the hidden extra-token frame.
- **Philo's own controls stay until the host takes over.** The account menu
  renders as it does today and is hidden only once `mount` resolves with
  `replaces: ['account-menu']`. If the script fails to load, sets no
  `PhiloHost`, throws, rejects, or takes longer than 5 s (counted from
  injection, so a slow download counts), Philo logs once to the console,
  aborts that mount's `signal`, empties the slot and keeps its own menu for
  the life of the page. A late answer is ignored. Offline — when the script
  or what it loads is unreachable — the shell looks as it does without one.
- **Sign-out stays reachable after the host takes over.** A resolved `mount`
  does not prove the host drew a working menu: its own chunk can 404 later,
  it can throw while rendering, or its CSS can hide the menu at some width.
  So Philo keeps paths no host can remove:
  - it re-shows its own account menu if the slot is still empty 5 s after
    `mount` resolved, if the slot empties later while `signal` is live, or
    if the host calls `ctx.fallback()` to say it cannot draw;
  - a `/sign-out` route, reachable by typing it or from a bookmark, that
    signs out and returns to the sign-in screen whatever the top bar shows.
  Philo cannot detect a menu that renders but is hidden or unwired; the
  route is the guarantee for that case, and `DEPLOYMENT.md` names it.
- When the host replaces the menu, Philo's menu entries reach it as
  `accountItems`, so nothing Philo offers is lost. Philo's theme picker goes
  with its menu: from then on the host owns the theme and reports it through
  `setTheme`, so the first paint on the next visit is already right.
- The slot sits inside the top bar's action group, so it inherits its spacing
  and its narrow-screen layout. Its contents are the host's to fit.
- The contract is documented in `docs/DESIGN.md` under "Host chrome", and
  `docs/DEPLOYMENT.md` gains the four variables, the CSP they produce, the
  `/sign-out` route, and the Trust section's warning in its own words.

### Trust

The host script runs with the page's full authority. It can read
`localStorage`, including the refresh token; call the API as the signed-in
person; and read or change anything on screen. Philo does not pretend to
sandbox it. **An operator who sets `PHILO_WEB_HOST_SCRIPT_URL` trusts that
script, and everyone who can change it, exactly as much as Philo's own
code.** What this ADR does bound is how far that trust spreads:

- It is opt-in and environment-only, as above.
- **Same-origin is the recommended shape**: a file the operator ships beside
  the PWA, so it changes only when the deployment does. A cross-origin script
  URL trusts that origin's whole supply chain on every page load.
- Whatever the script loads from elsewhere — a component bundle, a
  stylesheet, fonts, an API — is listed explicitly, origin by origin, and the
  CSP refuses code from everywhere else. **The CSP limits what code can be
  loaded, not what can leave.** A compromised host script can read the
  refresh token and act as the person, on this page and off it. It can carry
  data out by top-level navigation (`location.href = …`, `window.open`),
  which no directive in the policy restricts; through WebRTC; through any
  listed origin that accepts writes; and, in an admin's session, by creating
  a webhook (ADR-0010) or an API key, which keeps pushing data off-box after
  the script is fixed. The CSP is not a backstop for a script the operator
  does not fully trust.
- Subresource integrity is not offered: a host whose script is meant to
  update independently of Philo would have to change Philo's config on every
  update, and the same-origin shape already gets the same pinning for free.

### Content-Security-Policy

The default policy (philo-crm/philo#67) is unchanged when nothing is
configured. With a host script:

- An absolute `PHILO_WEB_HOST_SCRIPT_URL` is added to `script-src` as that
  exact URL (without its query), not its whole origin. A path on the PWA's
  origin is already covered by `'self'`.
- `PHILO_WEB_ASSET_ORIGINS` is a comma-separated list. Each entry is an
  `https:` origin, **plus an optional path prefix** ending in `/`
  (`http://localhost` and `http://127.0.0.1` allowed for development). No
  query, fragment, wildcard, scheme-only source or keyword — no `*`, `data:`,
  `blob:`, `'unsafe-inline'`, `'unsafe-eval'`, `'strict-dynamic'`, nonce or
  hash. Each entry is added to `script-src`, `style-src` and `font-src` as
  given, and its origin alone to `img-src`.
- **A path prefix is defense in depth, not a boundary.** Under CSP Level 3 a
  source's path is checked only for the first request: once a request has
  been redirected, it needs to match only the scheme, host and port. Paths
  are also matched after percent-decoding, so `/static/..%2Fuploads/x.js`
  matches `/static/`, and a server that decodes `%2F` before routing serves
  `/uploads/x.js`. The same holds for the exact script URL. So the operator
  lists only origins that host no user-controlled content, and only URLs and
  prefixes under which nothing redirects. An origin that serves uploads or
  other user content — an IdP with avatars, say — is not listed at all; its
  assets are mirrored through a same-origin path instead.
- The host's API calls go through `PHILO_WEB_CONNECT_ORIGINS`, which the CSP
  change already defines.
- The extra-token helper's hidden frame needs the issuer's origin in
  `frame-src`, which the CSP change sets to `'self'` alone. Neither that
  change nor the extra-token change adds it today: **whichever of the
  extra-token and host-script implementation PRs lands second adds the
  issuer to `frame-src`** when an external IdP is configured, beside the
  issuer it already adds to `connect-src`. Until then `getToken` answers
  `null` after the frame times out.
  *Done:* the extra-token change landed second, and the follow-up to it adds
  the issuer to `frame-src`. It also serves `/auth/callback` with
  `frame-ancestors 'self'` instead of `'none'`, because the frame lands there,
  and keeps the service worker from answering that path from its cached shell.
- The extra-token helper must key its cache by resource, scope and `prompt`
  (today it keys by the first two; the host-script PR changes it), so
  a host call with a `prompt` the IdP will not answer silently does not mark
  that resource refused for Philo's own callers.
- The host must work without inline script or inline `<style>`: stylesheets
  come from listed origins, and a component styles itself with constructable
  stylesheets or the CSSOM, which `style-src` does not restrict.

## Consequences

- An operator can put shared chrome in Philo with one same-origin file and a
  few environment values, and no edit to an upstream file.
- With the variable unset, nothing changes: no script, no extra CSP sources,
  the same account menu.
- With it set, ADR-0006's bound on the `localStorage` refresh token becomes
  "the operator's trust in their own script": the script can read the token
  and act as the person, and the CSP does not stop it sending data out. That
  is a real widening, chosen by the operator, and `DEPLOYMENT.md` says it in
  those words beside the variable.
- `PhiloHost` is a public contract. A change that breaks it bumps `version`
  and is a breaking change in the release notes; the PWA, the SDK type and
  the documentation change together, as with the API.
- The service worker does not cache a cross-origin host script or its assets,
  and does not cache a same-origin one outside `/assets`. The HTTP cache
  covers repeat loads. Offline, the host fails to load and Philo's own menu
  stays, which is the intended fallback.
- Only the account menu can be replaced. A host that wants to replace the
  wordmark, the tabs or the funnel switcher needs a new value in `replaces`,
  which is an amendment to this ADR.
- Revisit if a browser primitive arrives that can isolate a same-document
  script from storage, or if operators start asking for more than one script.
