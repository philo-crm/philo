import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createApiKeyRoutes } from './auth/api-key-routes.ts'
import type { AccessPolicy } from './auth/access.ts'
import type { ExternalIdp } from './auth/external-idp.ts'
import { bearerMiddleware, requireAdmin, requireAuth, type AuthDeps, type AuthEnv } from './auth/middleware.ts'
import { createAuthGuards, createAuthRoutes, type AuthTuning } from './auth/routes.ts'
import type { WebHostConfig } from './config.ts'
import type { Db } from './db/index.ts'
import type { EmailSenderFactory } from './email/transport.ts'
import { ChangeFeed } from './events/feed.ts'
import { createEventRoutes } from './events/routes.ts'
import { createFunnelRoutes } from './funnels/routes.ts'
import { createEmailPreviewFrameRoutes, EMAIL_PREVIEW_FRAME_PATH } from './email/preview-frame.ts'
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
import type { DeliveryTuning } from './webhooks/deliver.ts'
import { createWebhookRoutes } from './webhooks/routes.ts'

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
 * What the PWA loads besides sign-in — ADR-0013. Public: it is read before
 * there is a token, and says nothing the page would not load anyway.
 */
const WEB_CONFIG_PATH = `${API_PREFIX}/web/config`

/**
 * Reachable without a token. Everything else under `API_PREFIX` is guarded, so
 * a route added later is private until it is listed here on purpose.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([`${API_PREFIX}/auth/config`, WEB_CONFIG_PATH])

/** A route as Hono registers it: a method and a path with `:param` segments. */
export type RouteKey = readonly [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string]

/**
 * What a `user` may call — ADR-0012. Everything else under `API_PREFIX` needs
 * an `admin`, so a route added later is admin-only until it is listed here on
 * purpose, as a route is private until it is listed public. Working leads, the
 * funnels and stages the board reads, and a person's own keys and devices;
 * not configuration (funnel and stage writes, `/settings`, `/webhooks`).
 * `test/authz.test.ts` walks every registered route against this list.
 */
export const USER_API_ROUTES: readonly RouteKey[] = [
  ['GET', `${API_PREFIX}/auth/session`],
  ['GET', `${API_PREFIX}/auth/principal`],
  ['GET', `${API_PREFIX}/api-keys`],
  ['POST', `${API_PREFIX}/api-keys`],
  ['DELETE', `${API_PREFIX}/api-keys/:id`],
  ['GET', `${API_PREFIX}/leads`],
  ['POST', `${API_PREFIX}/leads`],
  ['GET', `${API_PREFIX}/leads/:id`],
  ['PATCH', `${API_PREFIX}/leads/:id`],
  ['DELETE', `${API_PREFIX}/leads/:id`],
  ['POST', `${API_PREFIX}/leads/:id/stage`],
  ['POST', `${API_PREFIX}/leads/:id/notes`],
  ['POST', `${API_PREFIX}/leads/:id/not-spam`],
  ['POST', `${API_PREFIX}/leads/:id/attachments`],
  ['GET', `${API_PREFIX}/leads/:id/attachments/:attachmentId`],
  ['DELETE', `${API_PREFIX}/leads/:id/attachments/:attachmentId`],
  ['GET', `${API_PREFIX}/funnels`],
  ['GET', `${API_PREFIX}/funnels/:id`],
  ['GET', `${API_PREFIX}/stages`],
  ['GET', `${API_PREFIX}/events`],
  ['GET', `${API_PREFIX}/push/key`],
  ['GET', `${API_PREFIX}/push/live`],
  ['POST', `${API_PREFIX}/push/subscriptions`],
  ['DELETE', `${API_PREFIX}/push/subscriptions`],
]

/**
 * `:param` matches one path segment, as it does in Hono's router. The listed
 * paths are letters, digits, `-` and `/`, none of which a regex reads specially.
 */
