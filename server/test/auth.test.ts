import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../src/auth/password.ts'
import { LOGIN_FAILURE_LIMIT } from '../src/auth/routes.ts'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, hashSessionToken } from '../src/auth/session.ts'
import { sessions, users } from '../src/db/schema.ts'
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  cleanupTestApps,
  createTestApp,
  jsonPost,
  login,
  sessionCookie,
  sessionCookieAttributes,
  setupAdmin,
  TEST_ORIGIN,
  type TestApp,
} from './support/app.ts'

afterEach(cleanupTestApps)

describe('setup → login → guarded route', () => {
  it('completes the round-trip and rejects the same route unauthenticated', async () => {
    const testApp = createTestApp()

    // A fresh database reports that it needs setup.
    const before = await testApp.app.request('/api/v1/auth/status')
    expect(before.status).toBe(200)
    await expect(before.json()).resolves.toEqual({ needsSetup: true, authenticated: false })

    // Setup creates the admin and signs them in.
    const setup = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' }),
    )
    expect(setup.status).toBe(201)
    await expect(setup.json()).resolves.toEqual({
      user: { id: expect.any(Number), email: ADMIN_EMAIL, name: 'Admin' },
    })

    // The guarded route refuses an anonymous caller...
    const anonymous = await testApp.app.request('/api/v1/auth/session')
    expect(anonymous.status).toBe(401)
    await expect(anonymous.json()).resolves.toEqual({ error: 'unauthorized' })

    // ...and serves the cookie the setup response handed back.
    const setupCookie = sessionCookie(setup)
    expect(setupCookie).toBeDefined()
    const withSetupCookie = await testApp.app.request('/api/v1/auth/session', {
      headers: { cookie: setupCookie as string },
    })
    expect(withSetupCookie.status).toBe(200)
    await expect(withSetupCookie.json()).resolves.toEqual({
      user: { id: expect.any(Number), email: ADMIN_EMAIL, name: 'Admin' },
    })

    // A separate login produces an independently usable session.
    const loggedIn = await login(testApp)
    expect(loggedIn.status).toBe(200)
    const loginCookie = sessionCookie(loggedIn)
    expect(loginCookie).toBeDefined()

    const guarded = await testApp.app.request('/api/v1/auth/session', {
      headers: { cookie: loginCookie as string },
    })
    expect(guarded.status).toBe(200)

    // And status now reports a configured, signed-in instance.
    const after = await testApp.app.request('/api/v1/auth/status', {
      headers: { cookie: loginCookie as string },
    })
    await expect(after.json()).resolves.toEqual({ needsSetup: false, authenticated: true })
  })
})

describe('POST /api/v1/auth/setup', () => {
  it('is blocked once a user exists', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const second = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: 'intruder@example.com', password: 'another-long-password' }),
    )
    expect(second.status).toBe(409)
    await expect(second.json()).resolves.toEqual({ error: 'setup_already_complete' })
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(1)
  })

  it('rejects a password under the minimum length', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: 'short' }),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_password',
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: MAX_PASSWORD_LENGTH,
    })
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(0)
  })

  it('rejects a password over the maximum, rather than hashing it', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }),
    )
    expect(res.status).toBe(400)
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(0)
  })

  it('refuses a configured instance before doing any password hashing', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    // A 409 that arrives without a valid body at all proves the already-complete
    // check runs before the request is parsed, let alone hashed — otherwise this
    // endpoint would stay an unauthenticated argon2 amplifier forever.
    const res = await testApp.app.request('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
      body: 'not json at all',
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'setup_already_complete' })
  })

  it('rate limits setup attempts while the instance is still unconfigured', async () => {
    const testApp = createTestApp()

    // Every attempt counts here, not just failures: there is no account yet to
    // lock anyone out of, and a success retires the endpoint.
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      const res = await testApp.app.request('/api/v1/auth/setup', jsonPost({ email: 'bad', password: 'short' }))
      expect(res.status).toBe(400)
    }

    const limited = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    )
    expect(limited.status).toBe(429)
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(0)
  })

  it.each(['', 'not-an-email', 'missing@tld', 'spaces in@example.com'])(
    'rejects %j as an email',
    async (email) => {
      const testApp = createTestApp()
      const res = await testApp.app.request('/api/v1/auth/setup', jsonPost({ email, password: ADMIN_PASSWORD }))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'invalid_email' })
    },
  )

  it('stores the password as an argon2id hash, never in the clear', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const [account] = testApp.db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).all()
    expect(account).toBeDefined()
    expect(account?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(account?.passwordHash).not.toContain(ADMIN_PASSWORD)
  })

  it('normalizes the email so case cannot create a second account', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp, 'Admin@Example.COM')

    const [account] = testApp.db.select({ email: users.email }).from(users).all()
    expect(account?.email).toBe('admin@example.com')

    // The lowercased form is what logs in.
    expect((await login(testApp, 'admin@example.com')).status).toBe(200)
    // ...and so is the form the operator typed, because login normalizes too.
    expect((await login(testApp, 'Admin@Example.COM')).status).toBe(200)
  })
})

