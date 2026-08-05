import { desc } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPushError } from 'web-push'
import { leads, pushSubscriptions } from '../src/db/schema.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import { createLeadPushHook, sendNewLeadPush, type SendPush } from '../src/push/service.ts'
import { listSubscriptions } from '../src/push/subscriptions.ts'
import {
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

const PUSH_BASE = '/api/v1/push'

const ENDPOINT = 'https://push.example.com/subscription/abc123'
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: 'BNc-public-key', auth: 'auth-secret' } }

function authed(cookie: string, body: unknown, method: 'POST' | 'DELETE' = 'POST'): RequestInit {
  return { ...jsonPost(body), method, headers: { ...jsonPost(body).headers, cookie } }
}

/** A sender that records instead of reaching a push service. */
function recordingPush(failWith?: (endpoint: string) => unknown) {
  const sent: { endpoint: string; payload: unknown }[] = []
  const send: SendPush = async (subscription, payload) => {
    const failure = failWith?.(subscription.endpoint)
    if (failure !== undefined) throw failure
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as unknown })
  }
  return { sent, send }
}

/** The production wiring, with the push service swapped for a recorder. */
function deps(testApp: TestApp, send: SendPush) {
  return {
    db: testApp.db,
    publicBaseUrl: TEST_PUBLIC_BASE_URL,
    vapidKeys: { publicKey: testApp.vapidPublicKey, privateKey: 'private' },
    send,
  }
}

function storeSubscription(testApp: TestApp, userId: number, endpoint: string): void {
  testApp.db
    .insert(pushSubscriptions)
    .values({ userId, endpoint, p256dh: 'BNc-public-key', auth: 'auth-secret' })
    .run()
}

/**
 * A lead in the pipeline. Intake is the only way one is created — there is no
 * REST create — and it answers `{ ok: true }`, so the id comes from the row.
 */
