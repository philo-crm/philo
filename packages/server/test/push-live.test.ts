import { desc } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { leads } from '../src/db/schema.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import type { CreatedLead } from '../src/notify.ts'
import { createLiveLeadHook, LiveFeed, type LiveTuning } from '../src/push/live.ts'
import {
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  TEST_APP_URL,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

const LIVE = '/api/v1/push/live'

/** The production wiring: the stream hears what the lead-created hook publishes. */
async function liveApp(tuning?: LiveTuning): Promise<{ testApp: TestApp; feed: LiveFeed; authorization: string }> {
  const feed = new LiveFeed()
  let testApp: TestApp | undefined
  // The hook needs the app's own db, which only exists once the app is built.
  const onLeadCreated = (lead: CreatedLead) => {
    if (testApp !== undefined) createLiveLeadHook({ db: testApp.db, appUrl: TEST_APP_URL, feed })(lead)
  }
  testApp = createTestApp({ onLeadCreated, liveFeed: feed, liveTuning: tuning })
  const authorization = await setupAdmin(testApp)
  return { testApp, feed, authorization }
}

async function submit(testApp: TestApp, body: Record<string, unknown>): Promise<void> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, jsonPost(body))
  if (res.status !== 201) throw new Error(`intake failed: ${res.status}`)
}

function latestLeadId(testApp: TestApp): number {
  const [row] = testApp.db.select({ id: leads.id }).from(leads).orderBy(desc(leads.id)).limit(1).all()
  if (row === undefined) throw new Error('no lead')
  return row.id
}

/** Reads the stream until `predicate` holds over everything received so far. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!predicate(text)) {
    const { value, done } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe('GET /api/v1/push/live', () => {
  it('needs a session', async () => {
    const { testApp } = await liveApp()

    const res = await testApp.app.request(LIVE)

    expect(res.status).toBe(401)
  })

  it('is an uncached event stream', async () => {
    const { testApp, authorization } = await liveApp()

    const res = await testApp.app.request(LIVE, { headers: { authorization } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    await res.body?.cancel()
  })

  it('carries the same notification a push would for a lead submitted through a form', async () => {
    const { testApp, authorization } = await liveApp()
    const res = await testApp.app.request(LIVE, { headers: { authorization } })
    const reader = res.body!.getReader()
    await readUntil(reader, (text) => text.includes(': connected'))

    await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const leadId = latestLeadId(testApp)
    const text = await readUntil(reader, (received) => received.includes('event: lead'))

    const data = /event: lead\ndata: (.+)\n\n/.exec(text)?.[1]
    expect(JSON.parse(data ?? 'null')).toEqual({
      title: 'New lead: Dana Rivers',
      body: 'dana@example.com · Default',
      navigate: `${TEST_APP_URL}/leads/${leadId}`,
      tag: `philo-lead-${leadId}`,
    })
    await reader.cancel()
  })

  // DESIGN.md (Intake endpoint): a quarantined lead sends no notification at all.
  it('says nothing about a lead filed as spam', async () => {
    const { testApp, feed } = await liveApp()
    const published: unknown[] = []
    feed.listen((notification) => published.push(notification))

    await submit(testApp, { name: 'Bot', email: 'bot@example.com', [HONEYPOT_FIELD]: 'gotcha' })
    // Fired by hand as well: the guard has to hold even if a caller gets it wrong.
    createLiveLeadHook({ db: testApp.db, appUrl: TEST_APP_URL, feed })({
      id: latestLeadId(testApp),
      formId: null,
      isSpam: false,
    })

    expect(published).toEqual([])
  })

  it('stops listening when the client goes away', async () => {
    const { testApp, feed, authorization } = await liveApp()
    const res = await testApp.app.request(LIVE, { headers: { authorization } })
    const reader = res.body!.getReader()
    await readUntil(reader, (text) => text.includes(': connected'))
    expect(feed.listenerCount).toBe(1)

    await reader.cancel()

    expect(feed.listenerCount).toBe(0)
  })

  it('keeps the connection warm, then ends it so the client reconnects with a fresh credential', async () => {
    const { testApp, feed, authorization } = await liveApp({ heartbeatMs: 5, maxDurationMs: 40 })
    const res = await testApp.app.request(LIVE, { headers: { authorization } })

    const text = await readUntil(res.body!.getReader(), () => false)

    expect(text).toContain(': keep-alive')
    expect(feed.listenerCount).toBe(0)
  })
})
