import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeFeed } from '../src/events/feed.ts'
import { signPayload, startWebhookDelivery } from '../src/webhooks/deliver.ts'
import { MAX_WEBHOOKS } from '../src/webhooks/service.ts'
import { cleanupTestApps, createTestApp, defaultFormKey, jsonPost, setupAdmin, type TestApp } from './support/app.ts'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface Received {
  url: string
  headers: Headers
  body: string
}

/** A fetch that records each request and answers with the next status in `statuses` (then the last). */
function receiver(statuses: number[] = [200]) {
  const received: Received[] = []
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    received.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) })
    const status = statuses[Math.min(received.length - 1, statuses.length - 1)]!
    return new Response(null, { status })
  }) as typeof fetch
  return { fake, received }
}

interface Harness {
  testApp: TestApp
  feed: ChangeFeed
  api: (path: string, init?: RequestInit) => Promise<Response>
}

async function harness(fake?: typeof fetch): Promise<Harness> {
  const feed = new ChangeFeed()
  const testApp = createTestApp({ changeFeed: feed, webhookTuning: { fetch: fake } })
  if (fake !== undefined) startWebhookDelivery(testApp.db, feed, { fetch: fake, retryDelaysMs: [1, 1] })
  const authorization = await setupAdmin(testApp)
  const api = (path: string, init: RequestInit = {}) =>
    testApp.app.request(`/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization },
    })
  return { testApp, feed, api }
}

async function register(h: Harness, body: Record<string, unknown>) {
  const res = await h.api('/webhooks', jsonPost(body))
  return { status: res.status, body: (await res.json()) as { webhook: { id: number }; secret: string; error?: string } }
}

async function submit(testApp: TestApp, email: string, formKey = defaultFormKey(testApp)) {
  const res = await testApp.app.request(`/api/intake/${formKey}`, jsonPost({ email }))
  if (res.status !== 201) throw new Error(`intake failed: ${res.status}`)
}

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('/api/v1/webhooks', () => {
  it('needs a credential', async () => {
    const h = await harness()
    expect((await h.testApp.app.request('/api/v1/webhooks')).status).toBe(401)
  })

  it('answers the secret once, and lists without it', async () => {
    const h = await harness()
    const created = await register(h, { url: 'https://hooks.example.com/philo', events: ['lead.created'] })
    expect(created.status).toBe(201)
    expect(created.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/)
    expect(created.body.webhook).toMatchObject({
      url: 'https://hooks.example.com/philo',
      funnelId: null,
      events: ['lead.created'],
      lastDelivery: null,
    })

    const listed = await (await h.api('/webhooks')).text()
    expect(listed).toContain('hooks.example.com')
    expect(listed).not.toContain(created.body.secret)
    expect(listed).not.toContain('secret')
  })

  it.each([
    ['not a url', 'invalid_url'],
    ['ftp://files.example.com/', 'invalid_url'],
    ['https://user:pass@hooks.example.com/', 'invalid_url'],
    [`https://hooks.example.com/${'a'.repeat(2_000)}`, 'invalid_url'],
  ])('refuses %s', async (url, error) => {
    const h = await harness()
    const created = await register(h, { url })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe(error)
  })

  it('refuses an unknown event type or funnel', async () => {
    const h = await harness()
    expect((await register(h, { url: 'https://hooks.example.com/', events: ['lead.exploded'] })).status).toBe(400)
    expect((await register(h, { url: 'https://hooks.example.com/', events: 'lead.created' })).status).toBe(400)
    expect((await register(h, { url: 'https://hooks.example.com/', funnelId: 999 })).status).toBe(422)
    expect((await register(h, { url: 'https://hooks.example.com/', funnelId: 'one' })).status).toBe(422)
  })

  it(`stops at ${MAX_WEBHOOKS}`, async () => {
    const h = await harness()
    for (let i = 0; i < MAX_WEBHOOKS; i += 1) await register(h, { url: `https://hooks.example.com/${i}` })
    expect((await register(h, { url: 'https://hooks.example.com/one-more' })).status).toBe(409)
  })

  it('deletes', async () => {
    const h = await harness()
    const { body } = await register(h, { url: 'https://hooks.example.com/' })
    expect((await h.api(`/webhooks/${body.webhook.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await h.api(`/webhooks/${body.webhook.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('goes with its funnel', async () => {
    const h = await harness()
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number } }
    await register(h, { url: 'https://hooks.example.com/', funnelId: funnel.id })

    expect((await h.api(`/funnels/${funnel.id}`, { method: 'DELETE' })).status).toBe(200)

    const listed = (await (await h.api('/webhooks')).json()) as { webhooks: unknown[] }
    expect(listed.webhooks).toEqual([])
  })

  it('sends a signed ping on test, and keeps the outcome', async () => {
    const { fake, received } = receiver([503])
    const h = await harness(fake)
    const { body } = await register(h, { url: 'https://hooks.example.com/philo' })

    const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ delivery: { ok: false, status: 503, error: 'HTTP 503' } })

    expect(received).toHaveLength(1)
    expect(received[0]!.headers.get('x-philo-event')).toBe('ping')
    const listed = (await (await h.api('/webhooks')).json()) as { webhooks: { lastDelivery: unknown }[] }
    expect(listed.webhooks[0]!.lastDelivery).toMatchObject({ ok: false, status: 503 })
  })
})

