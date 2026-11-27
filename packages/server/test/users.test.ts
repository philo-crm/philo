import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { ROLES_ON_ACCOUNTS } from '../src/auth/access.ts'
import { createApiKey } from '../src/auth/api-keys.ts'
import {
  accessTokens,
  accountLinks,
  apiKeys,
  authorizationCodes,
  leadEvents,
  pushSubscriptions,
  refreshTokens,
  users,
} from '../src/db/schema.ts'
import { FIRST_PARTY_CLIENT_ID } from '../src/oauth/first-party.ts'
import { createAuthorizationCode, issueTokens } from '../src/oauth/tokens.ts'
import { updatePerson } from '../src/users/service.ts'
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

const NEW_PASSWORD = 'a-brand-new-long-password'
const PWA_REDIRECT = `${TEST_APP_URL}/auth/callback`

function as(authorization: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization } }
}

function json(method: string, body: unknown, authorization: string): RequestInit {
  return as(authorization, { ...jsonPost(body), method })
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_PUBLIC_BASE_URL },
    body: new URLSearchParams(fields).toString(),
  }
}

interface PersonBody {
  id: number
  name: string | null
  email: string
  role: 'user' | 'admin' | null
  status: string
}

async function people(testApp: TestApp, authorization: string): Promise<PersonBody[]> {
  const res = await testApp.app.request('/api/v1/users', as(authorization))
  expect(res.status).toBe(200)
  return ((await res.json()) as { users: PersonBody[] }).users
}

async function invite(
  testApp: TestApp,
  admin: string,
  body: Record<string, unknown> = { email: 'sam@example.com', role: 'user' },
): Promise<{ user: PersonBody; inviteUrl: string; expiresAt: string }> {
  const res = await testApp.app.request('/api/v1/users', json('POST', body, admin))
  expect(res.status).toBe(201)
  return (await res.json()) as { user: PersonBody; inviteUrl: string; expiresAt: string }
}

/** The path part of a link the API handed out, for `app.request`. */
function pathOf(url: string): string {
  const parsed = new URL(url)
  expect(parsed.origin).toBe(TEST_PUBLIC_BASE_URL)
  return parsed.pathname
}

async function useLink(testApp: TestApp, url: string, fields: Record<string, string>): Promise<Response> {
  return testApp.app.request(pathOf(url), form(fields))
}

/** Signs in through the IdP dialog, as the PWA does. Returns the status and whether a code was issued. */
async function signIn(testApp: TestApp, email: string, password: string): Promise<{ status: number; code: boolean }> {
  const verifier = randomBytes(32).toString('base64url')
  const res = await testApp.app.request(
    '/oauth/authorize',
    form({
      response_type: 'code',
      client_id: FIRST_PARTY_CLIENT_ID,
      redirect_uri: PWA_REDIRECT,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'openid operator',
      state: 's',
      email,
      password,
      approve: '1',
    }),
  )
  const location = res.headers.get('location')
  return { status: res.status, code: location !== null && new URL(location).searchParams.has('code') }
}

async function adminAndId(testApp: TestApp): Promise<{ admin: string; adminId: number }> {
  const admin = await setupAdmin(testApp)
  const adminId = testApp.db.select({ id: users.id }).from(users).all()[0]!.id
  return { admin, adminId }
}

describe('GET /api/v1/users', () => {
  it('lists every person, with role and status, to a user', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const userId = createPerson(testApp, { email: 'pat@example.com', name: 'Pat' })
    const disabledId = createPerson(testApp, { email: 'gone@example.com', name: 'Gone' })
    testApp.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledId)).run()
    createPerson(testApp, { email: 'nobody@example.com', name: 'Nobody', role: null })
    await invite(testApp, admin, { email: 'new@example.com', role: 'admin' })

    const list = await people(testApp, operatorAuth(testApp, userId))
    expect(list.map(({ email, role, status }) => ({ email, role, status }))).toEqual([
      { email: ADMIN_EMAIL, role: 'admin', status: 'active' },
      { email: 'pat@example.com', role: 'user', status: 'active' },
      { email: 'gone@example.com', role: 'user', status: 'disabled' },
      { email: 'nobody@example.com', role: null, status: 'no_access' },
      { email: 'new@example.com', role: 'admin', status: 'invited' },
    ])
    expect(Object.keys(list[0]!).toSorted()).toEqual(['email', 'id', 'name', 'role', 'status'])
  })

  it('says what this instance manages itself', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const res = await testApp.app.request('/api/v1/users', as(admin))
    expect(await res.json()).toMatchObject({ invites: true, rolesManagedByIdp: false })
  })
})

