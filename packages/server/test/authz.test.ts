import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { API_PREFIX, PUBLIC_API_PATHS, USER_API_ROUTES } from '../src/app.ts'
import { hasAccess, ROLES_ON_ACCOUNTS } from '../src/auth/access.ts'
import { createApiKey } from '../src/auth/api-keys.ts'
import type { ExternalIdp } from '../src/auth/external-idp.ts'
import { accessTokens, authorizationCodes, users } from '../src/db/schema.ts'
import { FIRST_PARTY_CLIENT_ID } from '../src/oauth/first-party.ts'
import { createAuthorizationCode, issueTokens } from '../src/oauth/tokens.ts'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TEST_APP_URL,
  TEST_PUBLIC_BASE_URL,
  agentAuth,
  cleanupTestApps,
  createPerson,
  createTestApp,
  jsonPost,
  operatorAuth,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

function as(authorization: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization } }
}

function json(method: string, body: unknown, authorization: string): RequestInit {
  return as(authorization, { ...jsonPost(body), method })
}

/** An admin (the first account) and a user, each with a PWA token. */
async function twoPeople(testApp: TestApp): Promise<{ admin: string; user: string; userId: number }> {
  const admin = await setupAdmin(testApp)
  const userId = createPerson(testApp)
  return { admin, user: operatorAuth(testApp, userId), userId }
}

/**
 * Everything outside `API_PREFIX` the server answers without an API
 * credential. A new one fails the route walk until it is added here, which is
 * the moment to decide whether it should be public at all.
 */
const PUBLIC_ROUTES = new Set([
  'GET /version',
  'GET /llms.txt',
  // A page that holds no data; the preview arrives by postMessage.
  'GET /api/email-preview',
  'POST /api/intake/:formKey',
  'OPTIONS /api/intake/:formKey',
  'POST /oauth/register',
  'GET /oauth/authorize',
  'POST /oauth/authorize',
  'POST /oauth/token',
  'POST /oauth/revoke',
  'GET /oauth/userinfo',
  'POST /oauth/userinfo',
  'GET /oauth/jwks',
  'GET /.well-known/openid-configuration',
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource',
])

