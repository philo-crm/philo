import { Hono } from 'hono'
import { SignJWT, createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createFirstUser } from '../src/auth/credentials.ts'
import type { ExternalIdp } from '../src/auth/external-idp.ts'
import { accessTokens, leadEvents, users } from '../src/db/schema.ts'
import { eq } from 'drizzle-orm'
import {
  ADMIN_EMAIL,
  TEST_PUBLIC_BASE_URL,
  agentAuth,
  cleanupTestApps,
  createTestApp,
  jsonPost,
  setupAdmin,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

function as(authorization: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization } }
}

describe('bearer guard', () => {
  it('refuses an unauthenticated request with a bearer challenge', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="philo"')
  })

  it('says the token is the problem when one was presented', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads', as('Bearer philo_at_never-issued'))

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
  })

  it('lets an operator token through', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    expect((await testApp.app.request('/api/v1/leads', as(authorization))).status).toBe(200)
  })

  it('stops accepting an operator token once it has expired', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    testApp.db.update(accessTokens).set({ expiresAt: new Date(Date.now() - 1000) }).run()

    expect((await testApp.app.request('/api/v1/leads', as(authorization))).status).toBe(401)
  })

  it('ignores cookies entirely, so a cross-site request arrives unauthenticated', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads', { headers: { cookie: 'philo_session=anything' } })
    expect(res.status).toBe(401)
  })

  it('records the person on the timeline for an operator token', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const created = await testApp.app.request('/api/v1/leads', as(authorization, jsonPost({ email: 'pat@example.com' })))
    expect(created.status).toBe(201)

    const [event] = testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'created')).all()
    expect(event?.actor).toBe('user:1')
  })

  it('gives a connector token everything its user has — ADR-0007', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const { authorization } = await agentAuth(testApp, 1)

    for (const path of ['/api/v1/leads', '/api/v1/auth/session', '/api/v1/api-keys', '/api/v1/settings/email']) {
      expect((await testApp.app.request(path, as(authorization))).status, path).toBe(200)
    }
    const session = await testApp.app.request('/api/v1/auth/session', as(authorization))
    expect(await session.json()).toEqual({ user: { id: 1, email: ADMIN_EMAIL, name: 'Admin' } })
  })

  it('refuses a token whose user is gone', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const { authorization } = await agentAuth(testApp, 1)
    testApp.db.delete(users).run()

    expect((await testApp.app.request('/api/v1/leads', as(authorization))).status).toBe(401)
  })
})

describe('GET /api/v1/auth/config', () => {
  it('is public, and points the PWA at the built-in IdP', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/config')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      issuer: TEST_PUBLIC_BASE_URL,
      clientId: 'philo-web',
      scope: 'openid operator',
    })
  })
})

describe('GET /api/v1/auth/session', () => {
  it('describes the operator the token belongs to', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/auth/session', as(authorization))
    expect(await res.json()).toEqual({ user: { id: 1, email: ADMIN_EMAIL, name: 'Admin' } })
  })
})

describe('GET /api/v1/auth/principal', () => {
  it('names the same user for the person and their agent, and tells the credentials apart', async () => {
    const testApp = createTestApp()
    const person = await setupAdmin(testApp)
    const { authorization, clientId } = await agentAuth(testApp, 1)
    const user = { id: 1, email: ADMIN_EMAIL, name: 'Admin' }

    expect(await (await testApp.app.request('/api/v1/auth/principal', as(person))).json()).toEqual({
      user,
      actor: 'user:1',
    })
    expect(await (await testApp.app.request('/api/v1/auth/principal', as(authorization))).json()).toEqual({
      user,
      actor: `oauth:${clientId}`,
    })
  })

  it('is refused without a credential', async () => {
    const testApp = createTestApp()
    expect((await testApp.app.request('/api/v1/auth/principal')).status).toBe(401)
  })
})

describe('cross-origin access', () => {
  it('answers a preflight from any origin, allowing the bearer header', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
    // `*` and credentials are mutually exclusive; there are no credentials to allow.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })
})

describe('body limit', () => {
  it('refuses an oversized body before authenticating it', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads', jsonPost({ padding: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
  })
})