describe('inviting someone — POST /api/v1/users', () => {
  it('creates an invited account whose link sets a name and password, then signs in', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)

    const before = Date.now()
    const created = await invite(testApp, admin, { email: ' Sam@Example.com ', role: 'user' })
    expect(created.user).toMatchObject({ email: 'sam@example.com', role: 'user', status: 'invited', name: null })
    const expires = new Date(created.expiresAt).getTime()
    expect(expires - before).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000)
    expect(expires - before).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 60_000)

    // No usable password until the link is used.
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toEqual({ status: 401, code: false })

    const page = await testApp.app.request(pathOf(created.inviteUrl))
    expect(page.status).toBe(200)
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    // The token is in the URL: no shared or back-forward cache may keep the page.
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html).toContain('name="name"')
    expect(html).toContain('name="password"')

    const done = await useLink(testApp, created.inviteUrl, { name: 'Sam', password: NEW_PASSWORD })
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe(TEST_APP_URL)

    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toEqual({ status: 302, code: true })
    const sam = (await people(testApp, admin)).find((person) => person.email === 'sam@example.com')
    expect(sam).toMatchObject({ name: 'Sam', status: 'active' })
  })

  it('stores only a hash of the link, and the link works once', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { inviteUrl } = await invite(testApp, admin)
    const token = pathOf(inviteUrl).split('/').at(-1)!

    const [row] = testApp.db.select().from(accountLinks).all()
    expect(row!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(testApp.db.select().from(accountLinks).all())).not.toContain(token)

    expect((await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })).status).toBe(302)
    const again = await useLink(testApp, inviteUrl, { password: 'somebody-else-entirely' })
    expect(again.status).toBe(410)
    const gone = await testApp.app.request(pathOf(inviteUrl))
    expect(gone.status).toBe(410)
    expect(gone.headers.get('cache-control')).toBe('no-store')
    expect(await signIn(testApp, 'sam@example.com', 'somebody-else-entirely')).toMatchObject({ code: false })
  })

  it('refuses an expired link', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { inviteUrl } = await invite(testApp, admin)
    testApp.db.update(accountLinks).set({ expiresAt: new Date(Date.now() - 1000) }).run()

    expect((await testApp.app.request(pathOf(inviteUrl))).status).toBe(410)
    expect((await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })).status).toBe(410)
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: false })
  })

  it('refuses a short password on the link page without spending the link', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { inviteUrl } = await invite(testApp, admin)
    expect((await useLink(testApp, inviteUrl, { password: 'short' })).status).toBe(400)
    expect((await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })).status).toBe(302)
  })

  it('refuses an address already in use, and a bad role or email', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const taken = await testApp.app.request('/api/v1/users', json('POST', { email: ADMIN_EMAIL, role: 'user' }, admin))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'email_taken' })
    const badRole = await testApp.app.request('/api/v1/users', json('POST', { email: 'x@example.com', role: 'owner' }, admin))
    expect(await badRole.json()).toEqual({ error: 'invalid_role' })
    const badEmail = await testApp.app.request('/api/v1/users', json('POST', { email: 'nope', role: 'user' }, admin))
    expect(await badEmail.json()).toEqual({ error: 'invalid_email' })
  })

  it('re-issues an invite, voiding the old link, only while the account is still invited', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const first = await invite(testApp, admin)

    const res = await testApp.app.request(`/api/v1/users/${first.user.id}/invite`, json('POST', {}, admin))
    expect(res.status).toBe(200)
    const second = (await res.json()) as { inviteUrl: string; user: PersonBody }
    expect(second.inviteUrl).not.toBe(first.inviteUrl)
    expect((await useLink(testApp, first.inviteUrl, { password: NEW_PASSWORD })).status).toBe(410)
    expect((await useLink(testApp, second.inviteUrl, { password: NEW_PASSWORD })).status).toBe(302)

    const after = await testApp.app.request(`/api/v1/users/${first.user.id}/invite`, json('POST', {}, admin))
    expect(after.status).toBe(409)
    expect(await after.json()).toEqual({ error: 'not_invited' })
  })
})

