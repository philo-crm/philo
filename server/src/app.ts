import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { fileURLToPath } from 'node:url'
import { createApiKeyRoutes } from './auth/api-key-routes.ts'
import {
  apiKeyMiddleware,
  requireAuth,
  sessionMiddleware,
  type AuthDeps,
  type AuthEnv,
} from './auth/middleware.ts'
import { createAuthRoutes, type AuthTuning } from './auth/routes.ts'
import type { EmailSenderFactory } from './email/transport.ts'
import { createIntakeRoutes, type IntakeTuning } from './intake/routes.ts'
import { createLeadRoutes } from './leads/routes.ts'
import { createMcpRoutes } from './mcp/routes.ts'
import type { LeadCreatedHook } from './notify.ts'
import { createPushRoutes } from './push/routes.ts'
import { createSettingsRoutes } from './settings/routes.ts'
import { createStageRoutes } from './stages/routes.ts'
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

/**
 * PWA files served unhashed from the root and read on every launch, so they
 * must revalidate: a cached service worker is a deploy that never lands.
 */
const PWA_ROOT_FILES: ReadonlySet<string> = new Set(['/sw.js', '/manifest.webmanifest'])

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
  /**
   * Externally reachable origin, from the config of the same name. Builds
   * `{{lead_url}}` when the settings screen previews an email template.
   */
  publicBaseUrl: string
  /**
   * The VAPID public key the settings toggle subscribes with. Auto-generated
   * into the data dir at first boot — ADR-0004, zero operator setup.
   */
  vapidPublicKey: string
  /** Directory holding the built PWA. Overridable for tests. */
  publicDir?: string
  /** Login throttle and hash-concurrency limits. Defaults are the production ones. */
  authTuning?: AuthTuning
  /** Intake rate limit and dedupe window. Defaults are the production ones. */
  intakeTuning?: IntakeTuning | undefined
  /**
   * Notifications for a lead entering the pipeline: accepted and non-spam at
   * intake, or promoted out of quarantine. Email (#11) and push (#13) attach here.
   */
  onLeadCreated?: LeadCreatedHook | undefined
  /**
   * How the settings screen's test-send reaches an SMTP server. Unset means the
   * real one, built from the stored settings; tests substitute their own.
   */
  createEmailSender?: EmailSenderFactory | undefined
}

/**
 * Machine-facing surfaces (DESIGN.md, Architecture). These answer in JSON and
 * must never fall through to the app shell — an HTML 200 would be an
 * unparseable success to a REST or MCP client.
 */
function isMachinePath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/')
}

/**
 * A path ending in a file extension is a request for a file, not a client-side
 * route — no screen in the app routes on one. Missing, it has to 404: a browser
 * that asked for a script, a manifest or an icon and got 200 text/html fails
 * somewhere nothing reports, which is how a half-deployed PWA hides.
 */
function isStaticFilePath(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(path)
}

export function createApp(options: AppOptions): Hono<AuthEnv> {
  const root = options.publicDir ?? PUBLIC_DIR
  const deps: AuthDeps = {
    db: options.db,
    sessionKey: options.sessionKey,
    cookieSecure: options.cookieSecure,
    trustProxy: options.trustProxy,
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
      // Only when the file was actually there. A 404 under /assets is a deploy
      // still in flight, and `immutable` would outlive the deploy that fixes it
      // — `public`, so in shared caches too — with the client never asking again.
      // Anything short of an error is the file: a 200, or a 206 for a ranged read.
      const failed = c.res.status >= 400
      c.res.headers.set(
        'Cache-Control',
        failed ? 'no-store' : 'public, max-age=31536000, immutable',
      )
    } else if (PWA_ROOT_FILES.has(c.req.path)) {
      c.res.headers.set('Cache-Control', 'no-cache')
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

  // Bearer first: an `Authorization` header is a deliberate credential, and a
  // cookie the browser attached on its own must not shadow it. sessionMiddleware
  // stands down when this one resolved a key.
  app.use(`${API_PREFIX}/*`, apiKeyMiddleware(deps))
  app.use(`${API_PREFIX}/*`, sessionMiddleware(deps))
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) return next()
    return requireAuth(c, next)
  })

  app.route(`${API_PREFIX}/auth`, createAuthRoutes(deps, options.authTuning ?? {}))
  app.route(`${API_PREFIX}/api-keys`, createApiKeyRoutes({ db: options.db }))
  app.route(
    `${API_PREFIX}/leads`,
    createLeadRoutes({ db: options.db, onLeadCreated: options.onLeadCreated }),
  )
  app.route(`${API_PREFIX}/stages`, createStageRoutes({ db: options.db }))
  app.route(
    `${API_PREFIX}/push`,
    createPushRoutes({ db: options.db, vapidPublicKey: options.vapidPublicKey }),
  )
  app.route(
    `${API_PREFIX}/settings`,
    createSettingsRoutes({
      db: options.db,
      publicBaseUrl: options.publicBaseUrl,
      createEmailSender: options.createEmailSender,
    }),
  )

  // The agent surface. Outside `API_PREFIX` on purpose: everything mounted there
  // assumes a session cookie and a same-origin caller, and MCP is neither — it
  // authenticates with a bearer key and carries its own body limit and cache
  // headers. See mcp/routes.ts.
  app.route('/mcp', createMcpRoutes({ db: options.db, publicBaseUrl: options.publicBaseUrl }))

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
        trustProxy: options.trustProxy,
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
    if (isStaticFilePath(c.req.path)) return c.text('Not Found', 404)
    // Everything else is a client-side route: hand back the app shell.
    const res = await serveIndexHtml(c, async () => {})
    return res ?? c.text('Not Found', 404)
  })

  return app
}
