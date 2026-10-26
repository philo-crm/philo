import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeFeed } from '../src/events/feed.ts'
import { signPayload, startWebhookDelivery } from '../src/webhooks/deliver.ts'
import { MAX_WEBHOOKS } from '../src/webhooks/service.ts'
import { cleanupTestApps, createTestApp, defaultFormKey, jsonPost, setupAdmin, type TestApp } from './support/app.ts'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const servers: Server[] = []

afterEach(async () => {
  cleanupTestApps()
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

interface Received {
  url: string
  headers: Headers
  body: string
}

/**
 * A real receiver on loopback, answering each request with the next status in
 * `statuses` (then the last). Every host name resolves to it — see `resolveHost`.
 */
async function receiver(statuses: number[] = [200]) {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
      received.push({ url: req.url ?? '', headers, body: Buffer.concat(chunks).toString() })
      res.statusCode = statuses[Math.min(received.length - 1, statuses.length - 1)]!
      res.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { port, received, at: (path = '/') => `http://hooks.example.com:${port}${path}` }
}

interface Harness {
  testApp: TestApp
  feed: ChangeFeed
  api: (path: string, init?: RequestInit) => Response | Promise<Response>
}

/** Every name is the loopback receiver, so no test touches real DNS — except the one that must be refused. */
const resolveHost = async (host: string) => (host === 'metadata.example.com' ? ['169.254.169.254'] : ['127.0.0.1'])

async function harness(retryDelaysMs: number[] = [1, 1]): Promise<Harness> {
  const feed = new ChangeFeed()
  const testApp = createTestApp({ changeFeed: feed, webhookTuning: { resolve: resolveHost } })
  startWebhookDelivery(testApp.db, feed, { resolve: resolveHost, retryDelaysMs })
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

  it('keeps an auth header, and lists it by name only', async () => {
    const h = await harness()
    const created = await register(h, {
      url: 'https://hooks.example.com/',
      authHeader: { name: 'Authorization', value: 'Bearer tok_listed-never' },
    })
    expect(created.status).toBe(201)
    expect(created.body.webhook).toMatchObject({ authHeaderName: 'Authorization' })
    expect(JSON.stringify(created.body)).not.toContain('tok_listed-never')

    const listed = await (await h.api('/webhooks')).text()
    expect(listed).toContain('"authHeaderName":"Authorization"')
    expect(listed).not.toContain('tok_listed-never')

    const plain = await register(h, { url: 'https://hooks.example.com/', authHeader: null })
    expect(plain.body.webhook).toMatchObject({ authHeaderName: null })
  })

  it.each([
    ['a reserved name', { name: 'Content-Type', value: 'text/plain' }],
    ['a name Philo signs with', { name: 'X-Philo-Signature', value: 'sha256=forged' }],
    ['a reserved name in lower case', { name: 'host', value: 'evil.example.com' }],
    ['a Philo name in lower case', { name: 'x-philo-event', value: 'lead.deleted' }],
    ['a name too long', { name: 'X-'.padEnd(101, 'a'), value: 'x' }],
    ['a name that is not a token', { name: 'Bad Header', value: 'x' }],
    ['an empty name', { name: '', value: 'x' }],
    ['an empty value', { name: 'Authorization', value: '   ' }],
    ['a value with a line break', { name: 'Authorization', value: 'Bearer a\r\nX-Injected: 1' }],
    ['a value past ASCII', { name: 'Authorization', value: 'Bearer café' }],
    ['a value too long', { name: 'Authorization', value: 'a'.repeat(4_001) }],
    ['a string', 'Bearer x'],
    ['a value that is not a string', { name: 'Authorization', value: 42 }],
  ])('refuses an auth header with %s', async (_, authHeader) => {
    const h = await harness()
    const created = await register(h, { url: 'https://hooks.example.com/', authHeader })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe('invalid_auth_header')
  })

  it('sets and clears the auth header, and nothing else', async () => {
    const h = await harness()
    const { body } = await register(h, { url: 'https://hooks.example.com/', events: ['lead.created'] })
    const patch = (payload: unknown) =>
      h.api(`/webhooks/${body.webhook.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

    const set = await patch({ authHeader: { name: 'X-Api-Key', value: 'key_1' }, url: 'https://other.example.com/' })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({
      webhook: { url: 'https://hooks.example.com/', events: ['lead.created'], authHeaderName: 'X-Api-Key' },
    })

    const cleared = await patch({ authHeader: null })
    expect(await cleared.json()).toMatchObject({ webhook: { authHeaderName: null } })

    expect((await patch({})).status).toBe(400)
    expect((await patch({ authHeader: { name: 'Host', value: 'x' } })).status).toBe(400)
    const missing = await h.api('/webhooks/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authHeader: null }),
    })
    expect(missing.status).toBe(404)
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
    const { received, at } = await receiver([503])
    const h = await harness()
    const { body } = await register(h, { url: at('/philo') })

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
    const { received, at } = await receiver()
    const h = await harness()
    const { body } = await register(h, { url: at('/philo') })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)

    expect(received).toHaveLength(1)
    const [request] = received
    expect(request!.url).toBe('/philo')
    expect(request!.headers.get('content-type')).toBe('application/json')
    expect(request!.headers.get('x-philo-event')).toBe('lead.created')
    const timestamp = request!.headers.get('x-philo-timestamp')!
    expect(request!.headers.get('x-philo-signature')).toBe(signPayload(body.secret, timestamp, request!.body))
    const payload = JSON.parse(request!.body) as { id: string; type: string; data: { lead: { email: string } } }
    expect(request!.headers.get('x-philo-delivery')).toBe(payload.id)
    expect(payload.data.lead.email).toBe('dana@example.com')
  })

  it('sends the auth header beside the signature, and stops once it is cleared', async () => {
    const { received, at } = await receiver()
    const h = await harness()
    const { body } = await register(h, {
      url: at(),
      events: ['lead.created'],
      authHeader: { name: 'Authorization', value: 'Bearer tok_123' },
    })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)
    const [request] = received
    expect(request!.headers.get('authorization')).toBe('Bearer tok_123')
    const timestamp = request!.headers.get('x-philo-timestamp')!
    expect(request!.headers.get('x-philo-signature')).toBe(signPayload(body.secret, timestamp, request!.body))

    await h.api(`/webhooks/${body.webhook.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authHeader: null }),
    })
    await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })
    expect(received).toHaveLength(2)
    expect(received[1]!.headers.get('authorization')).toBeNull()
    expect(received[1]!.headers.get('x-philo-signature')).not.toBeNull()
  })

  it('sends only the types asked for, and only for the funnel asked for', async () => {
    const { received, at } = await receiver()
    const h = await harness()
    const defaultForm = defaultFormKey(h.testApp)
    const created = await h.api('/funnels', jsonPost({ name: 'Sales' }))
    const { funnel } = (await created.json()) as { funnel: { id: number; forms: { formKey: string }[] } }
    await register(h, { url: at('/sales'), funnelId: funnel.id, events: ['lead.created'] })
    await register(h, { url: at('/deletes'), events: ['lead.deleted'] })

    await submit(h.testApp, 'default@example.com', defaultForm)
    await submit(h.testApp, 'sales@example.com', funnel.forms[0]!.formKey)
    await settle(() => received.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(received.map((request) => request.url)).toEqual(['/sales'])
    expect(received[0]!.body).toContain('sales@example.com')
  })

  it('retries a failure, then gives up', async () => {
    const { received, at } = await receiver([500])
    const h = await harness()
    await register(h, { url: at(), events: ['lead.created'] })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length >= 3)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(received).toHaveLength(3)
    expect(new Set(received.map((request) => request.headers.get('x-philo-delivery'))).size).toBe(1)
  })

  it('stops retrying once it gets through', async () => {
    const { received, at } = await receiver([500, 204])
    const h = await harness()
    await register(h, { url: at(), events: ['lead.created'] })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(received).toHaveLength(2)
    const listed = (await (await h.api('/webhooks')).json()) as { webhooks: { lastDelivery: unknown }[] }
    expect(listed.webhooks[0]!.lastDelivery).toMatchObject({ ok: true, status: 204, error: null })
  })

  it('does not resend a lead deleted while its retry waits', async () => {
    const { received, at } = await receiver([500, 204])
    const h = await harness([100])
    await register(h, { url: at(), events: ['lead.created'] })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)
    const { data } = JSON.parse(received[0]!.body) as { data: { lead: { id: number } } }
    expect((await h.api(`/leads/${data.lead.id}`, { method: 'DELETE' })).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(received).toHaveLength(1)
  })

  it('does not retry to a registration deleted in between', async () => {
    const { received, at } = await receiver([500, 204])
    const h = await harness([100])
    const { body } = await register(h, { url: at(), events: ['lead.created'] })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)
    expect((await h.api(`/webhooks/${body.webhook.id}`, { method: 'DELETE' })).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(received).toHaveLength(1)
  })

  it('retries with the lead as it now stands', async () => {
    const { received, at } = await receiver([500, 204])
    const h = await harness([100])
    await register(h, { url: at(), events: ['lead.created'] })

    await submit(h.testApp, 'dana@example.com')
    await settle(() => received.length > 0)
    const { data } = JSON.parse(received[0]!.body) as { data: { lead: { id: number } } }
    const patched = await h.api(`/leads/${data.lead.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dana@example.org' }),
    })
    expect(patched.status).toBe(200)
    await settle(() => received.length >= 2)

    expect(received).toHaveLength(2)
    expect(received[1]!.headers.get('x-philo-delivery')).toBe(received[0]!.headers.get('x-philo-delivery'))
    expect(received[1]!.body).toContain('dana@example.org')
  })

  it('does not follow a redirect', async () => {
    const { received, at } = await receiver([302])
    const h = await harness()
    const { body } = await register(h, { url: at() })

    const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })

    expect(await res.json()).toMatchObject({ delivery: { ok: false, status: 302 } })
    expect(received).toHaveLength(1)
  })

  it('records a receiver that cannot be reached', async () => {
    const h = await harness()
    const { body } = await register(h, { url: 'http://127.0.0.1:1/' })

    const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })

    const { delivery } = (await res.json()) as { delivery: { ok: boolean; status: number | null; error: string } }
    expect(delivery).toMatchObject({ ok: false, status: null })
    expect(delivery.error).toContain('ECONNREFUSED')
  })

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://0.0.0.0/',
    'https://metadata.example.com/',
  ])('refuses to post to %s', async (url) => {
    const h = await harness()
    const { body } = await register(h, { url })

    const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })

    expect(await res.json()).toMatchObject({ delivery: { ok: false, status: null, error: 'address not allowed' } })
  })

  it('posts to a receiver on loopback, by address or by a name that resolves there', async () => {
    const { received, port } = await receiver()
    const h = await harness()

    for (const url of [`http://127.0.0.1:${port}/hook`, `http://automation.internal:${port}/hook`]) {
      const { body } = await register(h, { url })
      const res = await h.api(`/webhooks/${body.webhook.id}/test`, { method: 'POST' })
      expect(await res.json()).toMatchObject({ delivery: { ok: true, status: 200 } })
    }
    expect(received).toHaveLength(2)
  })
})
