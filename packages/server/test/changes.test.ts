import { desc } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leads } from '../src/db/schema.ts'
import { ChangeFeed, type ChangeEvent } from '../src/events/feed.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import {
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface Harness {
  testApp: TestApp
  feed: ChangeFeed
  events: ChangeEvent[]
  authorization: string
  api: (path: string, init?: RequestInit) => Promise<Response>
}

async function harness(): Promise<Harness> {
  const feed = new ChangeFeed()
  const events: ChangeEvent[] = []
  feed.listen((event) => events.push(event))
  const testApp = createTestApp({ changeFeed: feed, liveTuning: { heartbeatMs: 60_000, maxDurationMs: 60_000 } })
  const authorization = await setupAdmin(testApp)
  const api = (path: string, init: RequestInit = {}) =>
    testApp.app.request(`/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization },
    })
  return { testApp, feed, events, authorization, api }
}

async function submit(testApp: TestApp, body: Record<string, unknown>, formKey = defaultFormKey(testApp)) {
  const res = await testApp.app.request(`/api/intake/${formKey}`, jsonPost(body))
  if (res.status !== 201) throw new Error(`intake failed: ${res.status}`)
  const [row] = testApp.db.select({ id: leads.id }).from(leads).orderBy(desc(leads.id)).limit(1).all()
  return row!.id
}

async function stagesOf(h: Harness, funnelId?: number): Promise<{ id: number; name: string }[]> {
  const res = await h.api(`/stages${funnelId === undefined ? '' : `?funnel=${funnelId}`}`)
  return ((await res.json()) as { stages: { id: number; name: string }[] }).stages
}

describe('the change feed', () => {
  it('announces a submitted lead, with the lead', async () => {
    const h = await harness()
    const id = await submit(h.testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: 'lead.created', data: { lead: { id, name: 'Dana Rivers' } } })
    expect(h.events[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('says nothing about spam, until it is promoted', async () => {
    const h = await harness()
    const id = await submit(h.testApp, { email: 'bot@example.com', [HONEYPOT_FIELD]: 'x' })
    expect(h.events).toHaveLength(0)

    await h.api(`/leads/${id}`, { ...jsonPost({ name: 'Still spam' }), method: 'PATCH' })
    expect(h.events).toHaveLength(0)

    await h.api(`/leads/${id}/not-spam`, { method: 'POST' })
    expect(h.events.map((event) => event.type)).toEqual(['lead.created'])
  })

  it('announces a lead filed by hand', async () => {
    const h = await harness()
    const res = await h.api('/leads', jsonPost({ name: 'By Hand', email: 'hand@example.com' }))
    expect(res.status).toBe(201)
    expect(h.events.map((event) => event.type)).toEqual(['lead.created'])
  })

  it('announces edits, notes and files as updates', async () => {
    const h = await harness()
    const id = await submit(h.testApp, { email: 'dana@example.com' })
    h.events.length = 0

    await h.api(`/leads/${id}`, { ...jsonPost({ details: { license: 'A' } }), method: 'PATCH' })
    await h.api(`/leads/${id}/notes`, jsonPost({ note: 'Called.' }))
    const upload = await h.api(`/leads/${id}/attachments?filename=a.txt`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    const { lead } = (await upload.json()) as { lead: { attachments: { id: number }[] } }
    await h.api(`/leads/${id}/attachments/${lead.attachments[0]!.id}`, { method: 'DELETE' })

    expect(h.events.map((event) => event.type)).toEqual(['lead.updated', 'lead.updated', 'lead.updated', 'lead.updated'])
    expect(h.events[0]!.data.lead!.details).toEqual({ license: 'A' })
  })

  it('announces a stage move with where it came from, and stays quiet for a move to where it is', async () => {
    const h = await harness()
    const id = await submit(h.testApp, { email: 'dana@example.com' })
    const [first, second] = await stagesOf(h)
    h.events.length = 0

    await h.api(`/leads/${id}/stage`, jsonPost({ stageId: first!.id }))
    expect(h.events).toHaveLength(0)

    await h.api(`/leads/${id}/stage`, jsonPost({ stageId: second!.id }))
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({
      type: 'lead.stage_changed',
      data: { lead: { stageId: second!.id }, from: { id: first!.id, name: first!.name } },
    })
  })

  it('announces a deletion by id alone', async () => {
    const h = await harness()
    const id = await submit(h.testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    h.events.length = 0

    expect((await h.api(`/leads/${id}`, { method: 'DELETE' })).status).toBe(204)

    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.type).toBe('lead.deleted')
    expect(h.events[0]!.data).toEqual({ leadId: id })
    expect(JSON.stringify(h.events[0])).not.toContain('dana')
  })

  it('announces changes to a funnel and its stages', async () => {
    const h = await harness()
    const [first] = await stagesOf(h)

    await h.api('/stages', jsonPost({ name: 'Interview', isTerminal: false }))
    await h.api(`/stages/${first!.id}`, { ...jsonPost({ name: 'Inbox' }), method: 'PATCH' })
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number } }

    expect(h.events.map((event) => event.type)).toEqual(['funnel.changed', 'funnel.changed', 'funnel.changed'])
    expect(h.events[2]!.funnelId).toBe(funnel.id)
    expect(h.events[0]!.funnelId).not.toBe(funnel.id)
  })

  it('stays quiet when a change is refused', async () => {
    const h = await harness()
    await h.api('/leads', jsonPost({ name: 'Nobody' }))
    await h.api('/leads/999', { method: 'DELETE' })
    await h.api('/leads/999/stage', jsonPost({ stageId: 1 }))
    expect(h.events).toHaveLength(0)
  })
})

/** Reads the stream until `predicate` holds over everything received so far. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (text: string) => boolean) {
  const decoder = new TextDecoder()
  let text = ''
  while (!predicate(text)) {
    const { value, done } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe('GET /api/v1/events', () => {
  it('needs a credential', async () => {
    const h = await harness()
    expect((await h.testApp.app.request('/api/v1/events')).status).toBe(401)
  })

  it('refuses a funnel that is not an id', async () => {
    const h = await harness()
    expect((await h.api('/events?funnel=abc')).status).toBe(400)
  })

  it('streams each change, named by its type', async () => {
    const h = await harness()
    const res = await h.api('/events')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    await readUntil(reader, (text) => text.includes(': connected'))

    const id = await submit(h.testApp, { email: 'dana@example.com' })

    const text = await readUntil(reader, (received) => received.includes('event: lead.created'))
    const data = text.split('\n').find((line) => line.startsWith('data: '))!
    expect(JSON.parse(data.slice(6))).toMatchObject({ type: 'lead.created', data: { lead: { id } } })
    await reader.cancel()
    expect(h.feed.listenerCount).toBe(1)
  })

  it('narrows to one funnel', async () => {
    const h = await harness()
    const defaultFormKeyBefore = defaultFormKey(h.testApp)
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number; forms: { formKey: string }[] } }

    const res = await h.api(`/events?funnel=${funnel.id}`)
    const reader = res.body!.getReader()
    await readUntil(reader, (text) => text.includes(': connected'))

    await submit(h.testApp, { email: 'default@example.com' }, defaultFormKeyBefore)
    const salesLead = await submit(h.testApp, { email: 'sales@example.com' }, funnel.forms[0]!.formKey)

    const text = await readUntil(reader, (received) => received.includes('event: lead.created'))
    expect(text).toContain(`"id":${salesLead}`)
    expect(text).not.toContain('default@example.com')
    await reader.cancel()
  })

  it('tells the funnel a lead left', async () => {
    const h = await harness()
    const defaultFunnelForm = defaultFormKey(h.testApp)
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number } }
    const [salesStage] = await stagesOf(h, funnel.id)
    const id = await submit(h.testApp, { email: 'dana@example.com' }, defaultFunnelForm)
    const listed = await h.api('/funnels')
    const { funnels } = (await listed.json()) as { funnels: { id: number; isDefault: boolean }[] }
    const defaultFunnel = funnels.find((candidate) => candidate.isDefault)!

    const res = await h.api(`/events?funnel=${defaultFunnel.id}`)
    const reader = res.body!.getReader()
    await readUntil(reader, (text) => text.includes(': connected'))

    await h.api(`/leads/${id}/stage`, jsonPost({ stageId: salesStage!.id }))

    const text = await readUntil(reader, (received) => received.includes('event: lead.stage_changed'))
    expect(text).toContain(`"funnelId":${funnel.id}`)
    await reader.cancel()
  })
})