/** Registered handlers, not middleware: `app.use` registers under method ALL. */
function registeredRoutes(testApp: TestApp): { method: string; path: string }[] {
  const seen = new Set<string>()
  const routes: { method: string; path: string }[] = []
  for (const { method, path } of testApp.app.routes) {
    if (method === 'ALL') continue
    const key = `${method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ method, path })
  }
  return routes
}

/** A concrete path for a route pattern. `1` for ids, a real trigger for templates. */
function concrete(path: string): string {
  return path.replace(':trigger', 'new_lead_ack').replace(/:[A-Za-z]+/g, '1')
}

async function call(
  testApp: TestApp,
  method: string,
  path: string,
  authorization: string,
): Promise<{ status: number; error: unknown }> {
  const res = await testApp.app.request(concrete(path), {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
  })
  if (res.status === 403) return { status: 403, error: ((await res.json()) as { error?: unknown }).error }
  // The SSE streams would otherwise stay open past the test.
  await res.body?.cancel()
  return { status: res.status, error: undefined }
}

describe('the route walk — ADR-0012, deny by default', () => {
  it('classifies every route the server registers', async () => {
    const testApp = createTestApp()
    const { admin, user } = await twoPeople(testApp)
    const userRoutes = new Set(USER_API_ROUTES.map(([method, path]) => `${method} ${path}`))

    const unclassified: string[] = []
    const wrong: string[] = []
    for (const { method, path } of registeredRoutes(testApp)) {
      const key = `${method} ${path}`
      if (!path.startsWith(`${API_PREFIX}/`)) {
        if (!PUBLIC_ROUTES.has(key)) unclassified.push(key)
        continue
      }
      if (PUBLIC_API_PATHS.has(path)) continue

      const asUser = await call(testApp, method, path, user)
      if (userRoutes.has(key)) {
        if (asUser.status === 403 || asUser.status === 401) wrong.push(`${key}: user got ${asUser.status}`)
      } else {
        if (asUser.status !== 403 || asUser.error !== 'admin_required') {
          wrong.push(`${key}: user got ${asUser.status}, expected 403 admin_required`)
        }
      }
      const asAdmin = await call(testApp, method, path, admin)
      if (asAdmin.status === 403 || asAdmin.status === 401) wrong.push(`${key}: admin got ${asAdmin.status}`)
    }

    expect(unclassified).toEqual([])
    expect(wrong).toEqual([])
  })

  it('lists no user route the server does not have', () => {
    const testApp = createTestApp()
    const registered = new Set(registeredRoutes(testApp).map(({ method, path }) => `${method} ${path}`))
    expect(USER_API_ROUTES.map(([method, path]) => `${method} ${path}`).filter((key) => !registered.has(key))).toEqual([])
  })

  it('keeps a route added later admin-only until someone lists it', async () => {
    const testApp = createTestApp()
    const { admin, user } = await twoPeople(testApp)
    const { Hono } = await import('hono')
    const extra = new Hono()
    extra.get('/', (c) => c.json({ ok: true }))
    testApp.app.route(`${API_PREFIX}/later`, extra)

    expect((await testApp.app.request(`${API_PREFIX}/later`, as(user))).status).toBe(403)
    expect((await testApp.app.request(`${API_PREFIX}/later`, as(admin))).ok).toBe(true)
  })

  it('answers HEAD like GET', async () => {
    const testApp = createTestApp()
    const { user } = await twoPeople(testApp)
    expect((await testApp.app.request(`${API_PREFIX}/stages`, as(user, { method: 'HEAD' }))).ok).toBe(true)
    expect((await testApp.app.request(`${API_PREFIX}/webhooks`, as(user, { method: 'HEAD' }))).status).toBe(403)
  })
})

describe('what a user may do', () => {
  it('works a lead end to end', async () => {
    const testApp = createTestApp()
    const { user } = await twoPeople(testApp)
    const api = (path: string, init?: RequestInit) => testApp.app.request(`${API_PREFIX}${path}`, init)

    const { funnels } = (await (await api('/funnels', as(user))).json()) as { funnels: { id: number }[] }
    expect(funnels.length).toBeGreaterThan(0)
    expect((await api(`/funnels/${funnels[0]!.id}`, as(user))).ok).toBe(true)
    const { stages } = (await (await api('/stages', as(user))).json()) as { stages: { id: number }[] }

    const created = await api('/leads', json('POST', { name: 'Pat Applicant', email: 'pat@example.com' }, user))
    expect(created.ok).toBe(true)
    const { lead } = (await created.json()) as { lead: { id: number } }
    expect((await api('/leads', as(user))).ok).toBe(true)
    expect((await api(`/leads/${lead.id}`, as(user))).ok).toBe(true)
    expect((await api(`/leads/${lead.id}`, json('PATCH', { details: { note: 'called' } }, user))).ok).toBe(true)
    expect((await api(`/leads/${lead.id}/stage`, json('POST', { stageId: stages[1]!.id }, user))).ok).toBe(true)
    expect((await api(`/leads/${lead.id}/notes`, json('POST', { note: 'Left a message' }, user))).ok).toBe(true)

    const upload = await api(
      `/leads/${lead.id}/attachments?filename=resume.pdf`,
      as(user, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7') }),
    )
    expect(upload.ok).toBe(true)
    const { lead: withFile } = (await upload.json()) as { lead: { attachments: { id: number }[] } }
    const attachmentId = withFile.attachments[0]!.id
    expect((await api(`/leads/${lead.id}/attachments/${attachmentId}`, as(user))).ok).toBe(true)
    expect((await api(`/leads/${lead.id}/attachments/${attachmentId}`, as(user, { method: 'DELETE' }))).ok).toBe(true)

    // ADR-0012: deleting a lead is part of working leads.
    expect((await api(`/leads/${lead.id}`, as(user, { method: 'DELETE' }))).ok).toBe(true)
  })

  it('manages their own API keys and devices', async () => {
    const testApp = createTestApp()
    const { user } = await twoPeople(testApp)
    const api = (path: string, init?: RequestInit) => testApp.app.request(`${API_PREFIX}${path}`, init)

    const created = await api('/api-keys', json('POST', { name: 'laptop agent' }, user))
    expect(created.ok).toBe(true)
    const { key: apiKey } = (await created.json()) as { key: { id: number } }
    expect((await api('/api-keys', as(user))).ok).toBe(true)
    expect((await api(`/api-keys/${apiKey.id}`, as(user, { method: 'DELETE' }))).ok).toBe(true)

    expect((await api('/push/key', as(user))).ok).toBe(true)
    const subscription = { endpoint: 'https://push.example.com/s/1', keys: { p256dh: 'p', auth: 'a' } }
    expect((await api('/push/subscriptions', json('POST', subscription, user))).ok).toBe(true)
    expect((await api('/push/subscriptions', json('DELETE', { endpoint: subscription.endpoint }, user))).ok).toBe(true)
  })

  it('is refused configuration, reads included', async () => {
    const testApp = createTestApp()
    const { user } = await twoPeople(testApp)
    const refused: [string, string, unknown?][] = [
      ['POST', '/funnels', { name: 'Sales' }],
      ['PATCH', '/funnels/1', { name: 'Renamed' }],
      ['DELETE', '/funnels/1'],
      ['POST', '/stages', { name: 'Screening' }],
      ['POST', '/stages/reorder', { stageIds: [] }],
      ['PATCH', '/stages/1', { name: 'Renamed' }],
      ['DELETE', '/stages/1'],
      ['GET', '/settings/email'],
      ['PATCH', '/settings/email', {}],
      ['POST', '/settings/email/test', { to: 'x@example.com' }],
      ['GET', '/settings/email/templates'],
      ['GET', '/settings/email/templates/new_lead_ack'],
      ['PATCH', '/settings/email/templates/new_lead_ack', { subject: 'Hi' }],
      ['POST', '/settings/email/templates/new_lead_ack/preview', {}],
      ['POST', '/settings/email/templates/new_lead_ack/test', {}],
      ['GET', '/webhooks'],
      ['POST', '/webhooks', { url: 'https://hooks.example.com/x' }],
      ['PATCH', '/webhooks/1', { enabled: false }],
      ['DELETE', '/webhooks/1'],
      ['POST', '/webhooks/1/test', {}],
    ]
    for (const [method, path, body] of refused) {
      const init = body === undefined ? as(user, { method }) : json(method, body, user)
      const res = await testApp.app.request(`${API_PREFIX}${path}`, init)
      expect({ route: `${method} ${path}`, status: res.status, body: await res.json() }).toEqual({
        route: `${method} ${path}`,
        status: 403,
        body: { error: 'admin_required' },
      })
    }
  })
})

describe('what an admin may do', () => {
  it('configures the instance', async () => {
    const testApp = createTestApp()
    const { admin } = await twoPeople(testApp)
    const api = (path: string, init?: RequestInit) => testApp.app.request(`${API_PREFIX}${path}`, init)

    expect((await api('/funnels', json('POST', { name: 'Sales' }, admin))).ok).toBe(true)
    expect((await api('/stages', json('POST', { name: 'Screening' }, admin))).ok).toBe(true)
    expect((await api('/settings/email', as(admin))).ok).toBe(true)
    expect((await api('/settings/email/templates', as(admin))).ok).toBe(true)
    expect((await api('/webhooks', as(admin))).ok).toBe(true)
  })
})

describe('roles on every credential', () => {
  it('reports the role with the session and the principal', async () => {
    const testApp = createTestApp()
    const { admin, user, userId } = await twoPeople(testApp)

    expect(await (await testApp.app.request(`${API_PREFIX}/auth/session`, as(admin))).json()).toMatchObject({
      user: { id: 1, role: 'admin' },
    })
    expect(await (await testApp.app.request(`${API_PREFIX}/auth/principal`, as(user))).json()).toEqual({
      user: { id: userId, email: 'user@example.com', name: 'User', role: 'user' },
      role: 'user',
      actor: `user:${userId}`,
    })
  })

  it("gives a user's API key and connector token the user's role, no more", async () => {
    const testApp = createTestApp()
    const { userId } = await twoPeople(testApp)
    const key = `Bearer ${createApiKey(testApp.db, userId, 'agent').key}`
    const { authorization: connector } = await agentAuth(testApp, userId)

    for (const credential of [key, connector]) {
      expect((await testApp.app.request(`${API_PREFIX}/leads`, as(credential))).ok).toBe(true)
      expect((await testApp.app.request(`${API_PREFIX}/webhooks`, as(credential))).status).toBe(403)
      expect(await (await testApp.app.request(`${API_PREFIX}/auth/principal`, as(credential))).json()).toMatchObject({
        role: 'user',
      })
    }
  })

  it('takes a role change on the next request of every credential', async () => {
    const testApp = createTestApp()
    const { userId } = await twoPeople(testApp)
    const pwa = operatorAuth(testApp, userId)
    const key = `Bearer ${createApiKey(testApp.db, userId, 'agent').key}`

    testApp.db.update(users).set({ role: 'admin' }).where(eq(users.id, userId)).run()
    for (const credential of [pwa, key]) {
      expect((await testApp.app.request(`${API_PREFIX}/webhooks`, as(credential))).ok).toBe(true)
    }

    testApp.db.update(users).set({ role: 'user' }).where(eq(users.id, userId)).run()
    for (const credential of [pwa, key]) {
      expect((await testApp.app.request(`${API_PREFIX}/webhooks`, as(credential))).status).toBe(403)
    }
  })

  it('refuses every credential of a deactivated or no-access account', async () => {
    const testApp = createTestApp()
    const { userId } = await twoPeople(testApp)
    const pwa = operatorAuth(testApp, userId)
    const key = `Bearer ${createApiKey(testApp.db, userId, 'agent').key}`

    testApp.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId)).run()
    for (const credential of [pwa, key]) {
      expect((await testApp.app.request(`${API_PREFIX}/leads`, as(credential))).status).toBe(401)
    }

    testApp.db.update(users).set({ disabledAt: null, role: null }).where(eq(users.id, userId)).run()
    for (const credential of [pwa, key]) {
      expect((await testApp.app.request(`${API_PREFIX}/leads`, as(credential))).status).toBe(401)
    }
  })

  it('makes the first-boot account an admin', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const [row] = testApp.db.select({ role: users.role, confirmed: users.roleConfirmedAt }).from(users).all()
    expect(row).toMatchObject({ role: 'admin', confirmed: expect.any(Date) })
  })
})

function account(overrides: Partial<Parameters<typeof hasAccess>[0]> = {}): Parameters<typeof hasAccess>[0] {
  return { role: 'user', roleConfirmedAt: null, disabledAt: null, ...overrides }
}

describe('has access — ADR-0012', () => {
  const now = new Date('2026-11-26T12:00:00Z')
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const external = { rolesFromIdp: true }

  it('refuses a deactivated account and one with no role, in every mode', () => {
    for (const policy of [ROLES_ON_ACCOUNTS, external]) {
      expect(hasAccess(account({ disabledAt: daysAgo(1), roleConfirmedAt: now }), policy, now)).toBe(false)
      expect(hasAccess(account({ role: null, roleConfirmedAt: now }), policy, now)).toBe(false)
    }
  })

  it('ignores the confirmation when roles live on the account', () => {
    expect(hasAccess(account(), ROLES_ON_ACCOUNTS, now)).toBe(true)
    expect(hasAccess(account({ roleConfirmedAt: daysAgo(365) }), ROLES_ON_ACCOUNTS, now)).toBe(true)
  })

  it('needs a confirmation within 30 days when the IdP manages roles', () => {
    expect(hasAccess(account({ roleConfirmedAt: daysAgo(29) }), external, now)).toBe(true)
    expect(hasAccess(account({ roleConfirmedAt: daysAgo(31) }), external, now)).toBe(false)
    expect(hasAccess(account(), external, now)).toBe(false)
  })

  it('is the only reader of users.role outside the account resolvers', async () => {
    // ADR-0012: no consumer reads the role without the predicate. Everything
    // else selects it through ACCOUNT_COLUMNS and decides with hasAccess.
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const root = join(import.meta.dirname, '../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(root)
    const readers = files
      .filter((file) => /users\.role\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .toSorted()
    expect(readers).toEqual(['auth/access.ts'])
  })
})

/** The two ways an account loses access in ADR-0012, applied straight to the row. */
const NO_ACCESS: [string, Partial<typeof users.$inferInsert>][] = [
  ['a deactivated account', { disabledAt: new Date() }],
  ['an account with no role', { role: null }],
]

function oauthForm(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_PUBLIC_BASE_URL },
    body: new URLSearchParams(fields).toString(),
  }
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const PWA_REDIRECT = `${TEST_APP_URL}/auth/callback`

/** The first account, with a real password the dialog can check. */
async function accountWithPassword(testApp: TestApp): Promise<number> {
  await setupAdmin(testApp)
  return testApp.db.select({ id: users.id }).from(users).all()[0]!.id
}

describe.each(NO_ACCESS)('the built-in IdP refuses %s', (_label, change) => {
  it('in the sign-in dialog, with the generic message and no code', async () => {
    const testApp = createTestApp()
    const userId = await accountWithPassword(testApp)
    testApp.db.update(users).set(change).where(eq(users.id, userId)).run()

    const res = await testApp.app.request(
      '/oauth/authorize',
      oauthForm({
        response_type: 'code',
        client_id: FIRST_PARTY_CLIENT_ID,
        redirect_uri: PWA_REDIRECT,
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scope: 'openid operator',
        state: 's',
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        approve: '1',
      }),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('That email or password is not right.')
    expect(testApp.db.select().from(authorizationCodes).all()).toHaveLength(0)
  })

  it('at the token endpoint, for a code issued before access went', async () => {
    const testApp = createTestApp()
    const userId = await accountWithPassword(testApp)
    const { verifier, challenge } = pkcePair()
    const code = createAuthorizationCode(testApp.db, {
      clientId: FIRST_PARTY_CLIENT_ID,
      userId,
      redirectUri: PWA_REDIRECT,
      codeChallenge: challenge,
      resource: null,
      scope: 'openid operator',
      nonce: null,
    })
    testApp.db.update(users).set(change).where(eq(users.id, userId)).run()
    const before = testApp.db.select().from(accessTokens).all().length

    const res = await testApp.app.request(
      '/oauth/token',
      oauthForm({
        grant_type: 'authorization_code',
        client_id: FIRST_PARTY_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: PWA_REDIRECT,
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_grant')
    expect(body).not.toHaveProperty('id_token')
    expect(testApp.db.select().from(accessTokens).all()).toHaveLength(before)
  })

  it('at the token endpoint, for a refresh token', async () => {
    const testApp = createTestApp()
    const userId = await accountWithPassword(testApp)
    const { refreshToken } = issueTokens(testApp.db, {
      clientId: FIRST_PARTY_CLIENT_ID,
      userId,
      resource: null,
      scope: 'openid operator',
    })
    testApp.db.update(users).set(change).where(eq(users.id, userId)).run()
    const before = testApp.db.select().from(accessTokens).all().length

    const res = await testApp.app.request(
      '/oauth/token',
      oauthForm({ grant_type: 'refresh_token', client_id: FIRST_PARTY_CLIENT_ID, refresh_token: refreshToken }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_grant')
    expect(body).not.toHaveProperty('id_token')
    expect(testApp.db.select().from(accessTokens).all()).toHaveLength(before)
  })

  it('at /oauth/userinfo', async () => {
    const testApp = createTestApp()
    const userId = await accountWithPassword(testApp)
    const authorization = operatorAuth(testApp, userId)
    expect((await testApp.app.request('/oauth/userinfo', as(authorization))).status).toBe(200)

    testApp.db.update(users).set(change).where(eq(users.id, userId)).run()
    const res = await testApp.app.request('/oauth/userinfo', as(authorization))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_token' })
  })
})

describe('an external IdP token for a bound account without access', () => {
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
      audience: ['philo-api'],
      clientId: PWA_CLIENT,
      agentClientIds: [],
      keys: createLocalJWKSet({ keys: [jwk] }),
      userinfoEndpoint: async () => undefined,
    }
  })

  const token = () =>
    new SignJWT({ azp: PWA_CLIENT, email: 'owner@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('philo-api')
      .setSubject('external-sub')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)

  it.each(NO_ACCESS)('refuses %s with 401', async (_label, change) => {
    const testApp = createTestApp({ externalIdp: idp })
    const jwt = `Bearer ${await token()}`
    expect((await testApp.app.request(`${API_PREFIX}/leads`, as(jwt))).status).toBe(200)
    const [row] = testApp.db.select({ id: users.id, subject: users.externalSubject }).from(users).all()
    expect(row?.subject).toBe(`${ISSUER} external-sub`)

    testApp.db.update(users).set(change).where(eq(users.id, row!.id)).run()
    expect((await testApp.app.request(`${API_PREFIX}/leads`, as(jwt))).status).toBe(401)
  })
})
