import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { MIN_PASSWORD_LENGTH } from '../auth/password.ts'

/** What `html` yields — synchronous unless an interpolated value is a promise. */
type Html = HtmlEscapedString | Promise<HtmlEscapedString>

/**
 * The authorization request, as it will be re-submitted by the form. Every value
 * has already been validated against the registered client by the time it is
 * rendered; the POST validates them again from scratch, so nothing here is
 * trusted on the way back in.
 */
export interface ConsentRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string | undefined
  resource: string | undefined
  /** As requested; what is granted is decided on the POST, from the client. */
  scope: string | undefined
  nonce: string | undefined
}

export interface ConsentPage extends ConsentRequest {
  /**
   * `consent` asks the operator to let a third-party client in; `signin` is the
   * PWA's own sign-in, where there is nobody else to approve; `setup` is
   * first-boot, creating the account the other two sign in to.
   */
  mode: 'consent' | 'signin' | 'setup'
  /** What the client called itself at registration. Untrusted display text. */
  clientName: string | null
  /** Shown so the operator can see where approval would send the code. */
  clientUri: string | null
  /** Set after a rejected sign-in, so the page can say what went wrong. */
  error?: string | undefined
  /** Kept across a retry so a mistyped password does not clear the address too. */
  email?: string | undefined
}

/**
 * The PWA's palette (apps/web/src/index.css), copied rather than linked: this
 * page is served apart from the PWA's hashed bundle, and must look like the
 * same app the operator just left.
 */
