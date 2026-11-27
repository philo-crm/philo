import { serveStatic } from '@hono/node-server/serve-static'
import { MCP_PATH, PROTECTED_RESOURCE_METADATA_PATH } from '@philo/mcp'
import { Hono, type Context } from 'hono'
import { fileURLToPath } from 'node:url'
import { CALLBACK_PATH, pwaContentSecurityPolicies, type PwaContentSecurityPolicies } from './csp.ts'

/** Where `npm run build --workspace apps/web` puts the PWA. */
export const WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url))

/**
 * PWA files served unhashed from the root and read on every launch, so they
 * must revalidate: a cached service worker is a deploy that never lands.
 */
const PWA_ROOT_FILES: ReadonlySet<string> = new Set(['/sw.js', '/manifest.webmanifest'])

interface Handler {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>
}

export interface StandaloneOptions {
  /** The headless server — packages/server. */
  server: Handler
  /** The MCP app — apps/mcp. */
  mcp: Handler
  /** The built PWA. Overridable for tests. */
  webDir?: string | undefined
  /**
   * The policies PWA responses carry — csp.ts: the callback's on
   * `CALLBACK_PATH`, the shell's on everything else. Built once at startup
   * from config; the built-in IdP's defaults when omitted.
   */
  contentSecurityPolicy?: PwaContentSecurityPolicies | undefined
}

/** Everything the server answers. Never the app shell: HTML here is an unparseable 200. */
function isServerPath(path: string): boolean {
  return (
    path.startsWith('/api/') ||
    path.startsWith('/oauth/') ||
    path.startsWith('/.well-known/') ||
    path === '/version' ||
    path === '/llms.txt'
  )
}

function isMcpPath(path: string): boolean {
  return path === MCP_PATH || path.startsWith(`${MCP_PATH}/`) || path === PROTECTED_RESOURCE_METADATA_PATH
}

/**
 * A path ending in a file extension is a request for a file, not a client-side
 * route — no screen in the app routes on one. Missing, it has to 404: a browser
 * that asked for a script, a manifest or an icon and got 200 text/html fails
 * somewhere nothing reports it, which is how a half-deployed PWA hides.
 */
function isStaticFilePath(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(path)
}

/** The PWA's security headers, around one of the two policies csp.ts builds. */
function pwaHeadersWith(policy: string): ReadonlyArray<readonly [string, string]> {
  return [
    ['Content-Security-Policy', policy],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ]
}

function forward(target: Handler, c: Context): Response | Promise<Response> {
  return target.fetch(c.req.raw, c.env)
}

/**
 * The single-container deployment — ADR-0006. One origin, three apps: the
 * headless server, the MCP app, and the PWA's static files. Composition only;
 * nothing here decides anything a request means.
 *
 * `c.env` is passed through to the server so it still sees the socket, which
 * is where its rate limits learn who the caller is.
 */
export function createStandaloneApp(options: StandaloneOptions): Hono {
  const root = options.webDir ?? WEB_DIST_DIR
  const app = new Hono()

  // Vite emits content-hashed files under /assets, so they can be cached
  // forever; the shell that references them must never be, or an upgrade
  // serves an old index.html pointing at assets the new build deleted.
  app.use('/*', async (c, next) => {
    await next()
    // Never over a header a handler already set: the IdP's dialog is text/html
    // and says `no-store`, and downgrading that would let a shared cache hold
    // a page built around one client's request.
    if (c.res.headers.has('Cache-Control')) return
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
      c.res.headers.set('Cache-Control', 'no-cache')
    } else if (c.req.path.startsWith('/assets/')) {
      // Only when the file was actually there. A 404 under /assets is a deploy
      // still in flight, and `immutable` would outlive the deploy that fixes it.
      const failed = c.res.status >= 400
      c.res.headers.set('Cache-Control', failed ? 'no-store' : 'public, max-age=31536000, immutable')
    } else if (PWA_ROOT_FILES.has(c.req.path) || c.req.path.startsWith('/host/')) {
      // `/host/` is ADR-0013's mounted host-script directory: unhashed, and an
      // operator's fix to it must land on the next load.
      c.res.headers.set('Cache-Control', 'no-cache')
    }
  })

  // The PWA's own security headers, on every response that is the PWA: the
  // shell, client routes, the service worker, the manifest and the assets.
  // Never on the server or MCP: intake is posted to cross-origin from public
  // sites and answers exactly as the server does, and the server's own pages
  // (the IdP dialog, attachment downloads) carry policies of their own.
  //
  // The callback alone may be framed, and only by the PWA: the extra-token
  // helper's hidden frame lands there (csp.ts).
  const policies = options.contentSecurityPolicy ?? pwaContentSecurityPolicies()
  const shellHeaders = pwaHeadersWith(policies.shell)
  const callbackHeaders = pwaHeadersWith(policies.callback)
  app.use('/*', async (c, next) => {
    await next()
    if (isMcpPath(c.req.path) || isServerPath(c.req.path)) return
    const pwaHeaders = c.req.path === CALLBACK_PATH ? callbackHeaders : shellHeaders
    // Never over a header a handler already set, as with Cache-Control.
    for (const [name, value] of pwaHeaders) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value)
    }
  })

  app.all('*', async (c, next) => {
    if (isMcpPath(c.req.path)) return forward(options.mcp, c)
    if (isServerPath(c.req.path)) return forward(options.server, c)
    return next()
  })

  app.use('/*', serveStatic({ root }))

  const serveIndexHtml = serveStatic({ root, path: 'index.html' })
  app.notFound(async (c) => {
    if (isStaticFilePath(c.req.path)) return c.text('Not Found', 404)
    // Everything else is a client-side route: hand back the app shell.
    const res = await serveIndexHtml(c, async () => {})
    return res ?? c.text('Not Found', 404)
  })

  return app
}