describe('changing a person — PATCH /api/v1/users/:id', () => {
  it('changes a role, effective on the next request', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const userId = createPerson(testApp)
    const user = operatorAuth(testApp, userId)
    expect((await testApp.app.request('/api/v1/webhooks', as(user))).status).toBe(403)

    const res = await testApp.app.request(`/api/v1/users/${userId}`, json('PATCH', { role: 'admin' }, admin))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: PersonBody }).user).toMatchObject({ id: userId, role: 'admin', status: 'active' })
    expect((await testApp.app.request('/api/v1/webhooks', as(user))).status).toBe(200)
  })

  it('refuses changing yourself', async () => {
    const testApp = createTestApp()
    const { admin, adminId } = await adminAndId(testApp)
    createPerson(testApp, { role: 'admin' })
    for (const patch of [{ role: 'user' }, { disabled: true }]) {
      const res = await testApp.app.request(`/api/v1/users/${adminId}`, json('PATCH', patch, admin))
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'cannot_change_self' })
    }
  })

  it('never leaves the instance without an admin who has access', () => {
    const testApp = createTestApp()
    const onlyAdmin = createPerson(testApp, { email: 'only@example.com', role: 'admin' })
    const other = createPerson(testApp, { email: 'other@example.com', role: 'user' })
    const mode = { policy: ROLES_ON_ACCOUNTS, builtIn: true }
    for (const patch of [{ role: 'user' as const }, { disabled: true }]) {
      expect(updatePerson(testApp.db, mode, other, onlyAdmin, patch)).toEqual({ ok: false, error: 'last_admin' })
    }
    expect(testApp.db.select().from(users).where(eq(users.id, onlyAdmin)).all()[0]).toMatchObject({
      role: 'admin',
      disabledAt: null,
    })
  })

  it('answers 404 for nobody and 400 for a bad body', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const userId = createPerson(testApp)
    expect((await testApp.app.request('/api/v1/users/999', json('PATCH', { role: 'user' }, admin))).status).toBe(404)
    const bad = await testApp.app.request(`/api/v1/users/${userId}`, json('PATCH', { role: 'owner' }, admin))
    expect(bad.status).toBe(400)
    const wrongType = await testApp.app.request(`/api/v1/users/${userId}`, json('PATCH', { disabled: 'yes' }, admin))
    expect(wrongType.status).toBe(400)
  })
})

const countFor = (testApp: TestApp, userId: number) => ({
  apiKeys: testApp.db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).all().length,
  accessTokens: testApp.db.select().from(accessTokens).where(eq(accessTokens.userId, userId)).all().length,
  refreshTokens: testApp.db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).all().length,
  codes: testApp.db.select().from(authorizationCodes).where(eq(authorizationCodes.userId, userId)).all().length,
  push: testApp.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all().length,
})