const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #14181c; --surface: #1b2126; --surface-sunken: #171c21; --surface-hover: #262e35;
    --border: #2d363e; --border-strong: #46525d; --text: #e6ebef; --muted: #98a4b0;
    --accent: #7db4ec; --accent-contrast: #0d1216; --error: #f2b8b5; --error-bg: #3a1e1c;
    --shadow-card: 0 1px 2px rgb(0 0 0 / 0.3);`

const STYLES = `
  :root {
    color-scheme: light;
    --bg: #f4f6f8; --surface: #ffffff; --surface-sunken: #eef1f4; --surface-hover: #e6eaee;
    --border: #d9dee3; --border-strong: #b3bdc7; --text: #14191e; --muted: #5b6672;
    --accent: #1a5fa8; --accent-contrast: #ffffff; --error: #a4231c; --error-bg: #fdecea;
    --shadow-card: 0 1px 2px rgb(20 25 30 / 0.06);
    --brand: #1a5fa8; --brand-contrast: #ffffff;
    --radius: 6px; --radius-lg: 8px;
  }
  :root[data-theme='dark'] {${DARK_TOKENS}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {${DARK_TOKENS}
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; justify-items: center; align-content: start;
    gap: 1.25rem; padding: max(3rem, 12vh) 1rem 3rem;
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text);
  }
  .brand { display: flex; align-items: center; gap: 0.5rem; margin: 0;
           font-weight: 700; font-size: 1.05rem; letter-spacing: 0.01em; }
  .brand rect { fill: var(--brand); }
  .brand path { fill: var(--brand-contrast); }
  main { width: 100%; max-width: 24rem; display: grid; gap: 1rem; padding: 1.5rem;
         background: var(--surface); border: 1px solid var(--border);
         border-radius: var(--radius-lg); box-shadow: var(--shadow-card); }
  main > *, .head > *, form > * { margin: 0; }
  .head { display: grid; gap: 0.3rem; }
  h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.01em; }
  .muted { color: var(--muted); }
  .hint { font-size: 0.8rem; color: var(--muted); margin: 0; }
  .grant { padding: 0.75rem; background: var(--surface-sunken); border: 1px solid var(--border);
           border-radius: var(--radius); display: grid; gap: 0.5rem; }
  .grant > * { margin: 0; }
  .grant ul { padding-left: 1.25rem; }
  .notice { padding: 0.625rem 0.75rem; border-radius: var(--radius); border: 1px solid currentcolor;
            color: var(--error); background: var(--error-bg); }
  form { display: grid; gap: 0.875rem; }
  .field { display: grid; gap: 0.3rem; }
  label { font-size: 0.8rem; font-weight: 550; color: var(--muted); }
  input { width: 100%; padding: 0.5rem 0.6rem; font: inherit; color: inherit;
          background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius); }
  input:focus { border-color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .actions { display: flex; flex-direction: row-reverse; gap: 0.5rem; margin-top: 0.25rem; }
  button { flex: 1; padding: 0.55rem 0.8rem; font: inherit; border-radius: var(--radius); cursor: pointer;
           border: 1px solid var(--border-strong); background: var(--surface); color: inherit; }
  button:hover { background: var(--surface-hover); }
  button[name="approve"] { background: var(--accent); border-color: var(--accent);
                           color: var(--accent-contrast); font-weight: 550; }
  button[name="approve"]:hover { background: var(--accent); filter: brightness(1.08); }
  code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  @media (max-width: 30rem) { main { padding: 1.25rem; } }
  /* iOS zooms the page in on any field set smaller than 16px, and leaves it zoomed. */
  @media (pointer: coarse) { input { font-size: 16px; } }
`

/**
 * The theme the operator picked in the PWA's account menu (apps/web/src/theme.ts),
 * which shares this page's origin unless the PWA is hosted apart. Run before
 * the body paints, so a light choice on a dark system never flashes dark first.
 */
const THEME_SCRIPT = `try {
  var theme = localStorage.getItem('philo.theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch (e) {}`

/** The app icon (apps/web/public/favicon.svg), coloured by the stylesheet. */
const MARK = `<svg viewBox="0 0 100 100" width="28" height="28" aria-hidden="true" focusable="false">
  <rect width="100" height="100" rx="22" />
  <path d="M4 10 H96 L58 54 V92 L42 84 V54 Z" transform="translate(22 21.44) scale(0.56)" />
</svg>`

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#1a5fa8"/>' +
    '<path d="M4 10 H96 L58 54 V92 L42 84 V54 Z" transform="translate(22 21.44) scale(0.56)" fill="#fff"/></svg>',
)}`

function layout(title: Html | string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <link rel="icon" href="${FAVICON}" type="image/svg+xml" />
    <script>
      ${raw(THEME_SCRIPT)}
    </script>
    <style>
      ${raw(STYLES)}
    </style>
  </head>
  <body>
    <p class="brand">${raw(MARK)} Philo</p>
    <main>${body}</main>
  </body>
</html>`
}

function hidden(name: string, value: string | undefined): Html | string {
  if (value === undefined) return ''
  return html`<input type="hidden" name="${name}" value="${value}" />`
}

/**
 * Where the cursor starts: back in the password after a rejected one, since
 * the address is kept; nowhere on a fresh connection request, which should be
 * read before anything is typed; otherwise the first field.
 */
function focusField(page: ConsentPage): 'name' | 'email' | 'password' | undefined {
  if (page.email !== undefined && page.email !== '') return 'password'
  if (page.mode === 'consent') return undefined
  return page.mode === 'setup' ? 'name' : 'email'
}

function autofocus(page: ConsentPage, field: 'name' | 'email' | 'password'): Html | string {
  return focusField(page) === field ? raw('autofocus') : ''
}

/**
 * The IdP's one dialog — DESIGN.md (Auth and access), ADR-0006. One POST
 * both authenticates the operator and records their approval, which is what
 * lets a single-tenant CRM skip a session-backed consent step entirely: the
 * password in the form is the proof, so a cross-site forgery has nothing to
 * ride on.
 *
 * Two details in the button markup are load-bearing rather than cosmetic:
 *
 * - **Approve comes first in the DOM**, with `row-reverse` putting it on the
 *   right. Implicit submission picks the first submit button, so with Cancel
 *   first, pressing Enter after typing the password would deny the request.
 * - **Cancel carries `formnovalidate`**, because the fields above it are
 *   `required`. Without it, declining a request you did not start means
 *   filling in a password first — which is exactly what someone declining an
 *   unexpected request will not do.
 */
