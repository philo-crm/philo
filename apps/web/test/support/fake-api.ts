import { pkceChallenge } from '@philo/sdk'
import { vi } from 'vitest'
import type {
  ApiKeyRecord,
  EmailSettings,
  EmailTemplate,
  LeadDetail,
  LeadEventRecord,
  LiveNotification,
  StageRecord,
} from '../../src/api.ts'
import { REFRESH_TOKEN_KEY, type User } from '../../src/auth.ts'
import { setAccessTokenSource } from '../../src/client.ts'

/**
 * An in-memory stand-in for the REST surface, close enough that a screen test
 * exercises the real request the browser would send and the real answer it
 * would get back. A mock per assertion would pass while the client sent the
 * wrong query string; this cannot.
 */
export interface FakeApi {
  user: User | undefined
  /** The one access token the API accepts right now; undefined when signed out. */
  accessToken: string | undefined
  /** The refresh token the IdP would honour, rotated on every use as the real one is. */
  refreshToken: string | undefined
  /** Codes the authorize page handed out and not yet spent, with what the exchange must match. */
  authorizations: Map<string, { challenge: string; redirectUri: string; nonce: string }>
  /** Every token sent to the revocation endpoint. */
  revoked: string[]
  stages: StageRecord[]
  leads: LeadDetail[]
  /** Flip to make every authenticated call answer 401, as an expired session does. */
  expired: boolean
  /** Set to a pending promise to hold every answer until it resolves. */
  hold: Promise<unknown> | undefined
  /** Paths matching this answer as if the network dropped, for partial-failure tests. */
  offline: RegExp | undefined
  /**
   * Stored email settings, including the write-only password the server keeps
   * and never hands back — held here so a test can assert on what was actually
   * saved, which is the only place that distinction is visible.
   */
  emailSettings: StoredEmailSettings
  /** Set to make the test-send answer as a refusing SMTP server does. */
  testEmailFailure: string | undefined
  /** Every address a test-send was accepted for, in order. */
  testEmailsSent: string[]
  emailTemplates: EmailTemplate[]
  /** Every template test-send that went out, rendered as the server would have. */
  templateEmailsSent: { trigger: string; subject: string; body: string }[]
  /** Rows in `api_keys`, as the server would hold them — no secret among them. */
  apiKeys: ApiKeyRecord[]
  /**
   * Every secret this fake ever handed out, which the real server keeps of none
   * of — held here only so a test can assert the screen never shows one twice.
   */
  apiKeySecrets: string[]
  /** The VAPID public key this instance generated at its first boot. */
  vapidPublicKey: string
  /** Rows in `push_subscriptions`, as the server would hold them. */
  pushSubscriptions: { endpoint: string; p256dh: string; auth: string }[]
  /**
   * What `GET /api/v1/push/live` sends on connect. The stream then stays open
   * until the request is aborted, as the server's does between leads.
   */
  liveNotifications: LiveNotification[]
  /** Every request the app made, in order. */
  calls: {
    method: string
    path: string
    query: URLSearchParams
    body: unknown
    contentType: string | undefined
    authorization: string | undefined
  }[]
}

export const TEST_USER: User = { id: 7, email: 'owner@example.com', name: 'Owner' }

/** What the server stores. `smtpPasswordSet` is derived on the way out, never held. */
export type StoredEmailSettings = Omit<EmailSettings, 'smtpPasswordSet'> & { smtpPassword: string }

export const TEST_EMAIL_SETTINGS: StoredEmailSettings = {
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUsername: 'apikey',
  smtpPassword: 'stored-secret',
  fromName: 'Example Co',
  fromAddress: 'no-reply@example.com',
  replyTo: 'hello@example.com',
  businessName: 'Example Co',
}

export const TEST_EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    trigger: 'new_lead_notify',
    subject: 'New lead: {{lead.name}}',
    body: '<p>A new lead just came in.</p>\n<p><a href="{{lead_url}}">Open the lead</a></p>',
    enabled: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
  },
  {
    trigger: 'new_lead_ack',
    subject: 'Thanks for getting in touch',
    body: '<p>Hi {{lead.name}},</p>\n<p>&mdash; {{business.name}}</p>',
    enabled: true,
    updatedAt: '2026-07-01T12:00:00.000Z',
  },
]