describe('delivery', () => {
  it('posts each change, signed with the secret', async () => {
    const { fake, received } = receiver()
    const h = await harness(fake)
    const { body } = await register(h, { url: 'https://hooks.example.com/philo' })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)

    expect(received).toHaveLength(1)
    const [request] = received
    expect(request!.url).toBe('https://hooks.example.com/philo')
    expect(request!.headers.get('content-type')).toBe('application/json')
    expect(request!.headers.get('x-philo-event')).toBe('lead.created')
    const timestamp = request!.headers.get('x-philo-timestamp')!
    expect(request!.headers.get('x-philo-signature')).toBe(signPayload(body.secret, timestamp, request!.body))
    const payload = JSON.parse(request!.body) as { id: string; type: string; data: { lead: { email: string } } }
    expect(request!.headers.get('x-philo-delivery')).toBe(payload.id)
    expect(payload.data.lead.email).toBe('dana@example.com')
  })

  it('sends only the types asked for, and only for the funnel asked for', async () => {
    const { fake, received } = receiver()
    const h = await harness(fake)
    const defaultForm = defaultFormKey(h.testApp)
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number; forms: { formKey: string }[] } }
    await register(h, { url: 'https://hooks.example.com/sales', funnelId: funnel.id })
    await register(h, { url: 'https://hooks.example.com/deletes', events: ['lead.deleted'] })

    await submit(h.testApp, 'default@example.com', defaultForm)
    await submit(h.testApp, 'sales@example.com', funnel.forms[0]!.formKey)
    await settle(() => received.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received.map((request) => request.url)).toEqual(['https://hooks.example.com/sales'])
    expect(received[0]!.body).toContain('sales@example.com')
  })

  it('retries a failure, then gives up', async () => {
    const { fake, received } = receiver([500])
    const h = await harness(fake)
    await register(h, { url: 'https://hooks.example.com/' })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length >= 3)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toHaveLength(3)
    expect(new Set(received.map((request) => request.headers.get('x-philo-delivery'))).size).toBe(1)
  })

  it('stops retrying once it gets through', async () => {
    const { fake, received } = receiver([500, 204])
    const h = await harness(fake)
    await register(h, { url: 'https://hooks.example.com/' })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toHaveLength(2)
    const listed = (await (await h.api('/webhooks')).json()) as { webhooks: { lastDelivery: unknown }[] }
    expect(listed.webhooks[0]!.lastDelivery).toMatchObject({ ok: true, status: 204, error: null })
  })

  it('records a receiver that cannot be reached', async () => {
    const fake = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const h = await harness(fake)
    const { body } = await register(h, { url: 'https://hooks.example.com/' })

    const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })

    expect(await res.json()).toMatchObject({ delivery: { ok: false, status: null, error: 'fetch failed' } })
  })
})
