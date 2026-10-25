import { Hono } from 'hono'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

  it('withholds operator-only routes from an agent token', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const { authorization } = await agentAuth(testApp, 1)

    expect((await testApp.app.request('/api/v1/leads', as(authorization))).status).toBe(200)
    for (const path of ['/api/v1/auth/session', '/api/v1/api-keys', '/api/v1/settings/email']) {
      const res = await testApp.app.request(path, as(authorization))
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'session_required' })
    }
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
  let privateKey: CryptoKey
  let idp: ExternalIdp

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    privateKey = pair.privateKey
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
    idp = {
      issuer: ISSUER,
      audience: 'philo-api',
      clientId: PWA_CLIENT,
      keys: createLocalJWKSet({ keys: [jwk] }),
    }
  })

  function token(claims: Record<string, unknown>, options: { issuer?: string; audience?: string } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? 'philo-api')
      .setSubject('external-sub')
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
    await testApp.app.request('/api/v1/auth/session', as(`Bearer ${await token({ azp: PWA_CLIENT, email: 'owner@example.com' })}`))

    const other = await token({ azp: PWA_CLIENT, email: 'someone@example.com' })
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${other}`))).status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(1)
  })

  it('treats a token held by any other client as an agent', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token({ azp: 'some-connector', email: 'owner@example.com' })

    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(200)
    expect((await testApp.app.request('/api/v1/api-keys', as(`Bearer ${jwt}`))).status).toBe(403)
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
    ['no email', { azp: PWA_CLIENT }, {}],
  ])('refuses %s', async (_label, claims, options) => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = await token(claims, options)
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${jwt}`))).status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
  })

  it('still accepts API keys', async () => {
    const testApp = createTestApp({ externalIdp: idp })
    const operator = await token({ azp: PWA_CLIENT, email: 'owner@example.com' })
    const minted = await testApp.app.request('/api/v1/api-keys', as(`Bearer ${operator}`, jsonPost({ name: 'cron' })))
    const { secret } = (await minted.json()) as { secret: string }

    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${secret}`))).status).toBe(200)
  })
})
