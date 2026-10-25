import { serveStatic } from '@hono/node-server/serve-static'
import { MCP_PATH, PROTECTED_RESOURCE_METADATA_PATH } from '@philo/mcp'
import { Hono, type Context } from 'hono'
import { fileURLToPath } from 'node:url'

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
    } else if (PWA_ROOT_FILES.has(c.req.path)) {
      c.res.headers.set('Cache-Control', 'no-cache')
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
