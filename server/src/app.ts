import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { fileURLToPath } from 'node:url'
import { requireAuth, sessionMiddleware, type AuthDeps, type AuthEnv } from './auth/middleware.ts'
import { createAuthRoutes, type AuthTuning } from './auth/routes.ts'
import { createIntakeRoutes, type CreatedLead, type IntakeTuning } from './intake/routes.ts'
import { VERSION } from './version.ts'

/** Where the Vite build lands — see web/vite.config.ts `build.outDir`. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

/** Mount point for the cookie-authenticated REST surface. */
const API_PREFIX = '/api/v1'

/**
 * Public form intake. Outside `API_PREFIX` on purpose: everything mounted there
 * assumes a session cookie, JSON, and a same-origin caller, and intake is none
 * of those — see the CSRF note below.
 */
const INTAKE_PREFIX = '/api/intake'

/**
 * Ceiling on a request body. Setup and login are reachable without credentials,
 * so something has to bound what an anonymous caller can make the server buffer;
 * every JSON payload this API takes is orders of magnitude smaller.
 */
const MAX_BODY_BYTES = 64 * 1024

/** Methods that change nothing, and so need neither an origin nor a JSON body. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Reachable without a session. Everything else under `API_PREFIX` is guarded, so
 * a route added later is private until it is listed here on purpose — the
 * alternative, relying on registration order, hides the decision.
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  `${API_PREFIX}/auth/status`,
  `${API_PREFIX}/auth/setup`,
  `${API_PREFIX}/auth/login`,
  `${API_PREFIX}/auth/logout`,
])

export interface AppOptions extends AuthDeps {
  /** Directory holding the built PWA. Overridable for tests. */
  publicDir?: string
  /** Login throttle and hash-concurrency limits. Defaults are the production ones. */
  authTuning?: AuthTuning
  /** Intake rate limit and dedupe window. Defaults are the production ones. */
  intakeTuning?: IntakeTuning | undefined
  /** Notifications for an accepted, non-spam lead. Email (#11) and push (#13) attach here. */
  onLeadCreated?: ((lead: CreatedLead) => void) | undefined
}

/**
 * Machine-facing surfaces (DESIGN.md, Architecture). These answer in JSON and
 * must never fall through to the app shell — an HTML 200 would be an
 * unparseable success to a REST or MCP client.
 */
function isMachinePath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/')
}

export function createApp(options: AppOptions): Hono<AuthEnv> {
  const root = options.publicDir ?? PUBLIC_DIR
  const deps: AuthDeps = {
    db: options.db,
    sessionKey: options.sessionKey,
    cookieSecure: options.cookieSecure,
    trustedProxyHops: options.trustedProxyHops,
  }
  const app = new Hono<AuthEnv>()

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

  app.use(
    `${API_PREFIX}/*`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  )

  // CSRF, in two parts. Neither is a token: the pair below is what makes one
  // unnecessary, and removing either brings the need back.
  //
  // First, hono's csrf(). Note what it actually covers — it inspects only the
  // content types a form element can produce (urlencoded, multipart, text/plain,
  // and a missing header), and is a deliberate no-op for application/json. So it
  // is the guard against the one request a cross-origin page can send without
  // JavaScript and without a preflight.
  //
  // Scoped to the cookie-authenticated surface: /mcp authenticates with a bearer
  // token, where CSRF does not apply, and public form intake is deliberately
  // cross-origin.
  app.use(`${API_PREFIX}/*`, csrf())

  // Second, require JSON on anything state-changing. This is what covers the
  // content type csrf() ignores: a cross-origin fetch can set application/json,
  // but only after a preflight this server answers for no origin, and SameSite=Lax
  // withholds the session cookie from a cross-site POST regardless. Together those
  // two make a forged state change unable to arrive authenticated.
  //
  // Middleware rather than a check inside each handler, so a route added later
  // cannot quietly opt out of the layer.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
    if (contentType.startsWith('application/json')) return next()
    return c.json({ error: 'expected_json' }, 415)
  })

  // Responses here carry account data, so they must not sit in a shared cache.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  app.use(`${API_PREFIX}/*`, sessionMiddleware(deps))
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) return next()
    return requireAuth(c, next)
  })

  app.route(`${API_PREFIX}/auth`, createAuthRoutes(deps, options.authTuning ?? {}))

  // Deliberately unauthenticated, cross-origin, and form-encoding-friendly: the
  // caller is a visitor's browser on the business's own website. It carries its
  // own body limit, rate limit, and per-form CORS instead of the ones above —
  // see intake/routes.ts.
  app.route(
    INTAKE_PREFIX,
    createIntakeRoutes(
      {
        db: options.db,
        onLeadCreated: options.onLeadCreated,
        trustedProxyHops: options.trustedProxyHops,
      },
      options.intakeTuning ?? {},
    ),
  )

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
