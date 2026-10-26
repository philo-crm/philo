import { desc, eq } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_FILENAME } from '../src/db/index.ts'
import { leadAttachmentBlobs, leadAttachments, leadEvents, leads, pushSubscriptions } from '../src/db/schema.ts'
import { sendNewLeadEmails, type EmailDeps } from '../src/email/service.ts'
import type { OutgoingEmail } from '../src/email/transport.ts'
import { createLiveLeadHook, LiveFeed } from '../src/push/live.ts'
import { sendNewLeadPush, type SendPush } from '../src/push/service.ts'
import {
  agentAuth,
  cleanupTestApps,
  configureEmail,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  TEST_APP_URL,
  type TestApp,
} from './support/app.ts'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

async function submit(testApp: TestApp, body: Record<string, unknown>): Promise<number> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, jsonPost(body))
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${await res.text()}`)
  return latestLeadId(testApp)
}

function latestLeadId(testApp: TestApp): number {
  const [row] = testApp.db.select({ id: leads.id }).from(leads).orderBy(desc(leads.id)).limit(1).all()
  if (row === undefined) throw new Error('no lead')
  return row.id
}

function remove(testApp: TestApp, authorization: string | undefined, id: number | string) {
  return testApp.app.request(`/api/v1/leads/${id}`, {
    method: 'DELETE',
    headers: authorization === undefined ? {} : { authorization },
  })
}

function count(testApp: TestApp, sql: string, id: number): number {
  return testApp.db.$client.prepare<[number], { c: number }>(sql).get(id)?.c ?? -1
}

/** A lead with something in every place one can hold data. */
async function fullLead(testApp: TestApp, authorization: string): Promise<number> {
  const id = await submit(testApp, {
    name: 'Quillon Marrowby',
    email: 'quillon@example.com',
    answer: 'zephyrcanticle',
  })
  const send = (path: string, init: RequestInit) =>
    testApp.app.request(`/api/v1/leads/${id}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization },
    })
  const patched = await send('', { ...jsonPost({ details: { licence: 'velvetquasar' } }), method: 'PATCH' })
  const noted = await send('/notes', jsonPost({ note: 'Spoke to them about ochrelantern.' }))
  if (patched.status !== 200 || noted.status !== 200) throw new Error('could not fill in the lead')
  const res = await send(`/attachments?filename=${encodeURIComponent('marrowby-licence.pdf')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: new TextEncoder().encode('BLOBMARKER'.repeat(2_000)),
  })
  if (res.status !== 201) throw new Error(`upload failed: ${res.status}`)
  return id
}

const MARKERS = ['marrowby', 'quillon', 'zephyrcanticle', 'velvetquasar', 'ochrelantern', 'blobmarker']

/** Which markers can still be read out of the database file and its WAL, in any case. */
function readableMarkers(testApp: TestApp): string[] {
  const file = join(testApp.dataDir, DB_FILENAME)
  const bytes = [file, `${file}-wal`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1').toLowerCase())
    .join('')
  return MARKERS.filter((marker) => bytes.includes(marker))
}

describe('DELETE /api/v1/leads/:id', () => {
  it('removes the lead, its timeline, attachments and search row in one call', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const id = await fullLead(testApp, authorization)
    const [attachment] = testApp.db.select({ id: leadAttachments.id }).from(leadAttachments).all()
    expect(count(testApp, 'SELECT count(*) AS c FROM lead_events WHERE lead_id = ?', id)).toBeGreaterThan(0)

    const res = await remove(testApp, authorization, id)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(count(testApp, 'SELECT count(*) AS c FROM leads WHERE id = ?', id)).toBe(0)
    expect(count(testApp, 'SELECT count(*) AS c FROM lead_events WHERE lead_id = ?', id)).toBe(0)
    expect(count(testApp, 'SELECT count(*) AS c FROM lead_attachments WHERE lead_id = ?', id)).toBe(0)
    expect(testApp.db.select().from(leadAttachmentBlobs).where(eq(leadAttachmentBlobs.attachmentId, attachment!.id)).all()).toEqual([])
    expect(count(testApp, 'SELECT count(*) AS c FROM leads_fts WHERE rowid = ?', id)).toBe(0)
    expect(
      testApp.db.$client.prepare("SELECT count(*) AS c FROM leads_fts WHERE leads_fts MATCH 'marrowby'").get(),
    ).toEqual({ c: 0 })
    expect((await testApp.app.request(`/api/v1/leads/${id}`, { headers: { authorization } })).status).toBe(404)
  })

  it('leaves nothing about the person anywhere in the database, timeline included', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const other = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = await fullLead(testApp, authorization)

    await remove(testApp, authorization, id)

    const remaining = testApp.db.select({ payload: leadEvents.payload, leadId: leadEvents.leadId }).from(leadEvents).all()
    expect(remaining.every((event) => event.leadId === other)).toBe(true)
    const dump = JSON.stringify(
      testApp.db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap((table) => {
        const name = (table as { name: string }).name
        return testApp.db.$client.prepare(`SELECT * FROM "${name}"`).all()
      }),
    ).toLowerCase()
    for (const marker of MARKERS) expect(dump).not.toContain(marker)
  })

  // The issue's bar: deleted is not recoverable from the file, not merely unlisted.
  it('leaves no deleted value readable in the database file or its WAL', async () => {
    const testApp = createTestApp({ intakeTuning: { rateLimit: { capacity: 100 } } })
    const authorization = await setupAdmin(testApp)
    // Leads either side, so the deleted rows sit on pages that stay in use.
    for (let i = 0; i < 20; i += 1) await submit(testApp, { name: `Before ${i}`, email: `b${i}@example.com` })
    const id = await fullLead(testApp, authorization)
    for (let i = 0; i < 20; i += 1) await submit(testApp, { name: `After ${i}`, email: `a${i}@example.com` })
    expect(readableMarkers(testApp)).toEqual(MARKERS)

    expect((await remove(testApp, authorization, id)).status).toBe(204)

    expect(readableMarkers(testApp)).toEqual([])
  })

  it('answers 404 for an unknown lead, and for one already deleted', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    expect((await remove(testApp, authorization, 9_999)).status).toBe(404)
    expect((await remove(testApp, authorization, id)).status).toBe(204)
    expect((await remove(testApp, authorization, id)).status).toBe(404)
  })

  it('refuses an id that is not one', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    expect((await remove(testApp, authorization, 'abc')).status).toBe(400)
  })

  it('requires a credential', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    expect((await remove(testApp, undefined, id)).status).toBe(401)
    expect(count(testApp, 'SELECT count(*) AS c FROM leads WHERE id = ?', id)).toBe(1)
  })

  // ADR-0007: an agent acts as its user, with the same authority.
  it('is open to an agent credential', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const { authorization } = await agentAuth(testApp, 1)
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    expect((await remove(testApp, authorization, id)).status).toBe(204)
  })

  it('keeps other leads intact', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const keep = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const id = await submit(testApp, { name: 'Sam Ortiz', email: 'sam@example.com' })

    await remove(testApp, authorization, id)

    const res = await testApp.app.request(`/api/v1/leads/${keep}`, { headers: { authorization } })
    expect(res.status).toBe(200)
    expect(count(testApp, 'SELECT count(*) AS c FROM leads_fts WHERE rowid = ?', keep)).toBe(1)
  })
})

describe('after a lead is deleted', () => {
  it('the email retry gives up on it quietly instead of sending or retrying', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    configureEmail(testApp)
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    let attempts = 0
    const queued: (() => void)[] = []
    const deps: EmailDeps = {
      db: testApp.db,
      appUrl: TEST_APP_URL,
      createSender: () => () => {
        attempts += 1
        return Promise.reject(new Error('greylisted'))
      },
      retry: { maxAttempts: 5, jitterRatio: 0 },
      scheduleRetry: (run) => queued.push(run),
    }

    await sendNewLeadEmails(deps, id)
    expect(queued).toHaveLength(1)
    const firstPass = attempts
    await remove(testApp, authorization, id)

    await expect(sendNewLeadEmails(deps, id, 2)).resolves.toBeUndefined()
    expect(attempts).toBe(firstPass)
    expect(queued).toHaveLength(1)
  })

  it('a send that was already under way when it went does not throw recording the outcome', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    configureEmail(testApp)
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const sent: OutgoingEmail[] = []
    const deps: EmailDeps = {
      db: testApp.db,
      appUrl: TEST_APP_URL,
      createSender: () => async (email) => {
        if (sent.length === 0) await remove(testApp, authorization, id)
        sent.push(email)
        return { accepted: email.to }
      },
      retry: { maxAttempts: 1, jitterRatio: 0 },
    }

    await expect(sendNewLeadEmails(deps, id)).resolves.toBeUndefined()
    expect(count(testApp, 'SELECT count(*) AS c FROM lead_events WHERE lead_id = ?', id)).toBe(0)
  })

  it('push sends nothing for it', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    testApp.db
      .insert(pushSubscriptions)
      .values({ userId: 1, endpoint: 'https://push.example.com/a', p256dh: 'BNc-public-key', auth: 'auth-secret' })
      .run()
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const sent: string[] = []
    const send: SendPush = async (_subscription, payload) => {
      sent.push(payload)
    }
    await remove(testApp, authorization, id)

    await expect(
      sendNewLeadPush(
        { db: testApp.db, appUrl: TEST_APP_URL, vapidKeys: { publicKey: testApp.vapidPublicKey, privateKey: 'p' }, send },
        id,
      ),
    ).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('the live feed publishes nothing for it', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const feed = new LiveFeed()
    const published: unknown[] = []
    feed.listen((notification) => published.push(notification))
    const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    await remove(testApp, authorization, id)

    expect(() =>
      createLiveLeadHook({ db: testApp.db, appUrl: TEST_APP_URL, feed })({ id, formId: null, isSpam: false }),
    ).not.toThrow()
    expect(published).toEqual([])
  })

  // The person is applying again; the dedupe window must not swallow them.
  it('intake files the same submission again inside the dedupe window', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const body = { name: 'Dana Rivers', email: 'dana@example.com' }
    const first = await submit(testApp, body)
    await submit(testApp, body)
    expect(latestLeadId(testApp)).toBe(first)

    await remove(testApp, authorization, first)
    const second = await submit(testApp, body)

    expect(second).not.toBe(first)
    expect(count(testApp, 'SELECT count(*) AS c FROM leads WHERE id = ?', second)).toBe(1)
  })
})