describe('deactivation', () => {
  /** A user holding one of every credential, and a lead event of theirs. */
  async function equipped(testApp: TestApp) {
    const { admin } = await adminAndId(testApp)
    const userId = createPerson(testApp)
    const pwa = operatorAuth(testApp, userId)
    const { refreshToken } = issueTokens(testApp.db, {
      clientId: FIRST_PARTY_CLIENT_ID,
      userId,
      resource: null,
      scope: 'openid operator',
    })
    const agent = await agentAuth(testApp, userId)
    const key = createApiKey(testApp.db, userId, 'cron').key
    createAuthorizationCode(testApp.db, {
      clientId: FIRST_PARTY_CLIENT_ID,
      userId,
      redirectUri: PWA_REDIRECT,
      codeChallenge: 'x'.repeat(43),
      resource: null,
      scope: 'openid operator',
      nonce: null,
    })
    testApp.db
      .insert(pushSubscriptions)
      .values({ userId, endpoint: 'https://push.example.com/1', p256dh: 'p', auth: 'a' })
      .run()
    const lead = await testApp.app.request('/api/v1/leads', json('POST', { name: 'A lead', email: 'lead@example.com' }, pwa))
    expect(lead.status).toBe(201)
    return { admin, userId, pwa, refreshToken, agent: agent.authorization, key: `Bearer ${key}` }
  }


  it('revokes every credential and keeps what the account did', async () => {
    const testApp = createTestApp()
    const { admin, userId, pwa, refreshToken, agent, key } = await equipped(testApp)
    const eventsBefore = testApp.db.select().from(leadEvents).all()
    expect(eventsBefore.some((event) => event.actor === `user:${userId}`)).toBe(true)

    const res = await testApp.app.request(`/api/v1/users/${userId}`, json('PATCH', { disabled: true }, admin))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: PersonBody }).user.status).toBe('disabled')

    expect(countFor(testApp, userId)).toEqual({ apiKeys: 0, accessTokens: 0, refreshTokens: 0, codes: 0, push: 0 })
    for (const credential of [pwa, agent, key]) {
      expect((await testApp.app.request('/api/v1/leads', as(credential))).status).toBe(401)
    }
    const refreshed = await testApp.app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', client_id: FIRST_PARTY_CLIENT_ID, refresh_token: refreshToken }),
    )
    expect(refreshed.status).toBe(400)
    expect(testApp.db.select().from(leadEvents).all()).toEqual(eventsBefore)
  })

  it('voids pending links, and reactivating restores sign-in but no credential', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { user, inviteUrl } = await invite(testApp, admin)
    expect((await testApp.app.request(`/api/v1/users/${user.id}`, json('PATCH', { disabled: true }, admin))).status).toBe(200)
    expect((await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })).status).toBe(410)

    const back = await testApp.app.request(`/api/v1/users/${user.id}`, json('PATCH', { disabled: false }, admin))
    expect(((await back.json()) as { user: PersonBody }).user.status).toBe('invited')
    // The voided link stays void; a new invite is how they get in.
    expect((await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })).status).toBe(410)
    const reinvited = await testApp.app.request(`/api/v1/users/${user.id}/invite`, json('POST', {}, admin))
    const { inviteUrl: fresh } = (await reinvited.json()) as { inviteUrl: string }
    expect((await useLink(testApp, fresh, { password: NEW_PASSWORD })).status).toBe(302)
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: true })
  })

  it('refuses sign-in while deactivated and does not bring keys back', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { user, inviteUrl } = await invite(testApp, admin)
    await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })
    const key = `Bearer ${createApiKey(testApp.db, user.id, 'cron').key}`

    await testApp.app.request(`/api/v1/users/${user.id}`, json('PATCH', { disabled: true }, admin))
    const refused = await signIn(testApp, 'sam@example.com', NEW_PASSWORD)
    expect(refused).toEqual({ status: 401, code: false })

    await testApp.app.request(`/api/v1/users/${user.id}`, json('PATCH', { disabled: false }, admin))
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: true })
    expect((await testApp.app.request('/api/v1/leads', as(key))).status).toBe(401)
  })
})

