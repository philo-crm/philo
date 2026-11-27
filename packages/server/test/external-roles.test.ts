import { eq } from 'drizzle-orm'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { activeAdmins, EXTERNAL_ROLE_MAX_AGE_MS, ROLE_CONFIRMATION_INTERVAL_MS } from '../src/auth/access.ts'
import { createFirstUser } from '../src/auth/credentials.ts'
import type { ExternalIdp } from '../src/auth/external-idp.ts'
import { apiKeys, pushSubscriptions, users } from '../src/db/schema.ts'
import { ADMIN_EMAIL, cleanupTestApps, createTestApp, jsonPost, type TestApp } from './support/app.ts'

/**
 * ADR-0012 with an external IdP and both role scopes configured: the role
 * comes from the token's scopes, one account per subject, and the stored role
 * is only a cache that PWA tokens confirm and demote.
 */

const ISSUER = 'https://idp.example.com/realms/philo'
const PWA_CLIENT = 'philo-web-external'
const AGENT_CLIENT = 'some-connector'
const USER_SCOPE = 'crm:user'
const ADMIN_SCOPE = 'crm:admin'
const DAY_MS = 24 * 60 * 60 * 1000

let privateKey: CryptoKey
let idp: ExternalIdp
let fetchSpy: MockInstance<typeof fetch>

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
  idp = {
    issuer: ISSUER,
    audience: ['philo-api'],
    clientId: PWA_CLIENT,
    agentClientIds: [AGENT_CLIENT],
    scope: `openid email profile ${USER_SCOPE} ${ADMIN_SCOPE}`,
    resource: [],
    roles: { userScope: USER_SCOPE, adminScope: ADMIN_SCOPE },
    agentScope: `${USER_SCOPE} offline_access`,
    keys: createLocalJWKSet({ keys: [jwk] }),
    userinfoEndpoint: async () => 'https://idp.example.com/realms/philo/userinfo',
  }
})

beforeEach(() => {
  // Every outbound call is a userinfo request; by default the provider refuses it.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 401 }))
})

afterEach(() => {
  fetchSpy.mockRestore()
  cleanupTestApps()
})

interface TokenOptions {
  client?: string
  subject?: string
  email?: string | null
  /** As `scope`, a space-separated string. */
  scope?: string
  /** As `scp`, an array. */
  scp?: string[]
}

function token(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { azp: options.client ?? PWA_CLIENT }
  const email = options.email === undefined ? 'owner@example.com' : options.email
  if (email !== null) Object.assign(claims, { email, email_verified: true, name: 'Owner' })
  if (options.scope !== undefined) claims['scope'] = options.scope
  if (options.scp !== undefined) claims['scp'] = options.scp
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience('philo-api')
    .setSubject(options.subject ?? 'owner-sub')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

const bearer = async (options: TokenOptions = {}) => ({ headers: { authorization: `Bearer ${await token(options)}` } })

async function principal(testApp: TestApp, options: TokenOptions) {
  const res = await testApp.app.request('/api/v1/auth/principal', await bearer(options))
  return { status: res.status, body: (await res.json()) as { role?: string; user?: { id: number; role: string }; error?: string } }
}

function rowOf(testApp: TestApp, id = 1) {
  return testApp.db.select().from(users).where(eq(users.id, id)).all()[0]
}

function app(): TestApp {
  return createTestApp({ externalIdp: idp })
}

/** An admin, provisioned by a PWA sign-in with both scopes. */
async function signedInAdmin(testApp: TestApp): Promise<void> {
  expect((await principal(testApp, { scope: `${USER_SCOPE} ${ADMIN_SCOPE}` })).status).toBe(200)
}

async function mintKey(testApp: TestApp, options: TokenOptions): Promise<string> {
  const res = await testApp.app.request('/api/v1/api-keys', jsonPost({ name: 'cron' }, { authorization: `Bearer ${await token(options)}` }))
  expect(res.status).toBe(201)
  return ((await res.json()) as { secret: string }).secret
}

const keyAuth = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } })

