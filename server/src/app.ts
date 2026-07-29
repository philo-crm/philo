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

export function createApp(options: AppOptions = {}): Hono {
  const root = options.publicDir ?? PUBLIC_DIR
  const app = new Hono()

  app.get('/version', (c) => c.json({ name: 'philo', version: VERSION }))

  // Built PWA assets. Misses fall through to the not-found handler, so routes
  // registered after this one still match.
  app.use('/*', serveStatic({ root }))

  const serveIndexHtml = serveStatic({ root, path: 'index.html' })

  app.notFound(async (c) => {
    // API surfaces answer in JSON; they must never fall through to the SPA.
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404)
    // Everything else is a client-side route: hand back the app shell.
    const res = await serveIndexHtml(c, async () => {})
    return res ?? c.text('Not Found', 404)
  })

  return app
}
