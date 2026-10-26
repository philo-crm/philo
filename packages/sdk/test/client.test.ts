import { describe, expect, it, vi } from 'vitest'
import { ApiError, PhiloClient, isUnauthorized } from '../src/index.ts'

interface Call {
  url: string
  init: RequestInit | undefined
}

function recorder(response: () => Response) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return response()
  })
  return { calls, fetch }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function header(call: Call | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name]
}

describe('PhiloClient', () => {
  it('sends the bearer token and joins the base url without doubling slashes', async () => {
    const { calls, fetch } = recorder(() => json({ stages: [] }))
    const client = new PhiloClient({ baseUrl: 'https://philo.example.com/', fetch, accessToken: () => 'tok' })
    await client.stages.list()
    expect(calls[0]?.url).toBe('https://philo.example.com/api/v1/stages')
    expect(header(calls[0], 'authorization')).toBe('Bearer tok')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it('omits the authorization header when there is no token', async () => {
    const { calls, fetch } = recorder(() => json({ stages: [] }))
    await new PhiloClient({ fetch, accessToken: async () => undefined }).stages.list()
    expect(header(calls[0], 'authorization')).toBeUndefined()
    expect(calls[0]?.url).toBe('/api/v1/stages')
  })

  it('sends JSON on every state change', async () => {
    const { calls, fetch } = recorder(() => json({ lead: { id: 3 } }))
    const lead = await new PhiloClient({ fetch }).leads.moveStage(3, 7)
    expect(lead).toEqual({ id: 3 })
    expect(calls[0]?.url).toBe('/api/v1/leads/3/stage')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(header(calls[0], 'content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ stageId: 7 })
  })

  it('uploads an attachment as the raw body, typed and named', async () => {
    const { calls, fetch } = recorder(() => json({ lead: { id: 3 } }, 201))
    const data = new Uint8Array([1, 2, 3])
    const lead = await new PhiloClient({ fetch }).leads.attachments.upload(3, { data, filename: 'my résumé.pdf' })
    expect(lead).toEqual({ id: 3 })
    expect(calls[0]?.url).toBe('/api/v1/leads/3/attachments?filename=my%20r%C3%A9sum%C3%A9.pdf')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(header(calls[0], 'content-type')).toBe('application/octet-stream')
    expect(calls[0]?.init?.body).toBe(data)
  })

  it('takes a Blob’s own type when none is given', async () => {
    const { calls, fetch } = recorder(() => json({ lead: { id: 3 } }, 201))
    const data = new Blob(['x'], { type: 'image/png' })
    await new PhiloClient({ fetch }).leads.attachments.upload(3, { data, filename: 'a.png' })
    expect(header(calls[0], 'content-type')).toBe('image/png')
  })

  it('downloads an attachment as a Blob, and throws the API error on a miss', async () => {
    const { fetch } = recorder(() => new Response('bytes', { headers: { 'content-type': 'text/plain' } }))
    const blob = await new PhiloClient({ fetch }).leads.attachments.download(3, 9)
    await expect(blob.text()).resolves.toBe('bytes')

    const missing = recorder(() => json({ error: 'attachment_not_found' }, 404))
    await expect(new PhiloClient({ fetch: missing.fetch }).leads.attachments.download(3, 9)).rejects.toMatchObject({
      status: 404,
      code: 'attachment_not_found',
    })
  })

  it('builds the lead query from only the filters that were given', async () => {
    const { calls, fetch } = recorder(() => json({ leads: [], total: 0, limit: 5, offset: 0 }))
    const client = new PhiloClient({ fetch })
    await client.leads.list({ isSpam: false, stageId: 2, search: '  ', limit: 5, createdAfter: new Date(0) })
    await client.leads.list()
    expect(calls[0]?.url).toBe(
      '/api/v1/leads?spam=false&stage=2&createdAfter=1970-01-01T00%3A00%3A00.000Z&limit=5',
    )
    expect(calls[1]?.url).toBe('/api/v1/leads')
  })

  it('throws ApiError with the code, detail and retry hint the server sent', async () => {
    const { fetch } = recorder(() => json({ error: 'send_failed', detail: '535 nope', retryAfterSeconds: 4 }, 502))
    const failure = await new PhiloClient({ fetch }).emailSettings.sendTest('a@example.com').catch((e) => e)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 502, code: 'send_failed', detail: '535 nope', retryAfterSeconds: 4 })
  })

  it('leaves the code empty for a non-JSON error body', async () => {
    const { fetch } = recorder(() => new Response('<html>bad gateway</html>', { status: 401 }))
    const failure = await new PhiloClient({ fetch }).auth.session().catch((e) => e)
    expect(failure).toMatchObject({ status: 401, code: '' })
    expect(isUnauthorized(failure)).toBe(true)
  })

  it('treats 204 as an empty success', async () => {
    const { fetch } = recorder(() => new Response(null, { status: 204 }))
    await expect(new PhiloClient({ fetch }).apiKeys.revoke(1)).resolves.toBeUndefined()
  })

  it('encodes template triggers into the path', async () => {
    const { calls, fetch } = recorder(() => json({ template: {} }))
    await new PhiloClient({ fetch }).emailTemplates.get('a/b')
    expect(calls[0]?.url).toBe('/api/v1/settings/email/templates/a%2Fb')
  })

  it('scopes stages, templates and leads to a funnel when one is named', async () => {
    const { calls, fetch } = recorder(() => json({ stages: [], templates: [], template: {}, leads: [] }))
    const client = new PhiloClient({ fetch })
    await client.stages.list(undefined, 4)
    await client.stages.reorder([1, 2], 4)
    await client.emailTemplates.list(undefined, 4)
    await client.emailTemplates.update('new_lead_ack', { subject: 'Hi' }, 4)
    await client.leads.list({ funnelId: 4 })
    expect(calls.map((call) => call.url)).toEqual([
      '/api/v1/stages?funnel=4',
      '/api/v1/stages/reorder?funnel=4',
      '/api/v1/settings/email/templates?funnel=4',
      '/api/v1/settings/email/templates/new_lead_ack?funnel=4',
      '/api/v1/leads?funnel=4',
    ])
  })

  it('manages funnels', async () => {
    const { calls, fetch } = recorder(() => json({ funnel: { id: 2 }, funnels: [] }))
    const client = new PhiloClient({ fetch })
    expect(await client.funnels.create('Sales')).toEqual({ id: 2 })
    await client.funnels.update(2, { notifyRecipients: [] })
    await client.funnels.delete(2)
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'POST /api/v1/funnels',
      'PATCH /api/v1/funnels/2',
      'DELETE /api/v1/funnels/2',
    ])
  })

  it('looks up the global fetch per call', async () => {
    const client = new PhiloClient()
    const stub = vi.fn(async () => json({ name: 'philo', version: '9.9.9' }))
    vi.stubGlobal('fetch', stub)
    expect(await client.version()).toEqual({ name: 'philo', version: '9.9.9' })
    expect(stub).toHaveBeenCalledOnce()
  })
})

