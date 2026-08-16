import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

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
}

export interface ConsentPage extends ConsentRequest {
  /** What the client called itself at registration. Untrusted display text. */
  clientName: string | null
  /** Shown so the operator can see where approval would send the code. */
  clientUri: string | null
  /** Set after a rejected sign-in, so the page can say what went wrong. */
  error?: string | undefined
  /** Kept across a retry so a mistyped password does not clear the address too. */
  email?: string | undefined
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p { margin: 0 0 1rem; }
  .muted { color: GrayText; font-size: 0.875rem; }
  .grant { border: 1px solid GrayText; border-radius: 0.5rem; padding: 0.75rem 1rem; margin: 0 0 1.25rem; }
  .grant ul { margin: 0.5rem 0 0; padding-left: 1.25rem; }
  label { display: block; font-size: 0.875rem; margin: 0 0 0.25rem; }
  input { width: 100%; padding: 0.5rem; margin: 0 0 1rem; font: inherit;
          border: 1px solid GrayText; border-radius: 0.375rem; background: Field; color: FieldText; }
  .actions { display: flex; gap: 0.75rem; }
  button { flex: 1; padding: 0.625rem; font: inherit; border-radius: 0.375rem; cursor: pointer;
           border: 1px solid GrayText; background: ButtonFace; color: ButtonText; }
  button[name="approve"] { background: Highlight; color: HighlightText; border-color: Highlight; }
  .error { color: #b00020; font-size: 0.875rem; margin: 0 0 1rem; }
  code { overflow-wrap: anywhere; }
`

function hidden(name: string, value: string | undefined): Html | string {
  if (value === undefined) return ''
  return html`<input type="hidden" name="${name}" value="${value}" />`
}

/**
 * The single login-and-consent page — DESIGN.md (Auth and access). One POST
 * both authenticates the operator and records their approval, which is what
 * lets a single-tenant CRM skip a session-backed consent step entirely: the
 * password in the form is the proof, so a cross-site forgery has nothing to
 * ride on.
 */
export function renderConsentPage(page: ConsentPage): Html {
  const name = page.clientName ?? 'An application'
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Connect to Philo</title>
    <style>
      ${raw(STYLES)}
    </style>
  </head>
  <body>
    <main>
      <h1>Connect ${name} to Philo</h1>
      <p class="muted">Sign in to approve this connection.</p>
      <div class="grant">
        <strong>${name}</strong> is asking for access to this Philo instance.
        ${page.clientUri === null ? '' : html`<div class="muted"><code>${page.clientUri}</code></div>`}
        <ul>
          <li>Read and write every lead, note, and stage</li>
          <li>Read and edit the email templates the business sends</li>
        </ul>
        <p class="muted" style="margin: 0.5rem 0 0">
          Approving sends it back to <code>${page.redirectUri}</code>. If you did not start this, close
          this page.
        </p>
      </div>
      ${page.error === undefined ? '' : html`<p class="error">${page.error}</p>`}
      <form method="post" action="/oauth/authorize">
        ${hidden('client_id', page.clientId)} ${hidden('redirect_uri', page.redirectUri)}
        ${hidden('response_type', 'code')} ${hidden('code_challenge', page.codeChallenge)}
        ${hidden('code_challenge_method', 'S256')} ${hidden('state', page.state)}
        ${hidden('resource', page.resource)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${page.email ?? ''}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <div class="actions">
          <button type="submit" name="deny" value="1">Cancel</button>
          <button type="submit" name="approve" value="1">Approve</button>
        </div>
      </form>
    </main>
  </body>
</html>`
}

/**
 * The dead end for an authorization request that cannot be sent back to the
 * client — an unknown `client_id`, or a `redirect_uri` the client never
 * registered. Redirecting either of those would make Philo an open redirector,
 * so the error stops here instead.
 */
export function renderAuthorizeError(message: string): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Connection request refused</title>
    <style>
      ${raw(STYLES)}
    </style>
  </head>
  <body>
    <main>
      <h1>Connection request refused</h1>
      <p>${message}</p>
      <p class="muted">Nothing was approved. You can close this page.</p>
    </main>
  </body>
</html>`
}
