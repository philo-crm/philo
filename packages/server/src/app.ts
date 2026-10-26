import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createApiKeyRoutes } from './auth/api-key-routes.ts'
import type { ExternalIdp } from './auth/external-idp.ts'
import { bearerMiddleware, requireAuth, type AuthDeps, type AuthEnv } from './auth/middleware.ts'
import { createAuthGuards, createAuthRoutes, type AuthTuning } from './auth/routes.ts'
import type { Db } from './db/index.ts'
import type { EmailSenderFactory } from './email/transport.ts'
import { createFunnelRoutes } from './funnels/routes.ts'
import { createIntakeRoutes, type IntakeTuning } from './intake/routes.ts'
import { createLeadRoutes } from './leads/routes.ts'
import { llmsTxt } from './llms-txt.ts'
import type { LeadCreatedHook } from './notify.ts'
import { ensureFirstPartyClient, FIRST_PARTY_CLIENT_ID } from './oauth/first-party.ts'
import { createOAuthRoutes, createWellKnownRoutes } from './oauth/routes.ts'
import type { SigningKey } from './oauth/signing-key.ts'
import { OPENID_SCOPE, OPERATOR_SCOPE } from './oauth/tokens.ts'
import { LiveFeed, type LiveTuning } from './push/live.ts'
import { createPushRoutes } from './push/routes.ts'
import { createSettingsRoutes } from './settings/routes.ts'
import { createStageRoutes } from './stages/routes.ts'
import { VERSION } from './version.ts'

/** Mount point for the REST surface. */
export const API_PREFIX = '/api/v1'

/**
 * Public form intake. Outside `API_PREFIX` on purpose: it is unauthenticated,
 * cross-origin by design, and form-encoding-friendly, with its own limits.
 */
const INTAKE_PREFIX = '/api/intake'

/**
 * Ceiling on a request body. Every JSON payload this API takes is orders of
 * magnitude smaller, and something has to bound what an anonymous caller can
 * make the server buffer.
 */
const MAX_BODY_BYTES = 64 * 1024

const ATTACHMENT_UPLOAD_PATH = new RegExp(`^${API_PREFIX}/leads/\\d+/attachments$`)

/**
 * Reachable without a token. Everything else under `API_PREFIX` is guarded, so
 * a route added later is private until it is listed here on purpose.
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([`${API_PREFIX}/auth/config`])

export interface AppOptions {
  db: Db
  trustProxy: boolean
  /** Externally reachable origin of this server. The built-in IdP's issuer. */
  publicBaseUrl: string
  /** Where the PWA is served: the first-party redirect URI, and links in emails. */
  appUrl: string
  /** Where the MCP app is served — a resource a token may be issued for. */
  mcpUrl: string
  /** Signs the built-in IdP's id_tokens. */
  signingKey: SigningKey
  /** Replaces the built-in IdP when set — ADR-0006. */
  externalIdp?: ExternalIdp | undefined
  /**
   * The VAPID public key the settings toggle subscribes with. Auto-generated
   * into the data dir at first boot — ADR-0004, zero operator setup.
   */
  vapidPublicKey: string
  /**
   * Where the in-app notification stream hears about new leads. Must be the
   * feed `onLeadCreated` publishes to; unset, the stream never says anything.
   */
  liveFeed?: LiveFeed | undefined
  liveTuning?: LiveTuning | undefined
  /** Login throttle and hash-concurrency limits. Defaults are the production ones. */
  authTuning?: AuthTuning
  /** Intake rate limit and dedupe window. Defaults are the production ones. */
  intakeTuning?: IntakeTuning | undefined
  /**
   * Notifications for a lead entering the pipeline: accepted and non-spam at
   * intake, or promoted out of quarantine.
   */
  onLeadCreated?: LeadCreatedHook | undefined
  /**
   * How the settings screen's test-send reaches an SMTP server. Unset means the
   * real one, built from the stored settings; tests substitute their own.
   */
  createEmailSender?: EmailSenderFactory | undefined
}

