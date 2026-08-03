import { vi } from 'vitest'
import type { EmailSettings, LeadDetail, LeadEventRecord, StageRecord } from '../../src/api.ts'
import type { User } from '../../src/auth.ts'

/**
 * An in-memory stand-in for the REST surface, close enough that a screen test
 * exercises the real request the browser would send and the real answer it
 * would get back. A mock per assertion would pass while the client sent the
 * wrong query string; this cannot.
 */
export interface FakeApi {
  user: User | undefined
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
  /** Every request the app made, in order. */
  calls: {
    method: string
    path: string
    query: URLSearchParams
    body: unknown
    contentType: string | undefined
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

function handle(api: FakeApi, method: string, path: string, query: URLSearchParams, body: unknown): Response {
  if (method === 'GET' && path === '/api/v1/auth/status') {
    return jsonResponse(200, { needsSetup: false, authenticated: api.user !== undefined })
  }
  if (method === 'GET' && path === '/api/v1/auth/session') {
    if (api.user === undefined || api.expired) return jsonResponse(401, { error: 'unauthorized' })
    return jsonResponse(200, { user: api.user })
  }
  if (method === 'POST' && path === '/api/v1/auth/login') {
    api.user = TEST_USER
    api.expired = false
    return jsonResponse(200, { user: TEST_USER })
  }
  if (method === 'POST' && path === '/api/v1/auth/logout') {
    api.user = undefined
    return jsonResponse(204, undefined)
  }

  if (api.expired) return jsonResponse(401, { error: 'unauthorized' })

  if (method === 'GET' && path === '/api/v1/leads') return jsonResponse(200, listLeads(api, query))
  const stageAnswer = handleStages(api, method, path, body)
  if (stageAnswer !== undefined) return stageAnswer
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

export function installFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  const api: FakeApi = {
    user: TEST_USER,
    stages: TEST_STAGES,
    leads: [],
    expired: false,
    hold: undefined,
    offline: undefined,
    emailSettings: TEST_EMAIL_SETTINGS,
    testEmailFailure: undefined,
    testEmailsSent: [],
    calls: [],
    ...overrides,
  }
  // Owned outright: the funnel and settings handlers mutate in place, and both
  // defaults are one object shared by every test in the run.
  api.stages = structuredClone(api.stages)
  api.emailSettings = structuredClone(api.emailSettings)

  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://philo.example.com')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    api.calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      contentType: headerOf(init, 'content-type'),
    })
    if (api.offline?.test(url.pathname) === true) throw new TypeError('Failed to fetch')
    if (api.hold !== undefined) await api.hold
    return handle(api, method, url.pathname, url.searchParams, body)
  })

  return api
}
