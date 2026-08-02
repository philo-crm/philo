import { vi } from 'vitest'
import type { LeadDetail, LeadEventRecord, StageRecord } from '../../src/api.ts'
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

  if (method === 'GET' && path === '/api/v1/stages') return jsonResponse(200, { stages: api.stages })
  if (method === 'GET' && path === '/api/v1/leads') return jsonResponse(200, listLeads(api, query))

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
    calls: [],
    ...overrides,
  }

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