describe('reset links — POST /api/v1/users/:id/reset-link', () => {
  it('sets a new password, revokes OAuth grants, and leaves API keys', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { user, inviteUrl } = await invite(testApp, admin)
    await useLink(testApp, inviteUrl, { password: NEW_PASSWORD })
    const pwa = operatorAuth(testApp, user.id)
    const { refreshToken } = issueTokens(testApp.db, {
      clientId: FIRST_PARTY_CLIENT_ID,
      userId: user.id,
      resource: null,
      scope: 'openid operator',
    })
    const key = `Bearer ${createApiKey(testApp.db, user.id, 'cron').key}`

    const before = Date.now()
    const res = await testApp.app.request(`/api/v1/users/${user.id}/reset-link`, json('POST', {}, admin))
    expect(res.status).toBe(200)
    const { resetUrl, expiresAt } = (await res.json()) as { resetUrl: string; expiresAt: string }
    expect(new Date(expiresAt).getTime() - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000)
    // Issuing a link changes nothing yet.
    expect((await testApp.app.request('/api/v1/leads', as(pwa))).status).toBe(200)

    const page = await (await testApp.app.request(pathOf(resetUrl))).text()
    expect(page).not.toContain('name="name"')
    expect((await useLink(testApp, resetUrl, { password: 'the-reset-password!' })).status).toBe(302)

    expect((await testApp.app.request('/api/v1/leads', as(pwa))).status).toBe(401)
    const refreshed = await testApp.app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', client_id: FIRST_PARTY_CLIENT_ID, refresh_token: refreshToken }),
    )
    expect(refreshed.status).toBe(400)
    expect((await testApp.app.request('/api/v1/leads', as(key))).status).toBe(200)
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: false })
    expect(await signIn(testApp, 'sam@example.com', 'the-reset-password!')).toMatchObject({ code: true })
  })

  it('ends an invitation when used instead of the invite: the account is active and cannot be re-invited', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    const { user, inviteUrl } = await invite(testApp, admin)
    const res = await testApp.app.request(`/api/v1/users/${user.id}/reset-link`, json('POST', {}, admin))
    expect(res.status).toBe(200)
    const { resetUrl } = (await res.json()) as { resetUrl: string }
    expect((await useLink(testApp, resetUrl, { password: NEW_PASSWORD })).status).toBe(302)

    expect((await people(testApp, admin)).find((person) => person.id === user.id)).toMatchObject({ status: 'active' })
    const reinvite = await testApp.app.request(`/api/v1/users/${user.id}/invite`, json('POST', {}, admin))
    expect(reinvite.status).toBe(409)
    expect(await reinvite.json()).toEqual({ error: 'not_invited' })
    expect((await useLink(testApp, inviteUrl, { password: 'somebody-else-entirely' })).status).toBe(410)
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: true })
  })

  it('refuses your own account and a deactivated one', async () => {
    const testApp = createTestApp()
    const { admin, adminId } = await adminAndId(testApp)
    const self = await testApp.app.request(`/api/v1/users/${adminId}/reset-link`, json('POST', {}, admin))
    expect(await self.json()).toEqual({ error: 'cannot_change_self' })
    const userId = createPerson(testApp)
    testApp.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId)).run()
    const disabled = await testApp.app.request(`/api/v1/users/${userId}/reset-link`, json('POST', {}, admin))
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toEqual({ error: 'account_disabled' })
  })
})

