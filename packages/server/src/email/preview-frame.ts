import { createHash } from 'node:crypto'
import { Hono } from 'hono'

/** Outside `/api/v1`: a page, public, holding no data. */
export const EMAIL_PREVIEW_FRAME_PATH = '/api/email-preview'

/** What the PWA posts in, and what this page posts back when it can take it. */
const READY = 'philo:email-preview-ready'
const RENDER = 'philo:email-preview'

/**
 * The frame the PWA previews an email template in.
 *
 * A preview is HTML an operator wrote with a lead's answers rendered into it,
 * so it is shown with scripts off. It used to be a `srcdoc` frame in the PWA,
 * but a `srcdoc` document inherits its parent's Content-Security-Policy, and
 * the PWA's (`style-src 'self'; img-src 'self'`) strips the very inline styles
 * and remote images an email is made of: the preview would no longer show what
 * the lead receives. Nothing a page does can loosen an inherited policy.
 *
 * So the preview renders one frame further in. This page is served with a
 * policy of its own, and the PWA frames it and posts the rendered HTML to it,
 * which it drops into a `sandbox=""` `srcdoc` frame that inherits *this*
 * policy instead: inline styles and any image, and still no script.
 *
 * The page holds no data and needs no credential: the HTML arrives by
 * `postMessage`, never in a URL, and only from the app's origin.
 * `frame-ancestors` keeps any other site from framing it, and the CSP
 * `sandbox` keeps it in an opaque origin even when opened directly, so its one
 * script can reach no origin's storage.
 */
export function createEmailPreviewFrameRoutes(options: { appUrl: string }): Hono {
  const appOrigin = new URL(options.appUrl).origin
  const script = [
    `addEventListener('message', function (event) {`,
    `  if (event.origin !== ${JSON.stringify(appOrigin)} || event.source !== parent) return`,
    `  var data = event.data`,
    `  if (data === null || typeof data !== 'object' || data.type !== ${JSON.stringify(RENDER)}) return`,
    `  if (typeof data.html !== 'string') return`,
    `  document.getElementById('preview').srcdoc = data.html`,
    `})`,
    `parent.postMessage({ type: ${JSON.stringify(READY)} }, ${JSON.stringify(appOrigin)})`,
  ].join('\n')
  const scriptHash = createHash('sha256').update(script).digest('base64')

  const policy = [
    "default-src 'none'",
    // This page's one inline script, pinned by hash. The preview frame is
    // `sandbox=""` as well, so a template's own script never runs either way.
    `script-src 'sha256-${scriptHash}'`,
    // What an email is made of: `<style>` blocks and `style` attributes, and
    // images from anywhere — as the lead's mail client would show them.
    "style-src 'unsafe-inline'",
    'img-src * data:',
    'font-src * data:',
    "base-uri 'none'",
    "form-action 'none'",
    // An opaque origin, even when opened at the top level.
    'sandbox allow-scripts',
    `frame-ancestors ${appOrigin}`,
  ].join('; ')

  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>Email preview</title>
    <style>
      html, body, iframe { margin: 0; border: 0; width: 100%; height: 100%; display: block; background: #fff; }
    </style>
  </head>
  <body>
    <iframe id="preview" title="Email preview" sandbox=""></iframe>
    <script>${script}</script>
  </body>
</html>
`

  const routes = new Hono()
  routes.get('/', (c) =>
    c.html(page, 200, {
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      // Remote images in a template learn nothing about where it was previewed.
      'Referrer-Policy': 'no-referrer',
      // Depends only on config, which changes with a restart.
      'Cache-Control': 'no-cache',
    }),
  )
  return routes
}