/** What the PWA is told to sign in against — `GET /api/v1/auth/config`. */
function signInConfig(options: AppOptions) {
  if (options.externalIdp !== undefined) {
    return { issuer: options.externalIdp.issuer, clientId: options.externalIdp.clientId, scope: 'openid email profile' }
  }
  return { issuer: options.publicBaseUrl, clientId: FIRST_PARTY_CLIENT_ID, scope: `${OPENID_SCOPE} ${OPERATOR_SCOPE}` }
}

/**
 * The headless server — ADR-0006. It serves the API, form intake, and the
 * built-in IdP with its dialogs; the PWA and the MCP endpoint are clients,
 * hosted elsewhere or beside it by apps/standalone.
 */
export function createApp(options: AppOptions): Hono<AuthEnv> {
  const deps: AuthDeps = { db: options.db, trustProxy: options.trustProxy, externalIdp: options.externalIdp }
  const app = new Hono<AuthEnv>()

  app.get('/version', (c) => c.json({ name: 'philo', version: VERSION }))

  // The agent tour — DESIGN.md (MCP surface). Public, because an agent reads it
  // before it has a credential. Unhashed and rewritten by an upgrade, so it
  // must revalidate.
  app.get('/llms.txt', (c) =>
    c.text(llmsTxt(options.publicBaseUrl, options.mcpUrl), 200, { 'Cache-Control': 'no-cache' }),
  )

  // Any origin: the API authenticates with a bearer token only, so there is no
  // ambient credential a cross-origin page could ride on, and the PWA may be
  // served from somewhere else entirely.
  app.use(`${API_PREFIX}/*`, cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

  const apiBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  })
  // An attachment upload carries its own, larger limit on its route.
  app.use(`${API_PREFIX}/*`, (c, next) =>
    c.req.method === 'POST' && ATTACHMENT_UPLOAD_PATH.test(c.req.path) ? next() : apiBodyLimit(c, next),
  )

  // Responses here carry account data, so they must not sit in a shared cache.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  app.use(`${API_PREFIX}/*`, bearerMiddleware(deps))
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (c.req.method === 'OPTIONS' || PUBLIC_API_PATHS.has(c.req.path)) return next()
    return requireAuth(c, next)
  })

  app.route(`${API_PREFIX}/auth`, createAuthRoutes({ signIn: signInConfig(options) }))
  app.route(`${API_PREFIX}/api-keys`, createApiKeyRoutes({ db: options.db }))
  app.route(
    `${API_PREFIX}/leads`,
    createLeadRoutes({ db: options.db, onLeadCreated: options.onLeadCreated }),
  )
  app.route(`${API_PREFIX}/stages`, createStageRoutes({ db: options.db }))
  app.route(
    `${API_PREFIX}/funnels`,
    createFunnelRoutes({ db: options.db, publicBaseUrl: options.publicBaseUrl }),
  )
  app.route(
    `${API_PREFIX}/push`,
    createPushRoutes({
      db: options.db,
      vapidPublicKey: options.vapidPublicKey,
      liveFeed: options.liveFeed ?? new LiveFeed(),
      liveTuning: options.liveTuning,
    }),
  )
  app.route(
    `${API_PREFIX}/settings`,
    createSettingsRoutes({
      db: options.db,
      appUrl: options.appUrl,
      createEmailSender: options.createEmailSender,
    }),
  )

  // The built-in IdP, switched off entirely when an external one issues the
  // tokens: two sources of identity would be one too many.
  if (options.externalIdp === undefined) {
    ensureFirstPartyClient(options.db, options.appUrl)
    const authGuards = createAuthGuards(options.authTuning ?? {})
    app.route(
      '/oauth',
      createOAuthRoutes({
        db: options.db,
        publicBaseUrl: options.publicBaseUrl,
        mcpUrl: options.mcpUrl,
        trustProxy: options.trustProxy,
        guards: authGuards,
        signingKey: options.signingKey,
      }),
    )
    app.route('/.well-known', createWellKnownRoutes({ publicBaseUrl: options.publicBaseUrl }))
  }

  // Deliberately unauthenticated, cross-origin, and form-encoding-friendly: the
  // caller is a visitor's browser on the business's own website.
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

  // Headless: nothing here is a page, so a miss is JSON for any client.
  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  return app
}