describe('the role a token names', () => {
  it.each([
    ['a scope string with the admin scope', { scope: `openid ${USER_SCOPE} ${ADMIN_SCOPE}` }, 'admin'],
    ['an scp array with the admin scope', { scp: ['openid', ADMIN_SCOPE, USER_SCOPE] }, 'admin'],
    ['the admin scope alone', { scope: ADMIN_SCOPE }, 'admin'],
    ['the user scope alone', { scope: `openid email ${USER_SCOPE}` }, 'user'],
    ['an scp array with the user scope', { scp: [USER_SCOPE] }, 'user'],
  ])('reads %s', async (_label, scopes, role) => {
    const testApp = app()
    const { status, body } = await principal(testApp, scopes)
    expect(status).toBe(200)
    expect(body.role).toBe(role)
    expect(body.user?.role).toBe(role)
    expect(rowOf(testApp)?.role).toBe(role)
  })

  it('matches scope tokens whole', async () => {
    const testApp = app()
    const res = await testApp.app.request('/api/v1/leads', await bearer({ scope: `${ADMIN_SCOPE}x ${USER_SCOPE}:read` }))
    expect(res.status).toBe(403)
  })

  it('caps the request at the token, so a user-scope token cannot reach admin routes', async () => {
    const testApp = app()
    const res = await testApp.app.request('/api/v1/webhooks', await bearer({ scope: USER_SCOPE }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'admin_required' })
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="philo", error="insufficient_scope", scope="${ADMIN_SCOPE}"`,
    )
  })

  it('lets an admin-scope token reach admin routes', async () => {
    const testApp = app()
    expect((await testApp.app.request('/api/v1/webhooks', await bearer({ scope: ADMIN_SCOPE }))).status).toBe(200)
  })
})

describe('a token with neither role scope', () => {
  it('is refused with 403 and a challenge naming the user scope, before any account exists', async () => {
    const testApp = app()
    const res = await testApp.app.request('/api/v1/leads', await bearer({ scope: 'openid email profile' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'insufficient_scope' })
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="philo", error="insufficient_scope", scope="${USER_SCOPE}"`,
    )
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never binds an account from the built-in IdP era', async () => {
    const testApp = app()
    createFirstUser(testApp.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
    const res = await testApp.app.request('/api/v1/leads', await bearer({ email: ADMIN_EMAIL }))
    expect(res.status).toBe(403)
    expect(rowOf(testApp)?.externalSubject).toBeNull()
  })

  it('leaves a bound account exactly as it was: role, confirmation, keys and devices', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const secret = await mintKey(testApp, { scope: ADMIN_SCOPE })
    testApp.db.insert(pushSubscriptions).values({ userId: 1, endpoint: 'https://push.example.com/s/1', p256dh: 'k', auth: 'a' }).run()
    const before = rowOf(testApp)

    for (const client of [PWA_CLIENT, AGENT_CLIENT]) {
      const res = await testApp.app.request('/api/v1/leads', await bearer({ client }))
      expect(res.status).toBe(403)
    }

    expect(rowOf(testApp)).toEqual(before)
    expect(testApp.db.select().from(apiKeys).all()).toHaveLength(1)
    expect(testApp.db.select().from(pushSubscriptions).all()).toHaveLength(1)
    expect((await testApp.app.request('/api/v1/webhooks', keyAuth(secret))).status).toBe(200)
  })

  it('still reaches the public sign-in config', async () => {
    const testApp = app()
    const res = await testApp.app.request('/api/v1/auth/config', await bearer({ scope: 'openid' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      issuer: ISSUER,
      clientId: PWA_CLIENT,
      scope: `openid email profile ${USER_SCOPE} ${ADMIN_SCOPE}`,
      resource: [],
      agentScope: `${USER_SCOPE} offline_access`,
    })
  })
})

describe('one account per subject', () => {
  it('provisions a second person as their own account', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const second = await principal(testApp, { subject: 'second-sub', email: 'second@example.com', scope: USER_SCOPE })
    expect(second.status).toBe(200)
    expect(second.body.user?.id).toBe(2)
    expect(second.body.role).toBe('user')
    expect(rowOf(testApp, 2)).toMatchObject({
      email: 'second@example.com',
      externalSubject: `${ISSUER} second-sub`,
      role: 'user',
    })
    expect(rowOf(testApp, 1)?.role).toBe('admin')
  })

  it('refuses a second subject that claims an address another subject holds', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads', await bearer({ subject: 'impostor', scope: ADMIN_SCOPE }))
    expect(res.status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(1)
  })

  it('binds an account from the built-in IdP era by its verified email', async () => {
    const testApp = app()
    createFirstUser(testApp.db, { email: ADMIN_EMAIL, passwordHash: 'unused', name: 'Admin' })
    const { status, body } = await principal(testApp, { email: ADMIN_EMAIL, scope: USER_SCOPE })
    expect(status).toBe(200)
    expect(body.user?.id).toBe(1)
    // The PWA's answer is the IdP's whole word: the migrated admin is now a user.
    expect(rowOf(testApp)).toMatchObject({ externalSubject: `${ISSUER} owner-sub`, role: 'user' })
  })

  it('asks userinfo for a new subject whose token carries no email, and provisions from it', async () => {
    const testApp = app()
    fetchSpy.mockImplementation(async () => Response.json({ sub: 'bare-sub', email: 'bare@example.com', email_verified: true }))
    const { status, body } = await principal(testApp, { subject: 'bare-sub', email: null, scope: USER_SCOPE })
    expect(status).toBe(200)
    expect(body.user?.id).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses a new subject nobody vouches an email for', async () => {
    const testApp = app()
    const res = await testApp.app.request('/api/v1/leads', await bearer({ email: null, scope: USER_SCOPE }))
    expect(res.status).toBe(401)
    expect(testApp.db.select().from(users).all()).toHaveLength(0)
  })

  it('provisions a subject once when its first two tokens race', async () => {
    const testApp = app()
    fetchSpy.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return Response.json({ sub: 'owner-sub', email: 'owner@example.com', email_verified: true })
    })
    const [a, b] = await Promise.all([
      testApp.app.request('/api/v1/leads', await bearer({ email: null, scope: USER_SCOPE })),
      testApp.app.request('/api/v1/leads', await bearer({ email: null, scope: USER_SCOPE })),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(testApp.db.select().from(users).all()).toHaveLength(1)
  })
})