/** Where the address of whoever is signed in ends up — the server picks it, not the screen. */
const TEMPLATE_TEST_RECIPIENT = TEST_USER.email

/** What the server's sample lead renders to. Matches SAMPLE_LEAD in email/templates.ts. */
const SAMPLE_CONTEXT: Record<string, string> = {
  'lead.name': 'Sample Applicant',
  'lead.email': 'applicant@example.com',
  'lead.phone': '555-0100',
  'lead.source': 'Careers page',
  'business.name': 'Example Co',
  lead_url: 'http://localhost:3000/leads/1',
}

/**
 * Enough of Handlebars to exercise the client contract: variables substitute,
 * and a block left open fails the way the real engine's parse error does.
 * Pulling the engine itself into the web bundle's tests would buy nothing —
 * what these tests check is which request the screen sends and what it does
 * with the answer.
 */
function renderFake(source: string): string | undefined {
  const opened = (source.match(/\{\{#[\w.]+/g) ?? []).length
  const closed = (source.match(/\{\{\/[\w.]+/g) ?? []).length
  if (opened !== closed) return undefined
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => SAMPLE_CONTEXT[key] ?? '')
}

/** Matches the server's deliberately loose check — see email/settings.ts. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const TEST_STAGES: StageRecord[] = [
  { id: 1, name: 'New', position: 0, isTerminal: false, leadCount: 2 },
  { id: 2, name: 'Contacted', position: 1, isTerminal: false, leadCount: 0 },
  { id: 3, name: 'Closed', position: 2, isTerminal: true, leadCount: 0 },
]

let nextEventId = 1000

export function makeLead(overrides: Partial<LeadDetail> & { id: number }): LeadDetail {
  return {
    name: `Lead ${overrides.id}`,
    email: `lead${overrides.id}@example.com`,
    phone: null,
    source: 'Driver application',
    formId: 1,
    stageId: 1,
    stageName: 'New',
    isSpam: false,
    fields: {},
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    events: [
      {
        id: overrides.id * 10,
        type: 'created',
        payload: { via: 'intake', form: 'Driver application' },
        actor: 'form:sekrit-form-key',
        createdAt: '2026-07-01T12:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

/**
 * The body is snapshotted, never aliased. Handing back a live reference into
 * `api.leads` would make a screen appear to update on any re-render even if the
 * client threw the response away — which is exactly what the mutation tests are
 * here to catch.
 */
function jsonResponse(status: number, body: unknown): Response {
  const snapshot = structuredClone(body)
  return { ok: status >= 200 && status < 300, status, json: async () => snapshot } as Response
}

function searchable(lead: LeadDetail): string {
  return [lead.name, lead.email, lead.phone, ...Object.values(lead.fields).map(String)]
    .filter((part) => part !== null)
    .join(' ')
    .toLowerCase()
}

function pushEvent(lead: LeadDetail, event: Omit<LeadEventRecord, 'id' | 'createdAt'>) {
  nextEventId += 1
  lead.events.push({ ...event, id: nextEventId, createdAt: new Date().toISOString() })
}

function listLeads(api: FakeApi, query: URLSearchParams) {
  const isSpam = query.get('spam') === 'true'
  const stage = query.get('stage')
  const search = query.get('search')?.toLowerCase() ?? ''
  const limit = Number(query.get('limit') ?? '50')
  const offset = Number(query.get('offset') ?? '0')

  const matched = api.leads.filter(
    (lead) =>
      lead.isSpam === isSpam &&
      (stage === null || lead.stageId === Number(stage)) &&
      (search === '' || searchable(lead).includes(search)),
  )
  return {
    leads: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    offset,
  }
}

/**
 * Counts derived from the leads on hand rather than stored, spam included —
 * that is what the server counts, and it is what makes `leadCount === 0` mean
 * "deletable" here too.
 */
function stagesWithCounts(api: FakeApi): StageRecord[] {
  return api.stages
    .map((stage) => ({
      ...stage,
      leadCount: api.leads.filter((lead) => lead.stageId === stage.id).length,
    }))
    .toSorted((a, b) => a.position - b.position || a.id - b.id)
}

/** `undefined` when the path is not the funnel's, so `handle` can carry on. */
function handleStages(api: FakeApi, method: string, path: string, body: unknown): Response | undefined {
  const payload = (body ?? {}) as Record<string, unknown>
  const name = typeof payload['name'] === 'string' ? payload['name'].trim() : undefined

  if (method === 'GET' && path === '/api/v1/stages') {
    return jsonResponse(200, { stages: stagesWithCounts(api) })
  }
  if (method === 'POST' && path === '/api/v1/stages') {
    if (name === undefined || name === '') return jsonResponse(400, { error: 'invalid_name' })
    const id = api.stages.reduce((next, stage) => Math.max(next, stage.id + 1), 1)
    const position = api.stages.reduce((next, stage) => Math.max(next, stage.position + 1), 0)
    api.stages.push({ id, name, position, isTerminal: payload['isTerminal'] === true, leadCount: 0 })
    return jsonResponse(201, { stage: stagesWithCounts(api).find((stage) => stage.id === id) })
  }
  if (method === 'POST' && path === '/api/v1/stages/reorder') {
    const stageIds = payload['stageIds']
    // The server refuses a partial order; so does this, or the client could get
    // away with sending one.
    if (!Array.isArray(stageIds) || stageIds.length !== api.stages.length) {
      return jsonResponse(400, { error: 'invalid_order' })
    }
    for (const [position, id] of stageIds.entries()) {
      const stage = api.stages.find((row) => row.id === id)
      if (stage === undefined) return jsonResponse(400, { error: 'invalid_order' })
      stage.position = position
    }
    return jsonResponse(200, { stages: stagesWithCounts(api) })
  }

  const match = /^\/api\/v1\/stages\/(\d+)$/.exec(path)
  if (match === null) return undefined
  const stage = api.stages.find((row) => row.id === Number(match[1]))
  if (stage === undefined) return jsonResponse(404, { error: 'not_found' })

  if (method === 'PATCH') {
    if (payload['name'] !== undefined) {
      if (name === undefined || name === '') return jsonResponse(400, { error: 'invalid_name' })
      stage.name = name
      // The denormalised name every lead carries moves with it, as it does in
      // the server's join.
      for (const lead of api.leads) if (lead.stageId === stage.id) lead.stageName = name
    }
    if (typeof payload['isTerminal'] === 'boolean') stage.isTerminal = payload['isTerminal']
    return jsonResponse(200, { stage: stagesWithCounts(api).find((row) => row.id === stage.id) })
  }
  if (method === 'DELETE') {
    if (api.stages.length <= 1) return jsonResponse(409, { error: 'last_stage' })
    if (api.leads.some((lead) => lead.stageId === stage.id)) {
      return jsonResponse(409, { error: 'stage_not_empty' })
    }
    api.stages = api.stages.filter((row) => row.id !== stage.id)
    return jsonResponse(200, { stages: stagesWithCounts(api) })
  }
  return undefined
}

function toSettingsResponse(stored: StoredEmailSettings): EmailSettings {
  const { smtpPassword, ...rest } = stored
  return { ...rest, smtpPasswordSet: smtpPassword !== '' }
}

/**
 * Patch semantics and per-field refusals, as the server has them — so a client
 * that stopped sending `smtpPassword` correctly, or sent a bad address, fails
 * here the way it would in production rather than passing on a lenient stub.
 */
function handleEmailSettings(api: FakeApi, method: string, path: string, body: unknown): Response | undefined {
  const payload = (body ?? {}) as Record<string, unknown>

  if (path === '/api/v1/settings/email' && method === 'GET') {
    return jsonResponse(200, { settings: toSettingsResponse(api.emailSettings) })
  }

  if (path === '/api/v1/settings/email' && method === 'PATCH') {
    if ('smtpPort' in payload && !Number.isInteger(payload['smtpPort'])) {
      return jsonResponse(400, { error: 'invalid_smtp_port' })
    }
    for (const [key, code] of [
      ['fromAddress', 'invalid_from_address'],
      ['replyTo', 'invalid_reply_to'],
    ] as const) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim() !== '' && !ADDRESS.test(value.trim())) {
        return jsonResponse(400, { error: code })
      }
    }

    const stored = api.emailSettings
    for (const key of Object.keys(stored) as (keyof StoredEmailSettings)[]) {
      if (!(key in payload)) continue
      const value = payload[key]
      if (key === 'fromAddress' || key === 'replyTo') {
        stored[key] = String(value).trim().toLowerCase()
      } else if (key === 'smtpPort') {
        stored.smtpPort = value as number
      } else if (key === 'smtpSecure') {
        stored.smtpSecure = value as boolean
      } else {
        stored[key] = value as string
      }
    }
    return jsonResponse(200, { settings: toSettingsResponse(stored) })
  }

  if (path === '/api/v1/settings/email/test' && method === 'POST') {
    const to = typeof payload['to'] === 'string' ? payload['to'].trim().toLowerCase() : ''
    if (!ADDRESS.test(to)) return jsonResponse(400, { error: 'invalid_email' })
    if (api.emailSettings.smtpHost === '' || api.emailSettings.fromAddress === '') {
      return jsonResponse(409, { error: 'not_configured' })
    }
    if (api.testEmailFailure !== undefined) {
      return jsonResponse(502, { error: 'send_failed', detail: api.testEmailFailure })
    }
    api.testEmailsSent.push(to)
    return jsonResponse(200, { ok: true, to })
  }

  return undefined
}

/**
 * The template surface, with the same refusals the server has: source that does
 * not render is answered as a 400 carrying the engine's complaint, and neither
 * preview nor test-send writes anything.
 */
function handleEmailTemplates(
  api: FakeApi,
  method: string,
  path: string,
  body: unknown,
): Response | undefined {
  const base = '/api/v1/settings/email/templates'
  if (method === 'GET' && path === base) return jsonResponse(200, { templates: api.emailTemplates })

  const match = new RegExp(`^${base}/([a-z_]+)(/preview|/test)?$`).exec(path)
  if (match === null) return undefined
  const template = api.emailTemplates.find((row) => row.trigger === match[1])
  if (template === undefined) return jsonResponse(404, { error: 'not_found' })

  const payload = (body ?? {}) as Record<string, unknown>
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : template.subject
  const draftBody = typeof payload['body'] === 'string' ? payload['body'] : template.body
  if (subject.trim() === '') return jsonResponse(400, { error: 'invalid_subject' })
  if (draftBody.trim() === '') return jsonResponse(400, { error: 'invalid_body' })

  const renderedSubject = renderFake(subject)
  if (renderedSubject === undefined) {
    return jsonResponse(400, { error: 'invalid_subject_template', detail: 'Parse error.' })
  }
  const renderedBody = renderFake(draftBody)
  if (renderedBody === undefined) {
    return jsonResponse(400, { error: 'invalid_body_template', detail: 'Parse error.' })
  }

  if (method === 'PATCH' && match[2] === undefined) {
    template.subject = subject.trim()
    template.body = draftBody
    if (typeof payload['enabled'] === 'boolean') template.enabled = payload['enabled']
    return jsonResponse(200, { template })
  }
  if (method === 'POST' && match[2] === '/preview') {
    const leadId = typeof payload['leadId'] === 'number' ? payload['leadId'] : null
    if (leadId !== null && !api.leads.some((lead) => lead.id === leadId)) {
      return jsonResponse(400, { error: 'invalid_lead' })
    }
    return jsonResponse(200, {
      preview: { subject: renderedSubject, body: renderedBody, leadId },
    })
  }
  if (method === 'POST' && match[2] === '/test') {
    if (api.emailSettings.smtpHost === '' || api.emailSettings.fromAddress === '') {
      return jsonResponse(409, { error: 'not_configured' })
    }
    if (api.testEmailFailure !== undefined) {
      return jsonResponse(502, { error: 'send_failed', detail: api.testEmailFailure })
    }
    api.templateEmailsSent.push({
      trigger: template.trigger,
      subject: renderedSubject,
      body: renderedBody,
    })
    return jsonResponse(200, { ok: true, to: TEMPLATE_TEST_RECIPIENT })
  }
  return undefined
}

/**
 * Prefixes are words rather than the random-looking slice a real key carries.
 * Same shape — `philo_` and six more characters — but low enough entropy that
 * the repo's secret scanner does not have to be told to ignore them, which is a
 * concession worth making in a fixture and nowhere else.
 */
export const TEST_API_KEYS: ApiKeyRecord[] = [
  {
    id: 1,
    name: 'Nightly export',
    keyPrefix: 'philo_export',
    createdAt: '2026-07-01T12:00:00.000Z',
    lastUsedAt: '2026-07-04T09:30:00.000Z',
  },
  {
    id: 2,
    name: 'Claude Code',
    keyPrefix: 'philo_second',
    createdAt: '2026-07-02T12:00:00.000Z',
    lastUsedAt: null,
  },
]

/** Mirrors MAX_API_KEY_NAME_LENGTH in server/src/auth/api-keys.ts. */
const MAX_KEY_NAME = 80

/**
 * Key management with the server's refusals: a nameless key is a 400, a second
 * revoke is a 404, and the secret appears in exactly one response and is then
 * unrecoverable — which is the property the screen has to be built around.
 */
function handleApiKeys(api: FakeApi, method: string, path: string, body: unknown): Response | undefined {
  const base = '/api/v1/api-keys'
  if (method === 'GET' && path === base) return jsonResponse(200, { keys: api.apiKeys })

  if (method === 'POST' && path === base) {
    const payload = (body ?? {}) as Record<string, unknown>
    const raw = payload['name']
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '' || name.length > MAX_KEY_NAME) return jsonResponse(400, { error: 'invalid_name' })

    const id = api.apiKeys.reduce((next, key) => Math.max(next, key.id + 1), 1)
    const secret = `philo_secret${id}-not-a-real-key`
    const key: ApiKeyRecord = {
      id,
      name,
      keyPrefix: secret.slice(0, 12),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    api.apiKeys = [key, ...api.apiKeys]
    api.apiKeySecrets.push(secret)
    return jsonResponse(201, { key, secret })
  }

  const match = new RegExp(`^${base}/(\\d+)$`).exec(path)
  if (match === null || method !== 'DELETE') return undefined
  const id = Number(match[1])
  if (!api.apiKeys.some((key) => key.id === id)) return jsonResponse(404, { error: 'not_found' })
  api.apiKeys = api.apiKeys.filter((key) => key.id !== id)
  return jsonResponse(200, { ok: true })
}

/** Base64url, as the server generates and serves it. 65 bytes of P-256 point. */
export const TEST_VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

/** Matches the server's validation in push/subscriptions.ts, so the client cannot drift. */
const BASE64URL = /^[A-Za-z0-9_-]+$/

function handlePush(
  api: FakeApi,
  method: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Response | undefined {
  if (method === 'GET' && path === '/api/v1/push/key') {
    return jsonResponse(200, { publicKey: api.vapidPublicKey })
  }
  if (method === 'GET' && path === '/api/v1/push/live') return liveResponse(api, signal)
  if (path !== '/api/v1/push/subscriptions') return undefined

  const payload = (body ?? {}) as Record<string, unknown>

  if (method === 'POST') {
    const endpoint = payload['endpoint']
    const rawKeys = payload['keys']
    const keys = (typeof rawKeys === 'object' && rawKeys !== null ? rawKeys : {}) as Record<string, unknown>
    const p256dh = keys['p256dh']
    const auth = keys['auth']
    // Every refusal the server has, so a client that sends the wrong shape
    // fails here rather than passing against something lenient.
    if (
      typeof endpoint !== 'string' ||
      !endpoint.startsWith('https://') ||
      typeof p256dh !== 'string' ||
      typeof auth !== 'string' ||
      !BASE64URL.test(p256dh) ||
      !BASE64URL.test(auth)
    ) {
      return jsonResponse(400, { error: 'invalid_subscription' })
    }
    // Upsert on the endpoint, as the unique index makes it.
    api.pushSubscriptions = api.pushSubscriptions.filter((row) => row.endpoint !== endpoint)
    api.pushSubscriptions.push({ endpoint, p256dh, auth })
    return jsonResponse(201, { ok: true })
  }

  if (method === 'DELETE') {
    const endpoint = payload['endpoint']
    if (typeof endpoint !== 'string' || endpoint === '') {
      return jsonResponse(400, { error: 'invalid_subscription' })
    }
    api.pushSubscriptions = api.pushSubscriptions.filter((row) => row.endpoint !== endpoint)
    return jsonResponse(200, { ok: true })
  }
  return undefined
}

function liveResponse(api: FakeApi, signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const notification of api.liveNotifications) {
        controller.enqueue(encoder.encode(`event: lead\ndata: ${JSON.stringify(notification)}\n\n`))
      }
      // A real fetch errors the body on abort; this is that.
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {
        once: true,
      })
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export const TEST_ISSUER = 'http://localhost:3000'
export const TEST_CLIENT_ID = 'philo-web'

let nextToken = 1

function issueTokens(api: FakeApi): { accessToken: string; refreshToken: string } {
  nextToken += 1
  api.accessToken = `access-${nextToken}`
  api.refreshToken = `refresh-${nextToken}`
  return { accessToken: api.accessToken, refreshToken: api.refreshToken }
}

function jwtPart(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('=', '')
}

/** An unsigned id_token — the client reads its nonce and verifies nothing else (sdk/src/oidc.ts). */
function idToken(nonce: string): string {
  return `${jwtPart({ alg: 'none' })}.${jwtPart({ nonce, sub: String(TEST_USER.id) })}.`
}

function tokenAnswer(api: FakeApi, nonce?: string): Response {
  const { accessToken, refreshToken } = issueTokens(api)
  return jsonResponse(200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid operator',
    ...(nonce === undefined ? {} : { id_token: idToken(nonce) }),
  })
}

/**
 * The token endpoint, holding the client to what the server does: the code is
 * single-use, PKCE is checked, and a refresh token is spent by using it.
 */
async function handleToken(api: FakeApi, params: URLSearchParams): Promise<Response> {
  if (params.get('client_id') !== TEST_CLIENT_ID) return jsonResponse(401, { error: 'invalid_client' })
  const grant = params.get('grant_type')

  if (grant === 'refresh_token') {
    if (api.refreshToken === undefined || params.get('refresh_token') !== api.refreshToken) {
      return jsonResponse(400, { error: 'invalid_grant' })
    }
    return tokenAnswer(api)
  }
  if (grant !== 'authorization_code') return jsonResponse(400, { error: 'unsupported_grant_type' })

  const code = params.get('code') ?? ''
  const issued = api.authorizations.get(code)
  api.authorizations.delete(code)
  if (issued === undefined || params.get('redirect_uri') !== issued.redirectUri) {
    return jsonResponse(400, { error: 'invalid_grant' })
  }
  if ((await pkceChallenge(params.get('code_verifier') ?? '')) !== issued.challenge) {
    return jsonResponse(400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' })
  }
  return tokenAnswer(api, issued.nonce)
}

/** The public surface: auth config, discovery, and the IdP's token and revocation endpoints. */
function handleIdp(api: FakeApi, method: string, path: string, body: unknown): Response | Promise<Response> | undefined {
  if (method === 'GET' && path === '/api/v1/auth/config') {
    return jsonResponse(200, { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID, scope: 'openid operator' })
  }
  if (method === 'GET' && path === '/.well-known/openid-configuration') {
    return jsonResponse(200, {
      issuer: TEST_ISSUER,
      authorization_endpoint: `${TEST_ISSUER}/oauth/authorize`,
      token_endpoint: `${TEST_ISSUER}/oauth/token`,
      revocation_endpoint: `${TEST_ISSUER}/oauth/revoke`,
    })
  }
  const params = body instanceof URLSearchParams ? body : new URLSearchParams()
  if (method === 'POST' && path === '/oauth/token') return handleToken(api, params)
  if (method === 'POST' && path === '/oauth/revoke') {
    const token = params.get('token') ?? ''
    api.revoked.push(token)
    if (token === api.refreshToken) {
      api.refreshToken = undefined
      api.accessToken = undefined
    }
    return jsonResponse(200, {})
  }
  return undefined
}

/**
 * What the IdP's authorize page does once the person signs in: checks the
 * request, remembers the PKCE challenge against a fresh code, and answers with
 * the URL it would redirect the browser back to.
 */
export function authorize(api: FakeApi, authorizeUrl: string): string {
  const request = new URL(authorizeUrl)
  const params = request.searchParams
  if (request.pathname !== '/oauth/authorize') throw new Error(`not the authorize endpoint: ${authorizeUrl}`)
  if (params.get('client_id') !== TEST_CLIENT_ID || params.get('response_type') !== 'code') {
    throw new Error(`unexpected authorization request: ${authorizeUrl}`)
  }
  if (params.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 is required')
  const redirectUri = params.get('redirect_uri') ?? ''
  const code = `code-${api.authorizations.size + 1}-${Date.now()}`
  api.authorizations.set(code, {
    challenge: params.get('code_challenge') ?? '',
    redirectUri,
    nonce: params.get('nonce') ?? '',
  })
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', params.get('state') ?? '')
  return callback.toString()
}

function handle(
  api: FakeApi,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  authorization: string | undefined,
  signal?: AbortSignal,
): Response | Promise<Response> {
  const idpAnswer = handleIdp(api, method, path, body)
  if (idpAnswer !== undefined) return idpAnswer

  // Bearer-only, as the server is: no token, a stale one, or an expired
  // session all answer the same 401.
  const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
  if (api.expired || bearer === undefined || bearer !== api.accessToken) {
    return jsonResponse(401, { error: 'unauthorized' })
  }
  if (method === 'GET' && path === '/api/v1/auth/session') {
    if (api.user === undefined) return jsonResponse(401, { error: 'unauthorized' })
    return jsonResponse(200, { user: api.user })
  }

  if (method === 'GET' && path === '/api/v1/leads') return jsonResponse(200, listLeads(api, query))
  const pushAnswer = handlePush(api, method, path, body, signal)
  if (pushAnswer !== undefined) return pushAnswer
  const keyAnswer = handleApiKeys(api, method, path, body)
  if (keyAnswer !== undefined) return keyAnswer
  const stageAnswer = handleStages(api, method, path, body)
  if (stageAnswer !== undefined) return stageAnswer
  const templateAnswer = handleEmailTemplates(api, method, path, body)
  if (templateAnswer !== undefined) return templateAnswer
  const settingsAnswer = handleEmailSettings(api, method, path, body)
  if (settingsAnswer !== undefined) return settingsAnswer

  const match = /^\/api\/v1\/leads\/(\d+)(\/[a-z-]+)?$/.exec(path)
  const lead = match?.[1] === undefined ? undefined : api.leads.find((row) => row.id === Number(match[1]))
  if (match === null) return jsonResponse(404, { error: 'not_found' })
  if (lead === undefined) return jsonResponse(404, { error: 'not_found' })

  const action = match[2]
  if (method === 'GET' && action === undefined) return jsonResponse(200, { lead })

  const payload = (body ?? {}) as Record<string, unknown>
  if (method === 'POST' && action === '/notes') {
    const note = payload['note']
    if (typeof note !== 'string' || note.trim() === '') return jsonResponse(400, { error: 'invalid_note' })
    pushEvent(lead, { type: 'note_added', payload: { note }, actor: `user:${TEST_USER.id}` })
    return jsonResponse(200, { lead })
  }
  if (method === 'POST' && action === '/stage') {
    const stage = api.stages.find((row) => row.id === payload['stageId'])
    if (stage === undefined) return jsonResponse(422, { error: 'invalid_stage' })
    pushEvent(lead, {
      type: 'stage_changed',
      payload: { from: { id: lead.stageId, name: lead.stageName }, to: { id: stage.id, name: stage.name } },
      actor: `user:${TEST_USER.id}`,
    })
    lead.stageId = stage.id
    lead.stageName = stage.name
    return jsonResponse(200, { lead })
  }
  if (method === 'POST' && action === '/not-spam') {
    if (lead.isSpam) {
      lead.isSpam = false
      pushEvent(lead, {
        type: 'note_added',
        payload: { note: 'Marked as not spam.', system: true },
        actor: `user:${TEST_USER.id}`,
      })
    }
    return jsonResponse(200, { lead })
  }

  return jsonResponse(404, { error: 'not_found' })
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers === undefined) return undefined
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers as Record<string, string>)
  return entries.find(([key]) => key.toLowerCase() === name)?.[1]
}

/**
 * Signed in by default, as most screens are tested: the client already holds a
 * valid token, and a refresh token waits in storage for an `<App />` that boots
 * from scratch. `signedIn: false` starts from a browser that has never signed in.
 */
/** The IdP's endpoints take a form, the API takes JSON. */
function parseBody(body: unknown, contentType: string | undefined): unknown {
  if (typeof body !== 'string') return undefined
  return contentType === 'application/x-www-form-urlencoded' ? new URLSearchParams(body) : JSON.parse(body)
}

export function installFakeApi(overrides: Partial<FakeApi> & { signedIn?: boolean } = {}): FakeApi {
  const { signedIn = true, ...rest } = overrides
  const api: FakeApi = {
    user: TEST_USER,
    accessToken: undefined,
    refreshToken: undefined,
    authorizations: new Map(),
    revoked: [],
    stages: TEST_STAGES,
    leads: [],
    expired: false,
    hold: undefined,
    offline: undefined,
    emailSettings: TEST_EMAIL_SETTINGS,
    testEmailFailure: undefined,
    testEmailsSent: [],
    emailTemplates: TEST_EMAIL_TEMPLATES,
    templateEmailsSent: [],
    apiKeys: TEST_API_KEYS,
    apiKeySecrets: [],
    vapidPublicKey: TEST_VAPID_PUBLIC_KEY,
    pushSubscriptions: [],
    liveNotifications: [],
    calls: [],
    ...rest,
  }
  // Owned outright: the funnel, settings and template handlers mutate in place,
  // and each default is one object shared by every test in the run.
  api.stages = structuredClone(api.stages)
  api.emailSettings = structuredClone(api.emailSettings)
  api.emailTemplates = structuredClone(api.emailTemplates)
  api.apiKeys = structuredClone(api.apiKeys)

  const tokens = signedIn ? issueTokens(api) : undefined
  setAccessTokenSource(tokens === undefined ? undefined : () => api.accessToken)
  try {
    if (tokens === undefined) window.localStorage.removeItem(REFRESH_TOKEN_KEY)
    else window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
    window.sessionStorage.clear()
  } catch {
    // A test that made storage throw gets a browser that remembers nothing.
  }

  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), TEST_ISSUER)
    const method = init?.method ?? 'GET'
    const contentType = headerOf(init, 'content-type')
    api.calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: parseBody(init?.body, contentType),
      contentType,
      authorization: headerOf(init, 'authorization'),
    })
    if (api.offline?.test(url.pathname) === true) throw new TypeError('Failed to fetch')
    if (api.hold !== undefined) await api.hold
    const call = api.calls.at(-1)
    return handle(api, method, url.pathname, url.searchParams, call?.body, call?.authorization, init?.signal ?? undefined)
  })

  return api
}
