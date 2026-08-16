import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { accessTokens, leadEvents, oauthClients, refreshTokens } from '../src/db/schema.ts'
import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_CLIENT_URI_LENGTH,
  MAX_REGISTERED_CLIENTS,
} from '../src/oauth/clients.ts'
import { MAX_OAUTH_BODY_BYTES } from '../src/oauth/routes.ts'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TEST_PUBLIC_BASE_URL,
  cleanupTestApps,
  createTestApp,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

const REDIRECT_URI = 'https://claude.example.com/api/mcp/auth_callback'
const RESOURCE = `${TEST_PUBLIC_BASE_URL}/mcp`

interface Pkce {
  verifier: string
  challenge: string
}

function pkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * `TEST_PUBLIC_BASE_URL`, not `TEST_ORIGIN`: the consent form is guarded
 * against the deployment's configured origin rather than the one the socket
 * implies, so the browser's `Origin` is what that setting says — see the
 * `csrf()` note in oauth/routes.ts. No `Sec-Fetch-Site` here on purpose, so
 * the origin check is the one actually under test.
 */
function formPost(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: TEST_PUBLIC_BASE_URL,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  }
}

interface RegisteredClient {
  client_id: string
  client_secret?: string
}

async function register(
  testApp: TestApp,
  metadata: Record<string, unknown> = {},
): Promise<RegisteredClient> {
  const res = await testApp.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: 'Example Connector',
      ...metadata,
    }),
  })
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as RegisteredClient
}

function authorizeQuery(client: RegisteredClient, challenge: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'opaque-state',
    resource: RESOURCE,
    ...overrides,
  })
}

/** Signs in on the consent page and returns the code the redirect carries. */
async function approve(
  testApp: TestApp,
  client: RegisteredClient,
  challenge: string,
  overrides: Record<string, string> = {},
): Promise<{ code: string; state: string | null }> {
  const res = await testApp.app.request(
    '/oauth/authorize',
    formPost({
      ...Object.fromEntries(authorizeQuery(client, challenge, overrides)),
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      approve: '1',
    }),
  )
  if (res.status !== 302) throw new Error(`approve did not redirect: ${res.status} ${await res.text()}`)
  const location = new URL(res.headers.get('location') ?? '')
  const code = location.searchParams.get('code')
  if (code === null) throw new Error(`approve redirected without a code: ${location.toString()}`)
  return { code, state: location.searchParams.get('state') }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

function tokenPost(client: RegisteredClient, fields: Record<string, string>): RequestInit {
  return formPost({
    client_id: client.client_id,
    ...(client.client_secret === undefined ? {} : { client_secret: client.client_secret }),
    ...fields,
  })
}

/** Registration through to a live access token — the whole flow, once. */
async function connect(testApp: TestApp): Promise<{ client: RegisteredClient; tokens: TokenResponse }> {
  await setupAdmin(testApp)
  const client = await register(testApp)
  const { verifier, challenge } = pkce()
  const { code } = await approve(testApp, client, challenge)
  const res = await testApp.app.request(
    '/oauth/token',
    tokenPost(client, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    }),
  )
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
  return { client, tokens: (await res.json()) as TokenResponse }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
}

function mcpPost(token: string, body: unknown = INITIALIZE): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }
}