describe('route guard', () => {
  it('guards a route added after createApp, without a per-route opt-in', async () => {
    const testApp = createTestApp()
    const extra = new Hono()
    extra.get('/', (c) => c.json({ secret: true }))
    testApp.app.route('/api/v1/later', extra)

    expect((await testApp.app.request('/api/v1/later')).status).toBe(401)
  })

  it('leaves /version public, so healthchecks work before setup', async () => {
    const testApp = createTestApp()
    expect((await testApp.app.request('/version')).status).toBe(200)
  })
})

describe('external IdP', () => {
  const ISSUER = 'https://idp.example.com/realms/philo'
  const PWA_CLIENT = 'philo-web-external'
  const USERINFO = 'https://idp.example.com/realms/philo/userinfo'
  let privateKey: CryptoKey
  let idp: ExternalIdp
  // Every outbound call in these tests is the userinfo request. By default the
  // provider refuses it, so nothing ever reaches the network.
  let fetchSpy: MockInstance<typeof fetch>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 401 }))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function userinfo(body: unknown, init: ResponseInit = {}): void {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init }),
    )
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    privateKey = pair.privateKey
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
    idp = {
      issuer: ISSUER,
      audience: 'philo-api',
      clientId: PWA_CLIENT,
      agentClientIds: ['some-connector'],
      keys: createLocalJWKSet({ keys: [jwk] }),
      userinfoEndpoint: async () => USERINFO,
    }
  })

  function token(claims: Record<string, unknown>, options: { issuer?: string; audience?: string; subject?: string } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? 'philo-api')
      .setSubject(options.subject ?? 'external-sub')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  it('switches the built-in IdP off and points the PWA at the external one', async () => {
    const testApp = createTestApp({ externalIdp: idp })

    expect(await (await testApp.app.request('/api/v1/auth/config')).json()).toEqual({
      issuer: ISSUER,
      clientId: PWA_CLIENT,
      scope: 'openid email profile',
    })
    expect((await testApp.app.request('/oauth/authorize')).status).toBe(404)
    expect((await testApp.app.request('/.well-known/openid-configuration')).status).toBe(404)
  })

  it('provisions the operator from the first token on an empty instance', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token({ azp: PWA_CLIENT, email: 'Owner@Example.com', email_verified: true, name: 'Owner' })

    const res = await testApp.app.request('/api/v1/auth/session', as(`Bearer ${jwt}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: { id: 1, email: 'owner@example.com', name: 'Owner' } })
  })

  it('refuses a second person once the instance has its operator', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })}`))

    const other = await token({ azp: PWA_CLIENT, email: 'someone@example.com', email_verified: true }, { subject: 'someone-else' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${other}`))).status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(1)
  })

  it('refuses a token held by a client nobody listed', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    // Another application registered at the same IdP: its tokens verify, and
    // must still get nothing here.
    const jwt = await token({ azp: 'unrelated-app', email: 'owner@example.com' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(401)
  })

  it('refuses a token that names no client at all', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token({ email: 'owner@example.com' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(401)
  })

  it('refuses an id_token from a listed agent client too', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token({ azp: 'some-connector', typ: 'ID' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(401)
  })

  it('lets a listed agent client act as the user its token names', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })}`))
    // Same subject as the operator's own token: the IdP issued it to the connector on their behalf.
    const jwt = await token({ azp: 'some-connector' })

    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(200)
    expect((await testApp.app.request('/api/v1/api-keys', as(`Bearer ${jwt}`))).status).toBe(200)
    const created = await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`, jsonPost({ phone: '555-0100' })))
    expect(created.status).toBe(201)
    const [event] = testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'created')).all()
    expect(event?.actor).toBe('oauth:some-connector')
  })

  it.each([
    ['another issuer', { azp: PWA_CLIENT, email: 'owner@example.com' }, { issuer: 'https://evil.example.com' }],
    ['another audience', { azp: PWA_CLIENT, email: 'owner@example.com' }, { audience: 'someone-else' }],
    ['an id_token', { azp: PWA_CLIENT, email: 'owner@example.com', typ: 'ID' }, {}],
    ['an unverified email', { azp: PWA_CLIENT, email: 'owner@example.com', email_verified: false }, {}],
    ['an email nobody vouched for', { azp: PWA_CLIENT, email: 'owner@example.com' }, {}],
    ['no email', { azp: PWA_CLIENT }, {}],
  ])('refuses %s', async (_label, claims, options) => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token(claims, options)
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
  })

  it('binds the operator to the subject, so a changed email at the IdP still signs them in', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })}`))

    const renamed = await token({ azp: PWA_CLIENT, email: 'new-address@example.com', email_verified: true })
    expect(await (await testApp.app.request('/api/v1/auth/session', as(`Bearer ${renamed}`))).json()).toMatchObject({
      user: { id: 1, email: 'owner@example.com' },
    })
  })

  it('refuses another subject that claims the operator\'s email', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })}`))

    const impostor = await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true }, { subject: 'impostor' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${impostor}`))).status).toBe(401)
  })

  it('binds an account from the built-in IdP era by its verified email, once', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    createFirstUser(testApp.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
    const jwt = await token({ azp: PWA_CLIENT, email: ADMIN_EMAIL, email_verified: true })
    expect(await (await testApp.app.request('/api/v1/auth/session', as(`Bearer ${jwt}`))).json()).toMatchObject({
      user: { id: 1, email: ADMIN_EMAIL },
    })
    const [row] = testApp.db.select().from(users).all()
    expect(row?.externalSubject).toBe(`${ISSUER} external-sub`)
  })

  describe('a token that carries no email', () => {
    const BARE = { azp: PWA_CLIENT }

    it('provisions the operator from userinfo on an empty instance', async () => {
      const testApp = createTestApp({ externalIdp: idp })
      userinfo({ sub: 'external-sub', email: 'Owner@Example.com', email_verified: true, name: 'Owner' })
      const jwt = await token(BARE)

      const res = await testApp.app.request('/api/v1/auth/session', as(`Bearer ${jwt}`))
      expect(await res.json()).toEqual({ user: { id: 1, email: 'owner@example.com', name: 'Owner' } })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]!
      expect(String(url)).toBe(USERINFO)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${jwt}`)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    })

    it('binds an account from the built-in IdP era by the email userinfo verifies', async () => {
      const testApp = createTestApp({ externalIdp: idp })
      createFirstUser(testApp.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
      userinfo({ sub: 'external-sub', email: ADMIN_EMAIL, email_verified: true })

      const res = await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token(BARE)}`))
      expect(await res.json()).toMatchObject({ user: { id: 1, email: ADMIN_EMAIL } })
      const [row] = testApp.db.select().from(users).all()
      expect(row?.externalSubject).toBe(`${ISSUER} external-sub`)
    })

    it('never asks userinfo again once the subject is bound', async () => {
      const testApp = createTestApp({ externalIdp: idp })
      userinfo({ sub: 'external-sub', email: 'owner@example.com', email_verified: true })
      await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token(BARE)}`))
      fetchSpy.mockClear()

      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${await token(BARE)}`))).status).toBe(200)
      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${await token({ azp: 'some-connector' })}`))).status).toBe(200)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('asks nothing of userinfo once every account is bound', async () => {
      const testApp = createTestApp({ externalIdp: idp })
      await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })}`))
      userinfo({ sub: 'someone-else', email: 'someone@example.com', email_verified: true })

      const other = await token(BARE, { subject: 'someone-else' })
      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${other}`))).status).toBe(401)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each([
      ['an unverified email', { sub: 'external-sub', email: 'owner@example.com', email_verified: false }],
      ['an email nobody vouched for', { sub: 'external-sub', email: 'owner@example.com' }],
      ['no email', { sub: 'external-sub' }],
      ['another subject', { sub: 'someone-else', email: 'owner@example.com', email_verified: true }],
      ['no subject', { email: 'owner@example.com', email_verified: true }],
      ['something other than an object', ['owner@example.com']],
    ])('refuses when userinfo answers with %s', async (_label, body) => {
      const testApp = createTestApp({ externalIdp: idp })
      userinfo(body)
      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${await token(BARE)}`))).status).toBe(401)
      expect(testApp.db.select().from(users).all()).toHaveLength(0)
    })

    it.each([
      ['refuses the token', new Response(null, { status: 401 })],
      ['answers something other than 200', new Response(JSON.stringify({ sub: 'external-sub', email: 'owner@example.com', email_verified: true }), { status: 203 })],
      ['answers with something that is not JSON', new Response('<html>', { status: 200 })],
      ['answers with more than a profile', new Response(JSON.stringify({ sub: 'external-sub', email: 'owner@example.com', email_verified: true, pad: 'x'.repeat(100_000) }), { status: 200 })],
    ])('refuses when userinfo %s', async (_label, response) => {
      const testApp = createTestApp({ externalIdp: idp })
      fetchSpy.mockResolvedValue(response)
      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${await token(BARE)}`))).status).toBe(401)
      expect(testApp.db.select().from(users).all()).toHaveLength(0)
    })

    describe('parallel first requests', () => {
      // A slow provider that answers each token with that token's own subject
      // and the email `emails` assigns it, so two requests' userinfo calls overlap.
      function slowUserinfo(emails: Record<string, string>): void {
        fetchSpy.mockImplementation(async (_url, init) => {
          const jwt = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length)
          const { sub } = decodeJwt(jwt)
          await new Promise((resolve) => setTimeout(resolve, 30))
          return Response.json({ sub, email: emails[sub!], email_verified: true })
        })
      }

      async function both(testApp: ReturnType<typeof createTestApp>, a: string, b: string): Promise<number[]> {
        const responses = await Promise.all([a, b].map((jwt) => testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))))
        return responses.map((res) => res.status)
      }

      it.each([
        ['provisions the operator once on an empty instance', false],
        ['binds an account from the built-in IdP era once', true],
      ])('same subject: %s and lets both in', async (_label, builtin) => {
        const current = createTestApp({ externalIdp: idp })
        if (builtin) createFirstUser(current.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
        slowUserinfo({ 'external-sub': builtin ? ADMIN_EMAIL : 'owner@example.com' })

        expect(await both(current, await token(BARE), await token(BARE))).toEqual([200, 200])
        expect(fetchSpy).toHaveBeenCalledTimes(2)
        const rows = current.db.select().from(users).all()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.externalSubject).toBe(`${ISSUER} external-sub`)
      })

      it.each([
        ['provision', false],
        ['bind', true],
      ])('a different subject that loses the %s race is still refused', async (_label, builtin) => {
        const current = createTestApp({ externalIdp: idp })
        if (builtin) createFirstUser(current.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
        // On the bind path both vouch for the one unbound address.
        slowUserinfo(builtin
          ? { 'external-sub': ADMIN_EMAIL, 'someone-else': ADMIN_EMAIL }
          : { 'external-sub': 'owner@example.com', 'someone-else': 'someone@example.com' })

        const statuses = await both(current, await token(BARE), await token(BARE, { subject: 'someone-else' }))
        expect(statuses.toSorted()).toEqual([200, 401])
        const winner = statuses[0] === 200 ? 'external-sub' : 'someone-else'
        const rows = current.db.select().from(users).all()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.externalSubject).toBe(`${ISSUER} ${winner}`)
      })
    })

    it('refuses when the provider names no userinfo endpoint', async () => {
      const testApp = createTestApp({ externalIdp: { ...idp, userinfoEndpoint: async () => undefined } })
      expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${await token(BARE)}`))).status).toBe(401)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each([
      ['cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
      ['times out', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
      ['fails on its side', async () => new Response(null, { status: 503 })],
    ])('fails the request, without a 401, when userinfo %s', async (_label, impl) => {
      const testApp = createTestApp({ externalIdp: idp })
      fetchSpy.mockImplementation(impl)
      const res = await testApp.app.request('/api/v1/leads', as(`Bearer ${await token(BARE)}`))
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(testApp.db.select().from(users).all()).toHaveLength(0)
    })
  })

  it('makes no userinfo call for a token that carries its own verified email', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })
    expect((await testApp.app.request('/api/v1/auth/session', as(`Bearer ${jwt}`))).status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still accepts API keys', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const operator = await token({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })
    const minted = await testApp.app.request('/api/v1/api-keys', as(`Bearer ${operator}`, jsonPost({ name: 'cron' })))
    const { secret } = (await minted.json()) as { secret: string }

    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${secret}`))).status).toBe(200)
  })
})