export function renderConsentPage(page: ConsentPage): Html {
  const name = page.clientName ?? 'An application'
  const heading =
    page.mode === 'setup'
      ? 'Set up Philo'
      : page.mode === 'signin'
        ? 'Sign in to Philo'
        : html`Connect ${name} to Philo`
  const lede =
    page.mode === 'setup'
      ? 'Create the account that runs this instance. You will use it to sign in from now on.'
      : page.mode === 'signin'
        ? ''
        : 'Sign in to approve this connection.'
  const setup = page.mode === 'setup'
  return layout(
    page.mode === 'consent' ? 'Connect to Philo' : heading,
    html`<div class="head">
        <h1>${heading}</h1>
        ${lede === '' ? '' : html`<p class="muted">${lede}</p>`}
      </div>
      ${page.mode === 'consent'
        ? html`<div class="grant">
            <p><strong>${name}</strong> is asking for access to this Philo instance.</p>
            ${page.clientUri === null ? '' : html`<p class="muted"><code>${page.clientUri}</code></p>`}
            <ul>
              <li>Read and write every lead, note, and stage</li>
              <li>Read and edit the email templates the business sends</li>
            </ul>
            <p class="hint">
              Approving sends it back to <code>${page.redirectUri}</code>. If you did not start this, close
              this page.
            </p>
          </div>`
        : ''}
      ${page.error === undefined ? '' : html`<p class="notice" role="alert">${page.error}</p>`}
      <form method="post" action="/oauth/authorize">
        ${hidden('client_id', page.clientId)} ${hidden('redirect_uri', page.redirectUri)}
        ${hidden('response_type', 'code')} ${hidden('code_challenge', page.codeChallenge)}
        ${hidden('code_challenge_method', 'S256')} ${hidden('state', page.state)}
        ${hidden('resource', page.resource)} ${hidden('scope', page.scope)} ${hidden('nonce', page.nonce)}
        ${setup
          ? html`${hidden('setup', '1')}
              <div class="field">
                <label for="name">Your name (optional)</label>
                <input id="name" name="name" type="text" autocomplete="name" ${autofocus(page, 'name')} />
              </div>`
          : ''}
        <div class="field">
          <label for="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="username"
            required
            value="${page.email ?? ''}"
            ${autofocus(page, 'email')}
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="${setup ? 'new-password' : 'current-password'}"
            ${raw(setup ? `minlength="${MIN_PASSWORD_LENGTH}" aria-describedby="password-hint"` : '')}
            required
            ${autofocus(page, 'password')}
          />
          ${setup ? html`<p class="hint" id="password-hint">At least ${MIN_PASSWORD_LENGTH} characters.</p>` : ''}
        </div>
        <div class="actions">
          <button type="submit" name="approve" value="1">
            ${setup ? 'Create account' : page.mode === 'signin' ? 'Sign in' : 'Approve'}
          </button>
          ${page.mode === 'consent'
            ? html`<button type="submit" name="deny" value="1" formnovalidate>Cancel</button>`
            : ''}
        </div>
      </form>`,
  )
}

/**
 * The dead end for an authorization request that cannot be sent back to the
 * client — an unknown `client_id`, or a `redirect_uri` the client never
 * registered. Redirecting either of those would make Philo an open redirector,
 * so the error stops here instead.
 */
export function renderAuthorizeError(message: string): Html {
  return layout(
    'Connection request refused',
    html`<h1>Connection request refused</h1>
      <p class="notice">${message}</p>
      <p class="muted">Nothing was approved. You can close this page.</p>`,
  )
}