/** A response whose body arrives in exactly these chunks. */
function chunked(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

describe('push.live', () => {
  const NOTIFICATION = { title: 'New lead: Dana', body: 'dana@example.com', navigate: 'https://philo.example.com/leads/4', tag: 'philo-lead-4' }

  it('hands over each lead event, however the bytes are split, and skips comments', async () => {
    const event = `event: lead\ndata: ${JSON.stringify(NOTIFICATION)}\n\n`
    const { calls, fetch } = recorder(() =>
      chunked([': connected\n\n', event.slice(0, 17), event.slice(17), ': keep-alive\r\n\r\n', event]),
    )
    const received: unknown[] = []

    await new PhiloClient({ fetch, accessToken: () => 'tok' }).push.live((notification) => received.push(notification))

    expect(received).toEqual([NOTIFICATION, NOTIFICATION])
    expect(calls[0]?.url).toBe('/api/v1/push/live')
    expect(header(calls[0], 'authorization')).toBe('Bearer tok')
    expect(header(calls[0], 'accept')).toBe('text/event-stream')
  })

  it('ignores events it does not know', async () => {
    const { fetch } = recorder(() => chunked(['event: something-new\ndata: {}\n\n']))
    const received: unknown[] = []

    await new PhiloClient({ fetch }).push.live((notification) => received.push(notification))

    expect(received).toEqual([])
  })

  it('throws the API error for a refused stream', async () => {
    const { fetch } = recorder(() => json({ error: 'unauthorized' }, 401))

    const failure = new PhiloClient({ fetch }).push.live(() => undefined)

    await expect(failure).rejects.toSatisfy(isUnauthorized)
  })
})
