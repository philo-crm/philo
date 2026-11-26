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

Both values are environment variables, read and validated by the server at
startup. Neither goes in the settings database: a script URL is code
execution in every person's browser, and a settings field would let any admin
in the UI inject script into other people's sessions. Only whoever runs the
server can set it.

| Variable | Default | Meaning |
|---|---|---|
| `PHILO_WEB_HOST_SCRIPT_URL` | unset | A script the PWA loads after sign-in. An absolute `https:` URL (or `http://localhost` / `http://127.0.0.1` in development), or a path on the PWA's own origin. |
| `PHILO_WEB_HOST_CONFIG` | `{}` | A JSON object handed to the script verbatim as `ctx.config`. It is public — anyone can read it — so it holds no secrets. |
| `PHILO_WEB_ASSET_ORIGINS` | empty | Extra sources for the script's own assets (see [CSP](#content-security-policy)). |

A malformed URL, a `PHILO_WEB_HOST_CONFIG` that is not a JSON object, or an
asset entry outside the rules below is a startup `ConfigError`, never a silent
default.

### Delivery

A new public endpoint, `GET /api/v1/web/config`, answers
`{ "hostScriptUrl": string | null, "hostConfig": object }` with
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
  /** The extra-token helper. null with the built-in IdP, without an external IdP, or when the IdP refused. */
  getToken(request: { resource: string; scope: string; prompt?: string }): Promise<string | null>
  /** Client-side navigation inside Philo. */
  navigate(path: string): void
  /** Philo's own sign-out, revocation included. */
  signOut(): void
  /** Philo's own theme store: its stored choice, `data-theme` and the `theme-color` meta. */
  setTheme(theme: 'light' | 'dark' | 'system'): void
  /** Philo's own account-menu entries for this person's role (Server settings for an admin only). */
  accountItems: ReadonlyArray<{ label: string; path: string }>
  /** Aborted when the signed-in shell unmounts: sign-out, an expired session. */
  signal: AbortSignal
}
```

The context hands over capabilities, not data: the host never sees the
refresh token or Philo's own access token through it, only tokens for the
audiences it asks the IdP for. That is a contract, not a wall — see
[Trust](#trust).

### Behaviour

- The PWA injects the script (`<script async>`, classic) once per page, when
  the signed-in shell first mounts, and calls `mount` again with a fresh
  context after each later sign-in. **It never loads the script on a
  signed-out screen** — loading, sign-in, sign-in failure, the callback, or
  the hidden extra-token frame.
- **Philo's own controls stay until the host takes over.** The account menu
  renders as it does today and is hidden only once `mount` resolves with
  `replaces: ['account-menu']`. If the script fails to load, sets no
  `PhiloHost`, throws, rejects, or takes longer than 5 s, Philo logs once to
  the console, aborts that mount's `signal`, empties the slot and keeps its own
  menu for the life of the page. A late answer is ignored. A host can never
  leave a person without a way to sign out, and offline — when the script or
  what it loads is unreachable — the shell looks as it does without one.
- When the host replaces the menu, Philo's menu entries reach it as
  `accountItems`, so nothing Philo offers is lost. Philo's theme picker goes
  with its menu: from then on the host owns the theme and reports it through
  `setTheme`, so the first paint on the next visit is already right.
- The slot sits inside the top bar's action group, so it inherits its spacing
  and its narrow-screen layout. Its contents are the host's to fit.
- The contract is documented in `docs/DESIGN.md` under "Host chrome", and
  `docs/DEPLOYMENT.md` gains the three variables and the CSP they produce.

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
  CSP refuses everything else. A compromised or mistaken host script cannot
  pull in code from an origin nobody listed, and cannot send data to one.
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
  given, and its origin alone to `img-src`. A path prefix keeps `script-src`
  off the rest of a shared origin — an IdP that also serves user uploads, say
  — because a script anywhere on an allowed origin could reach the refresh
  token.
- The host's API calls go through `PHILO_WEB_CONNECT_ORIGINS`, which the CSP
  change already defines. The extra-token helper's hidden frame adds the
  issuer to `frame-src` itself.
- The host must work without inline script or inline `<style>`: stylesheets
  come from listed origins, and a component styles itself with constructable
  stylesheets or the CSSOM, which `style-src` does not restrict.

## Consequences

- An operator can put shared chrome in Philo with one same-origin file and a
  few environment values, and no edit to an upstream file.
- With the variable unset, nothing changes: no script, no extra CSP sources,
  the same account menu.
- With it set, ADR-0006's bound on the `localStorage` refresh token becomes
  "the CSP and the operator's own script". That is a real widening, chosen by
  the operator, and stated in `DEPLOYMENT.md` beside the variable.
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
