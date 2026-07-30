import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leadEvents, leads, stages } from '../src/db/schema.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import { MAX_NOTE_LENGTH, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, NOT_SPAM_NOTE } from '../src/leads/service.ts'
import type { CreatedLead } from '../src/notify.ts'
import {
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  TEST_ORIGIN,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

interface LeadResponse {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  source: string | null
  formId: number | null
  stageId: number
  stageName: string
  isSpam: boolean
  fields: Record<string, unknown>
  createdAt: string
  updatedAt: string
  events?: { id: number; type: string; payload: Record<string, unknown>; actor: string }[]
}

interface LeadPageResponse {
  leads: LeadResponse[]
  total: number
  limit: number
  offset: number
}

function jsonRequest(method: string, body: unknown, cookie: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

/** Through the real intake endpoint, so `fields`, the FTS index, and the `created` event are all real. */
async function submit(testApp: TestApp, payload: Record<string, unknown>): Promise<void> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${await res.text()}`)
}

async function list(testApp: TestApp, cookie: string, query = ''): Promise<LeadPageResponse> {
  const res = await testApp.app.request(`/api/v1/leads${query}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as LeadPageResponse
}

async function detail(testApp: TestApp, cookie: string, id: number): Promise<LeadResponse> {
  const res = await testApp.app.request(`/api/v1/leads/${id}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { lead: LeadResponse }
  return body.lead
}

/** The seeded funnel, in funnel order — `New`, `Contacted`, `Qualified`, `Closed`. */
function stageIds(testApp: TestApp): number[] {
  return testApp.db
    .select({ id: stages.id })
    .from(stages)
    .orderBy(asc(stages.position))
    .all()
    .map((stage) => stage.id)
}

function onlyLeadId(testApp: TestApp): number {
  const [lead] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
  if (lead === undefined) throw new Error('no lead was created')
  return lead.id
}

describe('GET /api/v1/leads', () => {
  it('lists non-spam leads newest first, with the stage resolved', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', years_experience: 7 })
    await submit(testApp, { name: 'Alex Kim', phone: '555-0100' })

    const page = await list(testApp, cookie)
    expect(page).toMatchObject({ total: 2, limit: 50, offset: 0 })
    expect(page.leads.map((lead) => lead.name)).toEqual(['Alex Kim', 'Dana Rivers'])
    expect(page.leads[1]).toMatchObject({
      email: 'dana@example.com',
      stageName: 'New',
      isSpam: false,
      fields: { years_experience: 7 },
    })
  })

  it('hides quarantined leads until asked for them', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Real Person', email: 'real@example.com' })
    await submit(testApp, { name: 'Bot', email: 'bot@example.com', [HONEYPOT_FIELD]: 'filled' })

    expect((await list(testApp, cookie)).leads.map((lead) => lead.name)).toEqual(['Real Person'])
    const spam = await list(testApp, cookie, '?spam=true')
    expect(spam.leads.map((lead) => lead.name)).toEqual(['Bot'])
    expect(spam.leads[0]?.isSpam).toBe(true)
  })

  it('filters by stage', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    await submit(testApp, { name: 'Alex Kim', email: 'alex@example.com' })
    const [, contacted] = stageIds(testApp)
    const moved = (await list(testApp, cookie)).leads[0]

    await testApp.app.request(
      `/api/v1/leads/${moved?.id}/stage`,
      jsonPost({ stageId: contacted }, { cookie }),
    )

    const page = await list(testApp, cookie, `?stage=${contacted}`)
    expect(page.total).toBe(1)
    expect(page.leads[0]?.id).toBe(moved?.id)
  })

  it('filters by form', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const formId = (await list(testApp, cookie)).leads[0]?.formId ?? 0

    expect((await list(testApp, cookie, `?form=${formId}`)).total).toBe(1)
    expect((await list(testApp, cookie, `?form=${formId + 1}`)).total).toBe(0)
  })

  it('filters by created date range, inclusive at both ends', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [stage] = stageIds(testApp)
    const old = new Date('2026-01-01T00:00:00.000Z')
    const recent = new Date('2026-06-01T00:00:00.000Z')
    testApp.db
      .insert(leads)
      .values([
        { name: 'Old', email: 'old@example.com', currentStageId: stage ?? 0, createdAt: old },
        { name: 'Recent', email: 'recent@example.com', currentStageId: stage ?? 0, createdAt: recent },
      ])
      .run()

    expect((await list(testApp, cookie, '?createdAfter=2026-03-01T00:00:00.000Z')).leads.map((l) => l.name)).toEqual(['Recent'])
    expect((await list(testApp, cookie, '?createdBefore=2026-03-01T00:00:00.000Z')).leads.map((l) => l.name)).toEqual(['Old'])
    expect((await list(testApp, cookie, `?createdAfter=${old.toISOString()}&createdBefore=${recent.toISOString()}`)).total).toBe(2)
  })

  it('paginates with a stable total', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    for (let index = 0; index < 5; index += 1) {
      await submit(testApp, { name: `Person ${index}`, email: `person${index}@example.com` })
    }

    const first = await list(testApp, cookie, '?limit=2')
    expect(first).toMatchObject({ total: 5, limit: 2, offset: 0 })
    expect(first.leads).toHaveLength(2)

    const second = await list(testApp, cookie, '?limit=2&offset=2')
    expect(second.total).toBe(5)
    expect(second.leads.map((lead) => lead.id)).not.toEqual(first.leads.map((lead) => lead.id))
  })

  it.each([
    ['a non-numeric stage', '?stage=new'],
    ['a bad boolean', '?spam=maybe'],
    ['an unparseable date', '?createdAfter=yesterday'],
    ['a zero limit', '?limit=0'],
    ['a limit past the ceiling', `?limit=${MAX_PAGE_SIZE + 1}`],
    ['a negative offset', '?offset=-1'],
  ])('400s %s rather than ignoring it', async (_label, query) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request(`/api/v1/leads${query}`, { headers: { cookie } })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_request' })
  })

  it('requires a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/leads (FTS5 search)', () => {
  it('matches on name, email, and values inside the fields JSON', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, {
      name: 'Dana Rivers',
      email: 'dana@example.com',
      endorsements: 'hazmat tanker',
    })
    await submit(testApp, { name: 'Alex Kim', email: 'alex@example.com', endorsements: 'doubles' })

    expect((await list(testApp, cookie, '?search=Dana')).leads.map((l) => l.name)).toEqual(['Dana Rivers'])
    expect((await list(testApp, cookie, '?search=alex@example.com')).leads.map((l) => l.name)).toEqual(['Alex Kim'])
    expect((await list(testApp, cookie, '?search=hazmat')).leads.map((l) => l.name)).toEqual(['Dana Rivers'])
  })

  it('matches on a prefix, the way a search box is typed', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    expect((await list(testApp, cookie, '?search=riv')).total).toBe(1)
  })

  it('requires every token, so two names do not widen the result', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    await submit(testApp, { name: 'Alex Kim', email: 'alex@example.com' })

    expect((await list(testApp, cookie, '?search=Dana%20Rivers')).total).toBe(1)
    expect((await list(testApp, cookie, '?search=Dana%20Kim')).total).toBe(0)
  })

  it.each([
    ['an FTS operator', '?search=dana%20OR%20alex'],
    ['an unbalanced quote', '?search=%22dana'],
    ['a column filter', '?search=name%3Adana'],
    ['a NEAR call', '?search=NEAR(dana%20alex)'],
  ])('survives %s instead of erroring', async (_label, query) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const res = await testApp.app.request(`/api/v1/leads${query}`, { headers: { cookie } })
    expect(res.status).toBe(200)
  })

  it('matches nothing when the search has no tokens at all', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const page = await list(testApp, cookie, '?search=%2A%2A%2A')
    expect(page).toMatchObject({ total: 0 })
    expect(page.leads).toEqual([])
  })

  it('matches nothing past the length ceiling, rather than truncating and widening', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const padded = `Dana${' nomatch'.repeat(MAX_SEARCH_LENGTH)}`
    expect(padded.length).toBeGreaterThan(MAX_SEARCH_LENGTH)
    expect((await list(testApp, cookie, `?search=${encodeURIComponent(padded)}`)).total).toBe(0)
  })

  it('keeps every token of a long-but-accepted search', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    // Twenty tokens, well past any per-token cap, all of which must be required.
    const search = ['Dana', ...Array.from({ length: 19 }, (_unused, i) => `nomatch${i}`)].join(' ')
    expect(search.length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH)
    expect((await list(testApp, cookie, `?search=${encodeURIComponent(search)}`)).total).toBe(0)
  })

  it('respects the spam filter while searching', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', [HONEYPOT_FIELD]: 'x' })

    expect((await list(testApp, cookie, '?search=Dana')).total).toBe(0)
    expect((await list(testApp, cookie, '?search=Dana&spam=true')).total).toBe(1)
  })
})

describe('GET /api/v1/leads/:id', () => {
  it('returns the record with its timeline', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', cdl_class: 'A' })

    const lead = await detail(testApp, cookie, onlyLeadId(testApp))
    expect(lead).toMatchObject({ name: 'Dana Rivers', stageName: 'New', fields: { cdl_class: 'A' } })
    expect(lead.events).toMatchObject([{ type: 'created', payload: { via: 'intake' } }])
  })

  it('404s an unknown lead, and 400s a malformed id', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const missing = await testApp.app.request('/api/v1/leads/9999', { headers: { cookie } })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: 'not_found' })

    const malformed = await testApp.app.request('/api/v1/leads/abc', { headers: { cookie } })
    expect(malformed.status).toBe(400)
  })
})

describe('PATCH /api/v1/leads/:id', () => {
  it('updates contact fields and returns the post-mutation record', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(
      `/api/v1/leads/${id}`,
      jsonRequest('PATCH', { name: '  Dana R. Rivers  ', email: 'Dana.Rivers@Example.com' }, cookie),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lead: LeadResponse }
    expect(body.lead).toMatchObject({ name: 'Dana R. Rivers', email: 'dana.rivers@example.com' })
    expect(body.lead.events).toHaveLength(1)
  })

  it('leaves the intake payload alone', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', cdl_class: 'A' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(
      `/api/v1/leads/${id}`,
      jsonRequest('PATCH', { fields: { cdl_class: 'tampered' } }, cookie),
    )
    expect(res.status).toBe(200)
    expect((await detail(testApp, cookie, id)).fields).toEqual({ cdl_class: 'A' })
  })

  it('treats a patch that names no contact field as a no-op', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(`/api/v1/leads/${id}`, jsonRequest('PATCH', {}, cookie))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      lead: { name: 'Dana Rivers', email: 'dana@example.com' },
    })
  })

  it('clears a field with null', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', phone: '555-0100' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(`/api/v1/leads/${id}`, jsonRequest('PATCH', { email: null }, cookie))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ lead: { email: null, phone: '555-0100' } })
  })

  it('refuses an edit that would leave the lead uncontactable', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(`/api/v1/leads/${id}`, jsonRequest('PATCH', { email: null }, cookie))
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({ error: 'email_or_phone_required' })
    expect((await detail(testApp, cookie, id)).email).toBe('dana@example.com')
  })

  it('accepts swapping the only contact route in one patch', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(
      `/api/v1/leads/${id}`,
      jsonRequest('PATCH', { email: null, phone: '555-0100' }, cookie),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ lead: { email: null, phone: '555-0100' } })
  })

  it('rejects a non-string contact value', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const res = await testApp.app.request(
      `/api/v1/leads/${onlyLeadId(testApp)}`,
      jsonRequest('PATCH', { phone: { number: '555-0100' } }, cookie),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_contact' })
  })

  it('404s an unknown lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads/9999', jsonRequest('PATCH', { name: 'Nope' }, cookie))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/leads/:id/stage', () => {
  it('moves the lead and writes the event in the same transaction', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)
    const [newStage, contacted] = stageIds(testApp)

    const res = await testApp.app.request(
      `/api/v1/leads/${id}/stage`,
      jsonPost({ stageId: contacted }, { cookie }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lead: LeadResponse }
    expect(body.lead).toMatchObject({ stageId: contacted, stageName: 'Contacted' })
    expect(body.lead.events?.at(-1)).toMatchObject({
      type: 'stage_changed',
      actor: 'user:1',
      payload: { from: { id: newStage, name: 'New' }, to: { id: contacted, name: 'Contacted' } },
    })

    const stored = testApp.db.select().from(leadEvents).where(eq(leadEvents.leadId, id)).all()
    expect(stored.map((event) => event.type)).toEqual(['created', 'stage_changed'])
  })

  it('writes no event for a move to the stage the lead is already in', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)
    const [newStage] = stageIds(testApp)

    const res = await testApp.app.request(`/api/v1/leads/${id}/stage`, jsonPost({ stageId: newStage }, { cookie }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lead: LeadResponse }
    expect(body.lead.stageId).toBe(newStage)
    expect(body.lead.events).toHaveLength(1)
  })

  it('422s an unknown stage and leaves the lead where it was', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)
    const [newStage] = stageIds(testApp)

    const res = await testApp.app.request(`/api/v1/leads/${id}/stage`, jsonPost({ stageId: 9999 }, { cookie }))
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_stage' })
    expect((await detail(testApp, cookie, id)).stageId).toBe(newStage)
  })

  it.each([
    ['a missing stageId', {}],
    ['a string stageId', { stageId: 'contacted' }],
    ['a fractional stageId', { stageId: 1.5 }],
    ['a zero stageId', { stageId: 0 }],
  ])('422s %s', async (_label, body) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const res = await testApp.app.request(`/api/v1/leads/${onlyLeadId(testApp)}/stage`, jsonPost(body, { cookie }))
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_stage' })
  })

  it('404s an unknown lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [stage] = stageIds(testApp)
    const res = await testApp.app.request('/api/v1/leads/9999/stage', jsonPost({ stageId: stage }, { cookie }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/leads/:id/notes', () => {
  it('appends a note to the timeline and returns the post-mutation state', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = onlyLeadId(testApp)

    const res = await testApp.app.request(
      `/api/v1/leads/${id}/notes`,
      jsonPost({ note: '  Left a voicemail.  ' }, { cookie }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lead: LeadResponse }
    expect(body.lead.events?.at(-1)).toMatchObject({
      type: 'note_added',
      actor: 'user:1',
      payload: { note: 'Left a voicemail.' },
    })
  })

  it.each([
    ['a blank note', { note: '   ' }],
    ['a missing note', {}],
    ['a non-string note', { note: 42 }],
    ['an over-long note', { note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }],
  ])('400s %s', async (_label, body) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    const res = await testApp.app.request(`/api/v1/leads/${onlyLeadId(testApp)}/notes`, jsonPost(body, { cookie }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_note' })
  })

  it('404s an unknown lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads/9999/notes', jsonPost({ note: 'hi' }, { cookie }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/leads/:id/not-spam', () => {
  it('promotes the lead, records it, and fires the suppressed pipeline', async () => {
    const onLeadCreated = vi.fn<(lead: CreatedLead) => void>()
    const testApp = createTestApp({ onLeadCreated })
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', [HONEYPOT_FIELD]: 'x' })
    expect(onLeadCreated).not.toHaveBeenCalled()

    const id = onlyLeadId(testApp)
    const res = await testApp.app.request(`/api/v1/leads/${id}/not-spam`, jsonPost({}, { cookie }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lead: LeadResponse }
    expect(body.lead.isSpam).toBe(false)
    expect(body.lead.events?.at(-1)).toMatchObject({
      type: 'note_added',
      actor: 'user:1',
      payload: { note: NOT_SPAM_NOTE, system: true },
    })
    expect(onLeadCreated).toHaveBeenCalledTimes(1)
    expect(onLeadCreated.mock.calls[0]?.[0]).toMatchObject({ id, isSpam: false })
  })

  it('fires nothing on a second call, so a double click cannot double-send', async () => {
    const onLeadCreated = vi.fn<(lead: CreatedLead) => void>()
    const testApp = createTestApp({ onLeadCreated })
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', [HONEYPOT_FIELD]: 'x' })
    const id = onlyLeadId(testApp)

    await testApp.app.request(`/api/v1/leads/${id}/not-spam`, jsonPost({}, { cookie }))
    const second = await testApp.app.request(`/api/v1/leads/${id}/not-spam`, jsonPost({}, { cookie }))

    expect(second.status).toBe(200)
    expect(onLeadCreated).toHaveBeenCalledTimes(1)
    const events = testApp.db.select().from(leadEvents).where(eq(leadEvents.leadId, id)).all()
    expect(events.filter((event) => event.type === 'note_added')).toHaveLength(1)
  })

  it('survives a hook that throws — the lead is already promoted', async () => {
    const onLeadCreated = vi.fn(() => {
      throw new Error('smtp is down')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const testApp = createTestApp({ onLeadCreated })
    const cookie = await setupAdmin(testApp)
    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com', [HONEYPOT_FIELD]: 'x' })

    const res = await testApp.app.request(
      `/api/v1/leads/${onlyLeadId(testApp)}/not-spam`,
      jsonPost({}, { cookie }),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ lead: { isSpam: false } })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('404s an unknown lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads/9999/not-spam', jsonPost({}, { cookie }))
    expect(res.status).toBe(404)
  })
})