describe('oauth discovery', () => {
  it('advertises the authorization server at the RFC 8414 path', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/.well-known/oauth-authorization-server')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      issuer: TEST_PUBLIC_BASE_URL,
      authorization_endpoint: `${TEST_PUBLIC_BASE_URL}/oauth/authorize`,
      token_endpoint: `${TEST_PUBLIC_BASE_URL}/oauth/token`,
      registration_endpoint: `${TEST_PUBLIC_BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // OAuth 2.1 removed `plain`, and advertising it would invite it.
      code_challenge_methods_supported: ['S256'],
    })
  })

  it('advertises the protected resource at both paths a client may try', async () => {
    const testApp = createTestApp()
    const expected = {
      resource: RESOURCE,
      authorization_servers: [TEST_PUBLIC_BASE_URL],
      bearer_methods_supported: ['header'],
    }

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await testApp.app.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.json()).toMatchObject(expected)
    }
  })

  it('points an unauthenticated MCP client at that metadata', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${TEST_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  it('404s an unknown well-known path instead of serving the app shell', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/.well-known/nonsense')

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })
})

describe('oauth dynamic client registration', () => {
  it('registers a client and issues a non-expiring secret', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'Example Connector' }),
    })

    expect(res.status).toBe(201)
    const client = (await res.json()) as Record<string, unknown>
    expect(typeof client['client_id']).toBe('string')
    expect(typeof client['client_secret']).toBe('string')
    // A secret that expires would break a working connector a month later with
    // nothing on screen saying why.
    expect(client['client_secret_expires_at']).toBe(0)
    expect(client['redirect_uris']).toEqual([REDIRECT_URI])
  })

  it('registers a public client with no secret when asked', async () => {
    const testApp = createTestApp()
    const client = await register(testApp, { token_endpoint_auth_method: 'none' })

    expect(client.client_secret).toBeUndefined()
  })

  it('never stores the secret it handed out', async () => {
    const testApp = createTestApp()
    const client = await register(testApp)
    const [row] = testApp.db.select().from(oauthClients).all()

    expect(row?.clientSecretHash).not.toBe(client.client_secret)
    expect(JSON.stringify(row)).not.toContain(client.client_secret)
  })

  it.each([
    ['a redirect over plain http off loopback', { redirect_uris: ['http://example.com/cb'] }],
    ['a javascript: redirect', { redirect_uris: ['javascript:alert(1)'] }],
    ['no redirect at all', { redirect_uris: [] }],
    ['an auth method it cannot honour', { token_endpoint_auth_method: 'private_key_jwt' }],
  ])('refuses %s', async (_label, metadata) => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], ...metadata }),
    })

    expect(res.status).toBe(400)
  })

  it('accepts a loopback redirect on any port, for a local MCP client', async () => {
    const testApp = createTestApp()
    const client = await register(testApp, { redirect_uris: ['http://127.0.0.1:1/callback'] })

    expect(typeof client.client_id).toBe('string')
  })

  /**
   * Straight to the table: driving hundreds of registrations through the
   * endpoint would spend the throttle's real delays for nothing.
   */
  function fillClientTable(testApp: TestApp): void {
    const now = new Date()
    for (let i = 0; i < MAX_REGISTERED_CLIENTS; i += 1) {
      testApp.db
        .insert(oauthClients)
        .values({
          clientId: `client-${i}`,
          clientSecretHash: 'x',
          redirectUris: JSON.stringify([REDIRECT_URI]),
          tokenEndpointAuthMethod: 'client_secret_basic',
          createdAt: new Date(now.getTime() + i),
        })
        .run()
    }
  }

  it('makes room by evicting an unused registration when the table is full', async () => {
    const testApp = createTestApp()
    fillClientTable(testApp)

    // This endpoint is unauthenticated, so refusing here would let a stranger
    // fill the table and keep the operator from ever connecting a client.
    const client = await register(testApp)

    const rows = testApp.db.select().from(oauthClients).all()
    expect(rows).toHaveLength(MAX_REGISTERED_CLIENTS)
    expect(rows.map((row) => row.clientId)).toContain(client.client_id)
    expect(rows.map((row) => row.clientId)).not.toContain('client-0')
  })

  it('refuses only when every registration holds a live grant', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    fillClientTable(testApp)
    const now = new Date()
    for (let i = 0; i < MAX_REGISTERED_CLIENTS; i += 1) {
      testApp.db
        .insert(accessTokens)
        .values({
          tokenHash: `hash-${i}`,
          clientId: `client-${i}`,
          userId: 1,
          resource: null,
          scope: 'mcp',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        })
        .run()
    }

    const res = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    })

    expect(res.status).toBe(503)
  })

  it('bounds the request body', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'x'.repeat(MAX_OAUTH_BODY_BYTES) }),
    })

    expect(res.status).toBe(400)
  })
})

describe('oauth authorize', () => {
  it('shows the consent page for a valid request', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(`/oauth/authorize?${authorizeQuery(client, challenge)}`)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('Example Connector')
    expect(body).toContain('name="password"')
    expect(body).toContain(`value="${challenge}"`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('caps the name and URI a client registered for itself', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        client_name: 'A'.repeat(5000),
        client_uri: `https://example.com/${'b'.repeat(5000)}`,
      }),
    })
    const registered = (await res.json()) as Record<string, string>

    // RFC 7591 §3.2.1 wants the metadata as registered, not as asked for.
    expect(registered['client_name']?.length).toBe(MAX_CLIENT_NAME_LENGTH)
    expect(registered['client_uri']?.length).toBe(MAX_CLIENT_URI_LENGTH)

    const { challenge } = pkce()
    const page = await testApp.app.request(
      `/oauth/authorize?${authorizeQuery({ client_id: registered['client_id'] ?? '' }, challenge)}`,
    )
    const body = await page.text()

    // Registration is unauthenticated, so an uncapped name is several screens
    // of a stranger's prose pushing the redirect target below the fold.
    expect(body).not.toContain('A'.repeat(MAX_CLIENT_NAME_LENGTH + 1))
    expect(body).toContain('A'.repeat(MAX_CLIENT_NAME_LENGTH - 1))
  })

  it('makes Approve the default button and lets Cancel skip validation', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(`/oauth/authorize?${authorizeQuery(client, challenge)}`)
    const body = await res.text()

    // Implicit submission picks the first submit button, so Enter after typing
    // the password must not be a refusal.
    expect(body.indexOf('name="approve"')).toBeLessThan(body.indexOf('name="deny"'))
    // And declining a request you did not start must not require a password
    // first, which the `required` fields would otherwise insist on.
    expect(body).toMatch(/name="deny"[^>]*formnovalidate/)
  })

  it('escapes the name a client registered for itself', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp, { client_name: '<script>alert(1)</script>' })
    const { challenge } = pkce()

    const res = await testApp.app.request(`/oauth/authorize?${authorizeQuery(client, challenge)}`)
    const body = await res.text()

    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
  })

  it.each([
    ['an unknown client', { client_id: 'not-a-client' }],
    ['a redirect the client never registered', { redirect_uri: 'https://evil.example.com/cb' }],
  ])('refuses %s on the page rather than redirecting', async (_label, overrides) => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      `/oauth/authorize?${authorizeQuery(client, challenge, overrides)}`,
    )

    // Redirecting either of these would make Philo an open redirector.
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it.each([
    ['response_type', { response_type: 'token' }, 'unsupported_response_type'],
    ['a missing PKCE challenge', { code_challenge: '' }, 'invalid_request'],
    ['a plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['a resource this server does not host', { resource: 'https://elsewhere.example.com/mcp' }, 'invalid_target'],
  ])('sends %s back to the client as an error', async (_label, overrides, expected) => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      `/oauth/authorize?${authorizeQuery(client, challenge, overrides)}`,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(REDIRECT_URI)
    expect(location.searchParams.get('error')).toBe(expected)
    expect(location.searchParams.get('state')).toBe('opaque-state')
  })

  it('issues a code and echoes state when the operator approves', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const { code, state } = await approve(testApp, client, challenge)

    expect(code).toMatch(/^philo_ac_/)
    expect(state).toBe('opaque-state')
  })

  it('refuses a wrong password without issuing anything', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({
        ...Object.fromEntries(authorizeQuery(client, challenge)),
        email: ADMIN_EMAIL,
        password: 'not-the-right-password',
        approve: '1',
      }),
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('not right')
  })

  it('sends access_denied back when the operator cancels', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({ ...Object.fromEntries(authorizeQuery(client, challenge)), deny: '1' }),
    )

    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied')
  })

  it('accepts the form behind a TLS-terminating proxy', async () => {
    // The socket carries plain http there, so the origin the browser sends is
    // the configured one and nothing else. Without `Sec-Fetch-Site` to fall
    // back on, a request-derived origin check would refuse this.
    const publicBaseUrl = 'https://philo.example.com'
    const testApp = createTestApp({ publicBaseUrl })
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost(
        {
          ...Object.fromEntries(authorizeQuery(client, challenge, { resource: `${publicBaseUrl}/mcp` })),
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          approve: '1',
        },
        { origin: publicBaseUrl },
      ),
    )

    expect(res.status).toBe(302)
  })

  it('refuses a form posted from another origin', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()

    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost(
        {
          ...Object.fromEntries(authorizeQuery(client, challenge)),
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          approve: '1',
        },
        { origin: 'https://evil.example.com' },
      ),
    )

    expect(res.status).toBe(403)
  })
})