async function submitLead(testApp: TestApp, body: Record<string, unknown>): Promise<number> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, jsonPost(body))
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${await res.text()}`)
  const [row] = testApp.db
    .select({ id: leads.id })
    .from(leads)
    .orderBy(desc(leads.id))
    .limit(1)
    .all()
  if (row === undefined) throw new Error('intake created no lead')
  return row.id
}

describe('GET /api/v1/push/key', () => {
  it('hands back the generated VAPID public key', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(PUSH_BASE + '/key', { headers: { cookie } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: testApp.vapidPublicKey })
  })

  it('is behind the session like everything else under the API prefix', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const res = await testApp.app.request(PUSH_BASE + '/key')

    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/push/subscriptions', () => {
  it('stores the subscription against the signed-in user', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, SUBSCRIPTION))

    expect(res.status).toBe(201)
    expect(listSubscriptions(testApp.db)).toEqual([
      { id: expect.any(Number), endpoint: ENDPOINT, p256dh: 'BNc-public-key', auth: 'auth-secret' },
    ])
  })

  // A browser hands back the same endpoint when permission is re-granted, with
  // rotated keys. A second row would push the same lead to one device twice.
  it('replaces the keys on a re-subscribe rather than storing a second row', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, SUBSCRIPTION))

    const rotated = { endpoint: ENDPOINT, keys: { p256dh: 'BNc-rotated', auth: 'auth-rotated' } }
    const res = await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, rotated))

    expect(res.status).toBe(201)
    expect(listSubscriptions(testApp.db)).toEqual([
      { id: expect.any(Number), endpoint: ENDPOINT, p256dh: 'BNc-rotated', auth: 'auth-rotated' },
    ])
  })

  it('refuses a subscription it could never send to', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      PUSH_BASE + '/subscriptions',
      authed(cookie, { endpoint: 'http://push.example.com/abc', keys: SUBSCRIPTION.keys }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_subscription' })
    expect(listSubscriptions(testApp.db)).toEqual([])
  })

  it('needs a session', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const res = await testApp.app.request(PUSH_BASE + '/subscriptions', jsonPost(SUBSCRIPTION))

    expect(res.status).toBe(401)
    expect(listSubscriptions(testApp.db)).toEqual([])
  })
})

describe('DELETE /api/v1/push/subscriptions', () => {
  it('forgets the endpoint', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, SUBSCRIPTION))

    const res = await testApp.app.request(
      PUSH_BASE + '/subscriptions',
      authed(cookie, { endpoint: ENDPOINT }, 'DELETE'),
    )

    expect(res.status).toBe(200)
    expect(listSubscriptions(testApp.db)).toEqual([])
  })

  // A browser that dropped its subscription while the app was closed is
  // reporting the truth, not making a mistake.
  it('is idempotent for an endpoint that was never stored', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      PUSH_BASE + '/subscriptions',
      authed(cookie, { endpoint: ENDPOINT }, 'DELETE'),
    )

    expect(res.status).toBe(200)
  })

  it('refuses a body with no endpoint in it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, {}, 'DELETE'))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_subscription' })
  })
})

describe('sendNewLeadPush', () => {
  async function seeded(): Promise<{ testApp: TestApp; leadId: number }> {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    return { testApp, leadId }
  }

  it('sends the declarative payload to every subscribed browser', async () => {
    const { testApp, leadId } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    storeSubscription(testApp, 1, 'https://push.example.com/subscription/second')
    const push = recordingPush()

    await sendNewLeadPush(deps(testApp, push.send), leadId)

    expect(push.sent).toHaveLength(2)
    expect(push.sent[0]?.payload).toEqual({
      web_push: 8030,
      notification: {
        title: 'New lead: Dana Rivers',
        // Intake stamps the form name as the source — see intake/routes.ts.
        body: 'dana@example.com · Default',
        navigate: `${TEST_PUBLIC_BASE_URL}/leads/${leadId}`,
        tag: `philo-lead-${leadId}`,
      },
    })
  })

  it('does nothing when nobody has subscribed', async () => {
    const { testApp, leadId } = await seeded()
    const push = recordingPush()

    await sendNewLeadPush(deps(testApp, push.send), leadId)

    expect(push.sent).toEqual([])
  })

  it.each([404, 410])('prunes a subscription the push service answers %d for', async (status) => {
    const { testApp, leadId } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    const live = 'https://push.example.com/subscription/live'
    storeSubscription(testApp, 1, live)
    const push = recordingPush((endpoint) =>
      endpoint === ENDPOINT ? new WebPushError('gone', status, {}, '', endpoint) : undefined,
    )

    await sendNewLeadPush(deps(testApp, push.send), leadId)

    // The dead row is gone, and the healthy one still got its notification.
    expect(listSubscriptions(testApp.db).map((row) => row.endpoint)).toEqual([live])
    expect(push.sent.map((entry) => entry.endpoint)).toEqual([live])
  })

  // A 429 or a 500 is the push service having a bad moment, not a subscription
  // that has gone away — dropping the row would lose a working device.
  it.each([429, 500, 503])('keeps a subscription after a %d', async (status) => {
    const { testApp, leadId } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    const push = recordingPush(() => new WebPushError('busy', status, {}, '', ENDPOINT))

    await sendNewLeadPush(deps(testApp, push.send), leadId)

    expect(listSubscriptions(testApp.db).map((row) => row.endpoint)).toEqual([ENDPOINT])
  })

  it('keeps a subscription after a network failure with no status at all', async () => {
    const { testApp, leadId } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    const push = recordingPush(() => new Error('socket hang up'))

    await sendNewLeadPush(deps(testApp, push.send), leadId)

    expect(listSubscriptions(testApp.db).map((row) => row.endpoint)).toEqual([ENDPOINT])
  })

  it('never rejects, so a failing push cannot reach the caller', async () => {
    const { testApp, leadId } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    const push = recordingPush(() => new Error('boom'))

    await expect(sendNewLeadPush(deps(testApp, push.send), leadId)).resolves.toBeUndefined()
  })

  it('says nothing about a lead that no longer exists', async () => {
    const { testApp } = await seeded()
    storeSubscription(testApp, 1, ENDPOINT)
    const push = recordingPush()

    await sendNewLeadPush(deps(testApp, push.send), 9_999)

    expect(push.sent).toEqual([])
  })
})

describe('the lead pipeline', () => {
  it('pushes a lead submitted through an intake form', async () => {
    const push = recordingPush()
    let testApp: TestApp
    // The hook needs the app's own db, which only exists once the app is built.
    const hook = (lead: { id: number }) => {
      void sendNewLeadPush(deps(testApp, push.send), lead.id)
    }
    testApp = createTestApp({ onLeadCreated: hook })
    const cookie = await setupAdmin(testApp)
    await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, SUBSCRIPTION))

    const res = await testApp.app.request(
      `/api/intake/${defaultFormKey(testApp)}`,
      jsonPost({ name: 'Dana Rivers', email: 'dana@example.com' }),
    )
    expect(res.status).toBe(201)
    await vi.waitFor(() => expect(push.sent).toHaveLength(1))

    expect(push.sent[0]?.payload).toMatchObject({
      notification: { title: 'New lead: Dana Rivers' },
    })
  })

  // DESIGN.md (Intake endpoint): a quarantined lead sends no notification at all.
  it('pushes nothing for a lead filed as spam', async () => {
    const push = recordingPush()
    const seen: number[] = []
    const testApp = createTestApp({ onLeadCreated: (lead) => seen.push(lead.id) })
    const cookie = await setupAdmin(testApp)
    await testApp.app.request(PUSH_BASE + '/subscriptions', authed(cookie, SUBSCRIPTION))

    const res = await testApp.app.request(
      `/api/intake/${defaultFormKey(testApp)}`,
      // The honeypot is what files a submission as spam — see intake/payload.ts.
      jsonPost({ name: 'Bot', email: 'bot@example.com', [HONEYPOT_FIELD]: 'gotcha' }),
    )

    expect(res.status).toBe(201)
    // The hook is never fired, which is what withholds the push.
    expect(seen).toEqual([])
    expect(push.sent).toEqual([])
  })

  it('refuses to push a lead still sitting in quarantine, whatever fires the hook', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    storeSubscription(testApp, 1, ENDPOINT)
    const leadId = await submitLead(testApp, {
      name: 'Bot',
      email: 'bot@example.com',
      [HONEYPOT_FIELD]: 'gotcha',
    })
    const push = recordingPush()

    // Fired by hand: the guard has to hold even if a caller gets this wrong.
    await sendNewLeadPush(deps(testApp, push.send), leadId)

    expect(push.sent).toEqual([])
  })
})

describe('createLeadPushHook', () => {
  it('sends without the caller waiting on it', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const leadId = await submitLead(testApp, { name: 'Dana', email: 'dana@example.com' })
    storeSubscription(testApp, 1, ENDPOINT)
    const push = recordingPush()

    const hook = createLeadPushHook(deps(testApp, push.send))
    expect(hook({ id: leadId, formId: null, isSpam: false })).toBeUndefined()

    await vi.waitFor(() => expect(push.sent).toHaveLength(1))
  })
})
