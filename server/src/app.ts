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

  // Unknown API paths answer in JSON; they must never fall through to the SPA.
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

  // Built PWA assets, then an index.html fallback so client-side routes work.
  app.use('/*', serveStatic({ root }))
  app.get('/*', serveStatic({ root, path: 'index.html' }))

  return app
}