describe('POST /api/v1/auth/login', () => {
  it('rejects a wrong password without revealing that the account exists', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const wrongPassword = await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')
    const noSuchAccount = await login(testApp, 'nobody@example.com', 'wrong-but-long-enough')

    expect(wrongPassword.status).toBe(401)
    expect(noSuchAccount.status).toBe(401)
    await expect(wrongPassword.json()).resolves.toEqual({ error: 'invalid_credentials' })
    await expect(noSuchAccount.json()).resolves.toEqual({ error: 'invalid_credentials' })
    expect(sessionCookie(wrongPassword)).toBeUndefined()
  })

  it('stops accepting attempts once the failure limit is reached', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    }

    const limited = await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    // The limit holds even against the correct password: an attacker must not be
    // able to keep guessing just because one guess happens to land.
    expect((await login(testApp)).status).toBe(429)
  })

  it('clears the failure budget after a successful login', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    }
    expect((await login(testApp)).status).toBe(200)

    // Back to a full budget rather than one attempt from a lockout.
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    }
  })
})

describe('session cookie', () => {
  it('is httpOnly, SameSite=Lax, and scoped to the whole site', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const attributes = sessionCookieAttributes(await login(testApp))

    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('SameSite=Lax')
    expect(attributes).toContain('Path=/')
    expect(attributes).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
  })

  it('is marked Secure when the deployment is https', async () => {
    const testApp = createTestApp({ cookieSecure: true })
    await setupAdmin(testApp)
    expect(sessionCookieAttributes(await login(testApp))).toContain('Secure')
  })

  it('is not marked Secure on a plain-http deployment, which would never send it back', async () => {
    const testApp = createTestApp({ cookieSecure: false })
    await setupAdmin(testApp)
    expect(sessionCookieAttributes(await login(testApp))).not.toContain('Secure')
  })

  it('stores only a hash of the token, so the database cannot yield a live session', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length)

    const stored = testApp.db.select({ tokenHash: sessions.tokenHash }).from(sessions).all()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.tokenHash).not.toBe(token)
    // The signed cookie is `<token>.<signature>`; the stored hash covers the token.
    const [rawToken] = token.split('.')
    expect(stored[0]?.tokenHash).toBe(hashSessionToken(decodeURIComponent(rawToken as string)))
  })

  it('rejects a tampered signature', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const forged = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`
    const res = await testApp.app.request('/api/v1/auth/session', { headers: { cookie: forged } })
    expect(res.status).toBe(401)
  })

  it('rejects a well-formed token that was never issued', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/auth/session', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=made-up-token` },
    })
    expect(res.status).toBe(401)
  })
})

