import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { users } from '../src/db/schema.ts'
import { FIRST_PARTY_CLIENT_ID } from '../src/oauth/first-party.ts'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TEST_APP_URL,
  TEST_PUBLIC_BASE_URL,
  cleanupTestApps,
  createTestApp,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

// The PWA's sign-in, end to end against the built-in IdP — ADR-0006.

const REDIRECT_URI = `${TEST_APP_URL}/auth/callback`

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorizeParams(challenge: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: FIRST_PARTY_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid operator',
    state: 'pwa-state',
    nonce: 'pwa-nonce',
    ...overrides,
  }
}

function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_PUBLIC_BASE_URL },
    body: new URLSearchParams(fields).toString(),
  }
}

function codeFrom(res: Response): string {
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(REDIRECT_URI)
  expect(location.searchParams.get('state')).toBe('pwa-state')
  const code = location.searchParams.get('code')
  if (code === null) throw new Error(`no code in ${location.toString()}`)
  return code
}

interface Tokens {
  access_token: string
  refresh_token: string
  id_token?: string
  scope: string
}

async function exchange(testApp: TestApp, code: string, verifier: string): Promise<Tokens> {
  const res = await testApp.app.request(
    '/oauth/token',
    formPost({
      grant_type: 'authorization_code',
      client_id: FIRST_PARTY_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Tokens
}

async function signIn(testApp: TestApp, overrides: Record<string, string> = {}): Promise<Tokens> {
  const { verifier, challenge } = pkce()
  const res = await testApp.app.request(
    '/oauth/authorize',
    formPost({ ...authorizeParams(challenge, overrides), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, approve: '1' }),
  )
  return exchange(testApp, codeFrom(res), verifier)
}

describe('first-boot setup dialog', () => {
  it('asks for an account instead of a password on an empty instance', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams(pkce().challenge))}`)

    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toContain('Set up Philo')
    expect(page).toContain('name="setup"')
    expect(page).toContain('autocomplete="new-password"')
  })

  it('creates the account and completes the sign-in in one POST', async () => {
    const testApp = createTestApp()
    const { verifier, challenge } = pkce()
    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({
        ...authorizeParams(challenge),
        setup: '1',
        name: 'Owner',
        email: 'Owner@Example.com',
        password: ADMIN_PASSWORD,
        approve: '1',
      }),
    )
    const tokens = await exchange(testApp, codeFrom(res), verifier)

    const session = await testApp.app.request('/api/v1/auth/session', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    // Lowercased on the way in, so case cannot make a second account later.
    expect(await session.json()).toEqual({ user: { id: 1, email: 'owner@example.com', name: 'Owner' } })
    const [stored] = testApp.db.select().from(users).all()
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/)
  })

  it('refuses a short password and creates nothing', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({ ...authorizeParams(pkce().challenge), setup: '1', email: ADMIN_EMAIL, password: 'short', approve: '1' }),
    )
    expect(res.status).toBe(400)
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
  })

  it('is refused once an account exists, whatever the form says', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({ ...authorizeParams(pkce().challenge), setup: '1', email: 'intruder@example.com', password: ADMIN_PASSWORD, approve: '1' }),
    )
    expect(res.status).toBe(409)
    expect(testApp.db.select().from(users).all()).toHaveLength(1)
  })

  it('is offered to the first-party client only', async () => {
    const testApp = createTestApp()
    const registered = await testApp.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.com/cb'], token_endpoint_auth_method: 'none' }),
    })
    const { client_id: clientId } = (await registered.json()) as { client_id: string }
    const res = await testApp.app.request(
      '/oauth/authorize',
      formPost({
        ...authorizeParams(pkce().challenge, { client_id: clientId, redirect_uri: 'https://client.example.com/cb' }),
        setup: '1',
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        approve: '1',
      }),
    )
    expect(res.status).toBe(409)
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
  })
})

describe('first-party sign-in', () => {
  it('shows a plain sign-in, with nothing to approve', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams(pkce().challenge))}`)

    const page = await res.text()
    expect(page).toContain('Sign in to Philo')
    expect(page).not.toContain('is asking for access')
    expect(page).not.toContain('name="deny"')
  })

  it('grants operator authority', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp)

    expect(tokens.scope).toBe('openid operator')
    const keys = await testApp.app.request('/api/v1/api-keys', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(keys.status).toBe(200)
  })

  it('redirects only to the configured app URL', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams(pkce().challenge, { redirect_uri: 'https://evil.example.com/auth/callback' }))}`,
    )
    expect(res.status).toBe(400)
  })

  it('follows PHILO_APP_URL when the PWA is hosted elsewhere', async () => {
    const testApp = createTestApp({ appUrl: 'https://app.example.com' })
    await setupAdmin(testApp)
    const res = await testApp.app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams(pkce().challenge, { redirect_uri: 'https://app.example.com/auth/callback' }))}`,
    )
    expect(res.status).toBe(200)
  })
})

describe('id_token', () => {
  it('is signed by the published key and carries the nonce and the operator', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp)
    if (tokens.id_token === undefined) throw new Error('no id_token')

    const jwks = (await (await testApp.app.request('/oauth/jwks')).json()) as JSONWebKeySet
    const { payload, protectedHeader } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: TEST_PUBLIC_BASE_URL,
      audience: FIRST_PARTY_CLIENT_ID,
    })
    expect(protectedHeader.alg).toBe('ES256')
    expect(payload).toMatchObject({ sub: '1', email: ADMIN_EMAIL, name: 'Admin', nonce: 'pwa-nonce' })
  })

  it('is left out when openid was not requested', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp, { scope: 'operator' })
    expect(tokens.id_token).toBeUndefined()
    expect(tokens.scope).toBe('operator')
  })

  it('publishes only the public half of the key', async () => {
    const testApp = createTestApp()
    const { keys } = (await (await testApp.app.request('/oauth/jwks')).json()) as { keys: Record<string, unknown>[] }
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toHaveProperty('d')
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
  })
})

describe('userinfo', () => {
  it('describes the operator to a token granted openid', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp)
    const res = await testApp.app.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(await res.json()).toEqual({ sub: '1', email: ADMIN_EMAIL, name: 'Admin' })
  })

  it('refuses a token that never asked for identity', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp, { scope: 'operator' })
    const res = await testApp.app.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('revocation', () => {
  it('ends the grant, so signing out is real', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const tokens = await signIn(testApp)

    const revoked = await testApp.app.request(
      '/oauth/revoke',
      formPost({ client_id: FIRST_PARTY_CLIENT_ID, token: tokens.refresh_token }),
    )
    expect(revoked.status).toBe(200)

    const refresh = await testApp.app.request(
      '/oauth/token',
      formPost({ grant_type: 'refresh_token', client_id: FIRST_PARTY_CLIENT_ID, refresh_token: tokens.refresh_token }),
    )
    expect(refresh.status).toBe(400)
  })

  it('answers 200 for a token it does not know, as RFC 7009 requires', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/oauth/revoke',
      formPost({ client_id: FIRST_PARTY_CLIENT_ID, token: 'philo_rt_never-issued' }),
    )
    expect(res.status).toBe(200)
  })

  it('is open to the PWA from another origin', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/oauth/revoke', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
