import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.ts'

/** Where the Vite build lands — see web/vite.config.ts `build.outDir`. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

export interface AppOptions {
  /** Directory holding the built PWA. Overridable for tests. */
  publicDir?: string
}

/**
 * Machine-facing surfaces (DESIGN.md, Architecture). These answer in JSON and
 * must never fall through to the app shell — an HTML 200 would be an
 * unparseable success to a REST or MCP client.
 */
function isMachinePath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/')
}

export function createApp(options: AppOptions = {}): Hono {
  const root = options.publicDir ?? PUBLIC_DIR
  const app = new Hono()

  // Vite emits content-hashed files under /assets, so they can be cached
  // forever; the shell that references them must never be, or an upgrade
  // serves an old index.html pointing at assets the new build deleted.
  app.use('/*', async (c, next) => {
    await next()
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
      c.res.headers.set('Cache-Control', 'no-cache')
    } else if (c.req.path.startsWith('/assets/')) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    }
  })

  app.get('/version', (c) => c.json({ name: 'philo', version: VERSION }))

  // Built PWA assets. Misses fall through to the not-found handler, so routes
  // registered after this one still match.
  app.use('/*', serveStatic({ root }))

  const serveIndexHtml = serveStatic({ root, path: 'index.html' })

  app.notFound(async (c) => {
    if (isMachinePath(c.req.path)) return c.json({ error: 'not_found' }, 404)
    // Everything else is a client-side route: hand back the app shell.
    const res = await serveIndexHtml(c, async () => {})
    return res ?? c.text('Not Found', 404)
  })

  return app
}
