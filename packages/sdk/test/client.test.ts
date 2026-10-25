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

  it('looks up the global fetch per call', async () => {
    const client = new PhiloClient()
    const stub = vi.fn(async () => json({ name: 'philo', version: '9.9.9' }))
    vi.stubGlobal('fetch', stub)
    expect(await client.version()).toEqual({ name: 'philo', version: '9.9.9' })
    expect(stub).toHaveBeenCalledOnce()
  })
})