describe('oauth token', () => {
  it('exchanges a code for a usable access token', async () => {
    const testApp = createTestApp()
    const { tokens } = await connect(testApp)

    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.scope).toBe('mcp')
    expect(tokens.expires_in).toBeGreaterThan(0)
    expect(tokens.access_token).toMatch(/^philo_at_/)
    expect(tokens.refresh_token).toMatch(/^philo_rt_/)
  })

  it('keeps the token response out of shared caches', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'authorization_code', code, code_verifier: verifier }),
    )

    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('refuses the wrong PKCE verifier', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, {
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce().verifier,
      }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('burns the code even when the exchange fails', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const wrong = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'authorization_code', code, code_verifier: pkce().verifier }),
    )
    expect(wrong.status).toBe(400)

    // Otherwise an intercepted code could be brute-forced one verifier at a time.
    const retry = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'authorization_code', code, code_verifier: verifier }),
    )
    expect(retry.status).toBe(400)
    expect(await retry.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a code redeemed a second time', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)
    const exchange = () =>
      testApp.app.request(
        '/oauth/token',
        tokenPost(client, { grant_type: 'authorization_code', code, code_verifier: verifier }),
      )

    expect((await exchange()).status).toBe(200)
    expect((await exchange()).status).toBe(400)
  })

  it('refuses a code presented by a different client', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const other = await register(testApp, { client_name: 'Someone Else' })
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(other, { grant_type: 'authorization_code', code, code_verifier: verifier }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a confidential client that presents no secret', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const res = await testApp.app.request(
      '/oauth/token',
      formPost({
        client_id: client.client_id,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }),
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_client' })
  })

  it('accepts the secret over HTTP Basic as well as in the body', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)
    const basic = Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret ?? '')}`,
    ).toString('base64')

    const res = await testApp.app.request(
      '/oauth/token',
      formPost({ grant_type: 'authorization_code', code, code_verifier: verifier }, {
        authorization: `Basic ${basic}`,
      }),
    )

    expect(res.status).toBe(200)
  })

  it('refuses a redirect_uri that does not match the authorization request', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)
    const { verifier, challenge } = pkce()
    const { code } = await approve(testApp, client, challenge)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://claude.example.com/somewhere-else',
      }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a grant type it does not implement', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const client = await register(testApp)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'client_credentials' }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' })
  })
})

describe('oauth refresh', () => {
  it('mints a working access token after the first one expires', async () => {
    const testApp = createTestApp()
    const { client, tokens } = await connect(testApp)

    // Age the access token rather than the clock: everything else in the flow
    // is unaffected, which is exactly the situation a refresh exists for.
    testApp.db
      .update(accessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run()
    expect((await testApp.app.request('/mcp', mcpPost(tokens.access_token))).status).toBe(401)

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )
    expect(res.status).toBe(200)
    const refreshed = (await res.json()) as TokenResponse

    expect(refreshed.access_token).not.toBe(tokens.access_token)
    expect((await testApp.app.request('/mcp', mcpPost(refreshed.access_token))).status).toBe(200)
  })

  it('rotates the refresh token, so the spent one stops working', async () => {
    const testApp = createTestApp()
    const { client, tokens } = await connect(testApp)

    const first = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )
    const refreshed = (await first.json()) as TokenResponse
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)

    const replayed = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )

    expect(replayed.status).toBe(400)
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a refresh token presented by a different client without spending it', async () => {
    const testApp = createTestApp()
    const { client, tokens } = await connect(testApp)
    const other = await register(testApp, { client_name: 'Someone Else' })

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(other, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )
    expect(res.status).toBe(400)

    // Spending it here would hand anyone who learns a token they cannot use a
    // way to break the operator's connector anyway — registration is open, so
    // authenticating as some other client costs an attacker nothing.
    expect(testApp.db.select().from(refreshTokens).all()).toHaveLength(1)
    const owner = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )
    expect(owner.status).toBe(200)
  })

  it('refuses an expired refresh token', async () => {
    const testApp = createTestApp()
    const { client, tokens } = await connect(testApp)
    testApp.db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run()

    const res = await testApp.app.request(
      '/oauth/token',
      tokenPost(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    )

    expect(res.status).toBe(400)
  })
})

describe('oauth access at the mcp surface', () => {
  it('lets an issued token call tools', async () => {
    const testApp = createTestApp()
    const { tokens } = await connect(testApp)

    const res = await testApp.app.request(
      '/mcp',
      mcpPost(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { tools?: unknown[] } }
    expect(body.result?.tools?.length).toBeGreaterThan(0)
  })

  it('records the client on the timeline, not the operator', async () => {
    const testApp = createTestApp()
    const { client, tokens } = await connect(testApp)

    const created = await testApp.app.request(
      '/mcp',
      mcpPost(tokens.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_lead',
          arguments: { name: 'Pat Applicant', email: 'pat@example.com' },
        },
      }),
    )
    expect(created.status).toBe(200)

    // DESIGN.md (Auth and access): one identity per credential, so a lead moved
    // by a connector is distinguishable from one moved by a person.
    const [event] = testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'created')).all()
    expect(event?.actor).toBe(`oauth:${client.client_id}`)
  })

  it('stops accepting a token the instant its row is gone', async () => {
    const testApp = createTestApp()
    const { tokens } = await connect(testApp)

    expect((await testApp.app.request('/mcp', mcpPost(tokens.access_token))).status).toBe(200)
    testApp.db.delete(accessTokens).run()

    expect((await testApp.app.request('/mcp', mcpPost(tokens.access_token))).status).toBe(401)
  })

  it('does not let an access token reach the REST surface', async () => {
    const testApp = createTestApp()
    const { tokens } = await connect(testApp)

    // OAuth exists here for MCP connector clients — DESIGN.md (Auth and access).
    // A key from Settings is what a script pointed at /api/v1 uses.
    const res = await testApp.app.request('/api/v1/leads', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })

    expect(res.status).toBe(401)
  })
})

describe('oauth route surface', () => {
  it('404s an unknown /oauth path instead of serving the app shell', async () => {
    const testApp = createTestApp()
    // GET /oauth/token is a real mistake to make, and an HTML 200 would be an
    // unparseable success to the client that made it.
    const res = await testApp.app.request('/oauth/token')

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })
})