describe('the cached role', () => {
  it('is demoted by a PWA token holding only the user scope', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const { body } = await principal(testApp, { scope: USER_SCOPE })
    expect(body.role).toBe('user')
    expect(rowOf(testApp)?.role).toBe('user')
    expect(activeAdmins(testApp.db, { rolesFromIdp: true })).toEqual([])
  })

  it('is never demoted by an agent token holding only the user scope', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const secret = await mintKey(testApp, { scope: ADMIN_SCOPE })

    const agent = await principal(testApp, { client: AGENT_CLIENT, scope: USER_SCOPE })
    expect(agent.body.role).toBe('user')
    const refused = await testApp.app.request('/api/v1/webhooks', await bearer({ client: AGENT_CLIENT, scope: USER_SCOPE }))
    expect(refused.status).toBe(403)

    expect(rowOf(testApp)?.role).toBe('admin')
    expect((await testApp.app.request('/api/v1/webhooks', keyAuth(secret))).status).toBe(200)
    expect(activeAdmins(testApp.db, { rolesFromIdp: true }).map((row) => row.id)).toEqual([1])
  })

  it('is raised to admin by any token holding the admin scope, an agent\'s included', async () => {
    const testApp = app()
    expect((await principal(testApp, { scope: USER_SCOPE })).body.role).toBe('user')
    await principal(testApp, { client: AGENT_CLIENT, scope: ADMIN_SCOPE })
    expect(rowOf(testApp)?.role).toBe('admin')
  })

  it('is confirmed by any admitted token, at most once per interval', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const recent = new Date(Date.now() - ROLE_CONFIRMATION_INTERVAL_MS / 2)
    testApp.db.update(users).set({ roleConfirmedAt: recent }).run()
    await principal(testApp, { client: AGENT_CLIENT, scope: USER_SCOPE })
    expect(rowOf(testApp)?.roleConfirmedAt).toEqual(recent)

    const stale = new Date(Date.now() - 20 * DAY_MS)
    testApp.db.update(users).set({ roleConfirmedAt: stale }).run()
    await principal(testApp, { client: AGENT_CLIENT, scope: USER_SCOPE })
    expect(rowOf(testApp)!.roleConfirmedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('never decides a token: a stored admin acts as the user its PWA token names', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    expect((await testApp.app.request('/api/v1/webhooks', await bearer({ scope: USER_SCOPE }))).status).toBe(403)
  })
})

describe('the 30-day confirmation', () => {
  it.each([
    [29, 200],
    [31, 401],
  ])('an API key whose role was confirmed %d days ago answers %d', async (days, status) => {
    const testApp = app()
    await signedInAdmin(testApp)
    const secret = await mintKey(testApp, { scope: ADMIN_SCOPE })
    testApp.db.update(users).set({ roleConfirmedAt: new Date(Date.now() - days * DAY_MS) }).run()
    expect((await testApp.app.request('/api/v1/leads', keyAuth(secret))).status).toBe(status)
  })

  it('is restored by the next admitted token', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    const secret = await mintKey(testApp, { scope: ADMIN_SCOPE })
    testApp.db.update(users).set({ roleConfirmedAt: new Date(Date.now() - EXTERNAL_ROLE_MAX_AGE_MS - DAY_MS) }).run()
    expect((await testApp.app.request('/api/v1/leads', keyAuth(secret))).status).toBe(401)
    expect(activeAdmins(testApp.db, { rolesFromIdp: true })).toEqual([])

    // A lapsed account still signs in with a token that holds a scope.
    expect((await principal(testApp, { scope: `${USER_SCOPE} ${ADMIN_SCOPE}` })).status).toBe(200)
    expect((await testApp.app.request('/api/v1/leads', keyAuth(secret))).status).toBe(200)
  })
})

describe('a deactivated account', () => {
  it('is refused with 403 account_disabled whatever scopes its token holds', async () => {
    const testApp = app()
    await signedInAdmin(testApp)
    testApp.db.update(users).set({ disabledAt: new Date() }).run()
    const before = rowOf(testApp)

    const res = await testApp.app.request('/api/v1/leads', await bearer({ scope: `${USER_SCOPE} ${ADMIN_SCOPE}` }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'account_disabled' })
    expect(rowOf(testApp)).toEqual(before)
  })
})