describe('rolling expiry', () => {
  it('leaves expiry alone on a request inside the renewal interval', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [before] = testApp.db.select({ expiresAt: sessions.expiresAt }).from(sessions).all()

    const res = await testApp.app.request('/api/v1/auth/session', { headers: { cookie } })
    expect(res.status).toBe(200)
    // No fresh Set-Cookie, so no write happened either.
    expect(sessionCookie(res)).toBeUndefined()

    const [after] = testApp.db.select({ expiresAt: sessions.expiresAt }).from(sessions).all()
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime())
  })

  it('pushes expiry out and re-sends the cookie once the interval has passed', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    // Backdate the row so it looks like the session was last extended days ago.
    const staleExpiry = new Date(Date.now() + SESSION_TTL_MS - 5 * 24 * 60 * 60 * 1000)
    testApp.db.update(sessions).set({ expiresAt: staleExpiry }).run()

    const res = await testApp.app.request('/api/v1/auth/session', { headers: { cookie } })
    expect(res.status).toBe(200)
    // The browser's copy has to move with the row, or it expires while the row lives.
    expect(sessionCookie(res)).toBeDefined()

    const [after] = testApp.db.select({ expiresAt: sessions.expiresAt }).from(sessions).all()
    expect(after?.expiresAt.getTime()).toBeGreaterThan(staleExpiry.getTime())
  })

  it('lets a stale cookie holder log in again', async () => {
    const testApp = createTestApp()
    const stale = await setupAdmin(testApp)
    testApp.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run()

    // The middleware clears the dead cookie and the handler sets a live one, so
    // the response carries two Set-Cookie lines for the same name. The live one
    // has to be the one that sticks, or logging in after an expiry never works.
    const res = await testApp.app.request(
      '/api/v1/auth/login',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { cookie: stale }),
    )
    expect(res.status).toBe(200)

    const fresh = sessionCookie(res)
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(stale)
    const reused = await testApp.app.request('/api/v1/auth/session', { headers: { cookie: fresh as string } })
    expect(reused.status).toBe(200)
  })

  it('refuses an expired session and deletes the row behind it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    testApp.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run()

    const res = await testApp.app.request('/api/v1/auth/session', { headers: { cookie } })
    expect(res.status).toBe(401)
    expect(testApp.db.select({ tokenHash: sessions.tokenHash }).from(sessions).all()).toHaveLength(0)
    // The stale cookie is cleared so the browser stops presenting it.
    expect(sessionCookieAttributes(res)).toContain('Max-Age=0')
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: TEST_ORIGIN },
    })
    expect(res.status).toBe(204)
    expect(sessionCookieAttributes(res)).toContain('Max-Age=0')
    expect(testApp.db.select({ tokenHash: sessions.tokenHash }).from(sessions).all()).toHaveLength(0)

    // The cookie is dead server-side, not just forgotten by the client.
    const reused = await testApp.app.request('/api/v1/auth/session', { headers: { cookie } })
    expect(reused.status).toBe(401)
  })

  it('succeeds without a session, so a client can always drop a stale cookie', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { origin: TEST_ORIGIN },
    })
    expect(res.status).toBe(204)
  })

  it('leaves other sessions alone', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const first = sessionCookie(await login(testApp))
    const second = sessionCookie(await login(testApp))
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    await testApp.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: first as string, origin: TEST_ORIGIN },
    })

    expect((await testApp.app.request('/api/v1/auth/session', { headers: { cookie: first as string } })).status).toBe(401)
    expect((await testApp.app.request('/api/v1/auth/session', { headers: { cookie: second as string } })).status).toBe(200)
  })
})

async function crossOriginFormPost(testApp: TestApp, path: string): Promise<Response> {
  return testApp.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
    body: 'email=admin@example.com&password=correct-horse-battery-staple',
  })
}

describe('CSRF protection', () => {
  it.each(['/api/v1/auth/login', '/api/v1/auth/setup', '/api/v1/auth/logout'])(
    'rejects a cross-origin form POST to %s',
    async (path) => {
      const testApp = createTestApp()
      await setupAdmin(testApp)
      expect((await crossOriginFormPost(testApp, path)).status).toBe(403)
    },
  )

  it('rejects a cross-origin form POST to a guarded route even with a valid cookie', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/leads', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        origin: 'https://evil.example.com',
        cookie,
      },
      body: '--x--',
    })
    expect(res.status).toBe(403)
  })

  it('rejects a state-changing request that is not JSON, so a form post cannot reach a handler', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN },
      body: 'email=admin@example.com&password=correct-horse-battery-staple',
    })
    // Same-origin, so `csrf()` allows it; the handler still refuses a non-JSON body.
    expect(res.status).toBe(400)
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(0)
  })

  it('allows a same-origin JSON POST', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    )
    expect(res.status).toBe(201)
  })

  it('leaves safe methods alone', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/status', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
  })
})

describe('body limit', () => {
  it('refuses an oversized body on an unauthenticated endpoint', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/api/v1/auth/login',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, padding: 'x'.repeat(64 * 1024) }),
    )
    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual({ error: 'payload_too_large' })
  })
})

describe('route guard', () => {
  it('guards a route added after createApp, without a per-route opt-in', async () => {
    const testApp = createTestApp()
    // Registered before the first request: Hono freezes its router once one arrives.
    testApp.app.get('/api/v1/leads', (c) => c.json({ leads: [] }))
    const cookie = await setupAdmin(testApp)

    const anonymous = await testApp.app.request('/api/v1/leads')
    expect(anonymous.status).toBe(401)
    await expect(anonymous.json()).resolves.toEqual({ error: 'unauthorized' })

    const authenticated = await testApp.app.request('/api/v1/leads', { headers: { cookie } })
    expect(authenticated.status).toBe(200)
    await expect(authenticated.json()).resolves.toEqual({ leads: [] })
  })

  it('answers unauthenticated API requests in JSON rather than the app shell', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/leads')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('still serves the app shell unauthenticated, which is what renders the login screen', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/leads/42')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('leaves /version public, so healthchecks work before setup', async () => {
    const testApp = createTestApp()
    expect((await testApp.app.request('/version')).status).toBe(200)
  })
})