describe('your own account — /api/v1/account', () => {
  async function signedInPerson(testApp: TestApp) {
    const { admin } = await adminAndId(testApp)
    const { user, inviteUrl } = await invite(testApp, admin)
    await useLink(testApp, inviteUrl, { name: 'Sam', password: NEW_PASSWORD })
    return { admin, userId: user.id, auth: operatorAuth(testApp, user.id) }
  }

  it('reads and renames it', async () => {
    const testApp = createTestApp()
    const { auth, userId } = await signedInPerson(testApp)
    const res = await testApp.app.request('/api/v1/account', as(auth))
    expect(await res.json()).toEqual({
      account: { id: userId, name: 'Sam', email: 'sam@example.com', role: 'user', managedByIdp: false },
    })
    const renamed = await testApp.app.request('/api/v1/account', json('PATCH', { name: '  Samantha ' }, auth))
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as { account: { name: string } }).account.name).toBe('Samantha')
  })

  it('changes the email only with the current password', async () => {
    const testApp = createTestApp()
    const { auth } = await signedInPerson(testApp)
    const without = await testApp.app.request('/api/v1/account', json('PATCH', { email: 'new@example.com' }, auth))
    expect(without.status).toBe(400)
    expect(await without.json()).toEqual({ error: 'wrong_password' })
    const taken = await testApp.app.request(
      '/api/v1/account',
      json('PATCH', { email: ADMIN_EMAIL, currentPassword: NEW_PASSWORD }, auth),
    )
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'email_taken' })
    const ok = await testApp.app.request(
      '/api/v1/account',
      json('PATCH', { email: 'New@Example.com', currentPassword: NEW_PASSWORD }, auth),
    )
    expect(ok.status).toBe(200)
    expect(await signIn(testApp, 'new@example.com', NEW_PASSWORD)).toMatchObject({ code: true })
  })

  it('changes the password with the current one, and signs out the other sessions', async () => {
    const testApp = createTestApp()
    const { userId } = await signedInPerson(testApp)
    const here = issueTokens(testApp.db, { clientId: FIRST_PARTY_CLIENT_ID, userId, resource: null, scope: 'openid operator' })
    // Signed in a moment earlier on another device: a pair is told apart by when it was issued.
    const elsewhere = issueTokens(
      testApp.db,
      { clientId: FIRST_PARTY_CLIENT_ID, userId, resource: null, scope: 'openid operator' },
      new Date(Date.now() - 5000),
    )
    const auth = `Bearer ${here.accessToken}`

    const wrong = await testApp.app.request(
      '/api/v1/account/password',
      json('POST', { currentPassword: 'not-the-password', newPassword: 'another-long-password' }, auth),
    )
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'wrong_password' })
    const short = await testApp.app.request(
      '/api/v1/account/password',
      json('POST', { currentPassword: NEW_PASSWORD, newPassword: 'short' }, auth),
    )
    expect(await short.json()).toEqual({ error: 'invalid_password' })

    const res = await testApp.app.request(
      '/api/v1/account/password',
      json('POST', { currentPassword: NEW_PASSWORD, newPassword: 'another-long-password' }, auth),
    )
    expect(res.status).toBe(204)
    expect(await signIn(testApp, 'sam@example.com', NEW_PASSWORD)).toMatchObject({ code: false })
    expect(await signIn(testApp, 'sam@example.com', 'another-long-password')).toMatchObject({ code: true })

    // This session keeps working; the other one is gone.
    expect((await testApp.app.request('/api/v1/leads', as(auth))).status).toBe(200)
    expect((await testApp.app.request('/api/v1/leads', as(`Bearer ${elsewhere.accessToken}`))).status).toBe(401)
    const refresh = (token: string) =>
      testApp.app.request('/oauth/token', form({ grant_type: 'refresh_token', client_id: FIRST_PARTY_CLIENT_ID, refresh_token: token }))
    expect((await refresh(elsewhere.refreshToken)).status).toBe(400)
    expect((await refresh(here.refreshToken)).status).toBe(200)
  })

  it('voids a pending reset link when the password changes', async () => {
    const testApp = createTestApp()
    const { admin, auth, userId } = await signedInPerson(testApp)
    const issued = await testApp.app.request(`/api/v1/users/${userId}/reset-link`, json('POST', {}, admin))
    const { resetUrl } = (await issued.json()) as { resetUrl: string }
    expect((await testApp.app.request(pathOf(resetUrl))).status).toBe(200)

    const res = await testApp.app.request(
      '/api/v1/account/password',
      json('POST', { currentPassword: NEW_PASSWORD, newPassword: 'another-long-password' }, auth),
    )
    expect(res.status).toBe(204)
    expect((await testApp.app.request(pathOf(resetUrl))).status).toBe(410)
    expect((await useLink(testApp, resetUrl, { password: 'the-reset-password!' })).status).toBe(410)
    expect(await signIn(testApp, 'sam@example.com', 'another-long-password')).toMatchObject({ code: true })
  })
})

describe('the first-boot admin', () => {
  it('can be found by the list and has no pending invite', async () => {
    const testApp = createTestApp()
    const { admin } = await adminAndId(testApp)
    expect((await people(testApp, admin))[0]).toMatchObject({ email: ADMIN_EMAIL, status: 'active' })
    expect(await signIn(testApp, ADMIN_EMAIL, ADMIN_PASSWORD)).toMatchObject({ code: true })
  })
})