function routeMatcher(routes: readonly RouteKey[]): (method: string, path: string) => boolean {
  const compiled = routes.map(([method, path]) => ({
    method,
    pattern: new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`),
  }))
  return (method, path) => {
    // Hono answers HEAD with the GET handler, so HEAD is allowed where GET is.
    const effective = method === 'HEAD' ? 'GET' : method
    return compiled.some((route) => route.method === effective && route.pattern.test(path))
  }
}

const isUserRoute = routeMatcher(USER_API_ROUTES)

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
  /** Where roles are decided — ADR-0012. Unset: on the account. */
  access?: AccessPolicy | undefined
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
  /**
   * Where every committed change is published — ADR-0010. The change stream
   * reads it, and boot.ts hangs webhook delivery off it. Unset, a private one.
   */
  changeFeed?: ChangeFeed | undefined
  /** The webhook Test button's timeout. Defaults are the production ones. */
  webhookTuning?: DeliveryTuning | undefined
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
  /** The operator host script — ADR-0013. Unset: none. */
  webHost?: WebHostConfig | undefined
}

/**
 * What the PWA is told to sign in against — `GET /api/v1/auth/config`.
 * `resource` is always present: empty for the built-in IdP, which needs none.
 */
function signInConfig(options: AppOptions) {
  const idp = options.externalIdp
  if (idp !== undefined) {
    return { issuer: idp.issuer, clientId: idp.clientId, scope: idp.scope, resource: idp.resource }
  }
  return {
    issuer: options.publicBaseUrl,
    clientId: FIRST_PARTY_CLIENT_ID,
    scope: `${OPENID_SCOPE} ${OPERATOR_SCOPE}`,
    resource: [],
  }
}

/**
 * The headless server — ADR-0006. It serves the API, form intake, and the
 * built-in IdP with its dialogs; the PWA and the MCP endpoint are clients,
 * hosted elsewhere or beside it by apps/standalone.
 */
export function createApp(options: AppOptions): Hono<AuthEnv> {
  const deps: AuthDeps = {
    db: options.db,
    trustProxy: options.trustProxy,
    externalIdp: options.externalIdp,
    access: options.access,
  }
  const app = new Hono<AuthEnv>()
  const changes = options.changeFeed ?? new ChangeFeed()

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
  // The web config carries none, and a deploy that changes it must land on
  // the next load, so it revalidates instead.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', c.req.path === WEB_CONFIG_PATH ? 'no-cache' : 'no-store')
  })

  app.use(`${API_PREFIX}/*`, bearerMiddleware(deps))
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (c.req.method === 'OPTIONS' || PUBLIC_API_PATHS.has(c.req.path)) return next()
    return requireAuth(c, next)
  })
  // One role guard for the whole surface, deny by default — ADR-0012.
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (c.req.method === 'OPTIONS' || PUBLIC_API_PATHS.has(c.req.path)) return next()
    if (isUserRoute(c.req.method, c.req.path)) return next()
    return requireAdmin(c, next)
  })

  app.route(`${API_PREFIX}/auth`, createAuthRoutes({ signIn: signInConfig(options) }))
  const webConfig = {
    hostScriptUrl: options.webHost?.scriptUrl ?? null,
    hostConfig: options.webHost?.config ?? {},
    hostTokenResources: options.webHost?.tokenResources ?? [],
  }
  app.get(WEB_CONFIG_PATH, (c) => c.json(webConfig))
  app.route(`${API_PREFIX}/api-keys`, createApiKeyRoutes({ db: options.db }))
  app.route(
    `${API_PREFIX}/leads`,
    createLeadRoutes({ db: options.db, onLeadCreated: options.onLeadCreated, changes }),
  )
  app.route(`${API_PREFIX}/stages`, createStageRoutes({ db: options.db, changes }))
  app.route(
    `${API_PREFIX}/funnels`,
    createFunnelRoutes({ db: options.db, publicBaseUrl: options.publicBaseUrl, changes }),
  )
  app.route(`${API_PREFIX}/events`, createEventRoutes({ changes, liveTuning: options.liveTuning }))
  app.route(
    `${API_PREFIX}/webhooks`,
    createWebhookRoutes({ db: options.db, deliveryTuning: options.webhookTuning }),
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
        changes,
        trustProxy: options.trustProxy,
      },
      options.intakeTuning ?? {},
    ),
  )

  // The one page the PWA frames: the email template preview, which needs a
  // policy of its own (email/preview-frame.ts).
  app.route(EMAIL_PREVIEW_FRAME_PATH, createEmailPreviewFrameRoutes({ appUrl: options.appUrl }))

  // Headless: nothing here is a page, so a miss is JSON for any client.
  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  return app
}
