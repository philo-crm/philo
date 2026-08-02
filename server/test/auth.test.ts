import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../src/auth/password.ts'
import { LOGIN_FREE_ATTEMPTS } from '../src/auth/routes.ts'
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
  withServer,
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

  it('throttles setup attempts while the instance is unconfigured, without ever refusing one', async () => {
    const testApp = createTestApp({
      authTuning: { throttle: { freeAttempts: 1, baseDelayMs: 40, maxDelayMs: 160 } },
    })

    // Every attempt counts here, not just failures: there is no account yet to
    // lock anyone out of, and a success retires the endpoint.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await testApp.app.request('/api/v1/auth/setup', jsonPost({ email: 'bad', password: 'short' }))
      expect(res.status).toBe(400)
    }

    // Slower by now, but the operator still gets their account — the whole point
    // of throttling instead of capping.
    const started = performance.now()
    const created = await testApp.app.request(
      '/api/v1/auth/setup',
      jsonPost({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    )
    expect(created.status).toBe(201)
    expect(performance.now() - started).toBeGreaterThan(100)
    expect(testApp.db.select({ id: users.id }).from(users).all()).toHaveLength(1)
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

  it('keeps accepting the correct password however many attempts have failed', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    // The regression this guards: a failure *cap* would refuse the operator here.
    // Philo is behind a proxy in the documented deployment, so every request
    // shares one key — a cap would let any anonymous caller spend a handful of
    // junk requests to deny the only credential the product has.
    for (let attempt = 0; attempt < LOGIN_FREE_ATTEMPTS * 4; attempt += 1) {
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    }

    const recovered = await login(testApp)
    expect(recovered.status).toBe(200)
    expect(sessionCookie(recovered)).toBeDefined()
  })

  it('makes repeated failures progressively slower', async () => {
    // Real delays, small but growing, so the curve is exercised end to end.
    const testApp = createTestApp({
      authTuning: { throttle: { freeAttempts: 1, baseDelayMs: 40, maxDelayMs: 160 } },
    })
    await setupAdmin(testApp)

    const timeOneAttempt = async (): Promise<number> => {
      const started = performance.now()
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
      return performance.now() - started
    }

    await timeOneAttempt() // free
    await timeOneAttempt() // charges the first delay
    await timeOneAttempt()
    const fourth = await timeOneAttempt()

    // By here the delay has doubled at least twice off a 40ms base.
    expect(fourth).toBeGreaterThan(100)
  })

  /**
   * The per-caller half of the login throttle. Behind a proxy every request
   * arrives from the same address, so without `PHILO_TRUSTED_PROXY` one attacker
   * makes every other visitor pay their delay. Over a real socket, because the
   * header is only believed when a private peer vouches for it.
   */
  it('charges a forwarded attacker without slowing anyone else down', async () => {
    const testApp = createTestApp({
      trustProxy: true,
      authTuning: { throttle: { freeAttempts: 0, baseDelayMs: 60, maxDelayMs: 480 } },
    })
    await setupAdmin(testApp)

    await withServer(testApp, async (baseUrl) => {
      // A distinct address per attempt, because the route throttles the email
      // too and the slower of the two keys wins — this test is about the
      // caller key, so the email must not be what carries the delay.
      const attempt = async (forwardedFor: string, email: string): Promise<number> => {
        const started = performance.now()
        const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: baseUrl, 'x-forwarded-for': forwardedFor },
          body: JSON.stringify({ email, password: 'wrong-but-long-enough' }),
        })
        expect(res.status).toBe(401)
        return performance.now() - started
      }

      // The attacker's own delay compounds — every attempt is charged.
      for (let i = 0; i < 4; i += 1) await attempt('203.0.113.7', `attacker${i}@example.com`)
      expect(await attempt('203.0.113.7', 'attacker-again@example.com')).toBeGreaterThan(100)

      // A different visitor's first attempt is not paying for any of it.
      expect(await attempt('198.51.100.42', 'visitor@example.com')).toBeLessThan(100)
    })
  })

  it('clears the accumulated delay after a successful login', async () => {
    const testApp = createTestApp({
      authTuning: { throttle: { freeAttempts: 0, baseDelayMs: 40, maxDelayMs: 160 } },
    })
    await setupAdmin(testApp)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    }
    expect((await login(testApp)).status).toBe(200)

    // A clean slate, so the next failure is charged the base delay rather than
    // resuming where the previous run left off.
    const started = performance.now()
    expect((await login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')).status).toBe(401)
    expect(performance.now() - started).toBeLessThan(120)
  })

  it('charges a concurrent burst for its own size, not once for the whole burst', async () => {
    const testApp = createTestApp({
      authTuning: { throttle: { freeAttempts: 1, baseDelayMs: 20, maxDelayMs: 400 } },
    })
    await setupAdmin(testApp)

    // The regression: counting attempts *after* verifying let every request in a
    // burst read the same low count and pay the same small delay, so parallelism
    // bought an attacker two orders of magnitude over the serial rate.
    const started = performance.now()
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => login(testApp, ADMIN_EMAIL, 'wrong-but-long-enough')),
    )
    const elapsed = performance.now() - started

    for (const res of burst) expect([401, 429]).toContain(res.status)
    // Twelve arrivals past a one-attempt allowance means the later ones are held
    // for a doubling delay; if they all paid the base 20ms this would fly through.
    expect(elapsed).toBeGreaterThan(400)
  })

  it('sheds load rather than queueing unbounded password hashes', async () => {
    const testApp = createTestApp({ authTuning: { maxConcurrentHashes: 1 } })
    await setupAdmin(testApp)

    // Two logins in flight against a single hash slot: one is served, the other is
    // told to come back. A slot frees in milliseconds, so this cannot lock anyone
    // out the way a failure cap would.
    const [first, second] = await Promise.all([login(testApp), login(testApp)])
    const statuses = [first.status, second.status].toSorted()
    expect(statuses).toEqual([200, 429])

    // And the very next attempt succeeds, because the slot is already free again.
    expect((await login(testApp)).status).toBe(200)
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

    const res = await testApp.app.request('/api/v1/auth/logout', jsonPost({}, { cookie }))
    expect(res.status).toBe(204)
    expect(sessionCookieAttributes(res)).toContain('Max-Age=0')
    expect(testApp.db.select({ tokenHash: sessions.tokenHash }).from(sessions).all()).toHaveLength(0)

    // The cookie is dead server-side, not just forgotten by the client.
    const reused = await testApp.app.request('/api/v1/auth/session', { headers: { cookie } })
    expect(reused.status).toBe(401)
  })

  it('succeeds without a session, so a client can always drop a stale cookie', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/logout', jsonPost({}))
    expect(res.status).toBe(204)
  })

  it('requires the JSON content type like every other state-changing route', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: TEST_ORIGIN },
    })
    expect(res.status).toBe(415)
    // The session survives, because the request never reached the handler.
    expect(testApp.db.select({ tokenHash: sessions.tokenHash }).from(sessions).all()).toHaveLength(1)
  })

  it('leaves other sessions alone', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const first = sessionCookie(await login(testApp))
    const second = sessionCookie(await login(testApp))
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    await testApp.app.request('/api/v1/auth/logout', jsonPost({}, { cookie: first as string }))

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

  it('rejects a state-changing request that is not JSON, before any handler sees it', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN },
      body: 'email=admin@example.com&password=correct-horse-battery-staple',
    })
    // Same-origin, so `csrf()` allows it; the JSON requirement stops it anyway,
    // and it does so in middleware so no route can forget to check.
    expect(res.status).toBe(415)
    await expect(res.json()).resolves.toEqual({ error: 'expected_json' })
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
    testApp.app.get('/api/v1/later', (c) => c.json({ later: true }))
    const cookie = await setupAdmin(testApp)

    const anonymous = await testApp.app.request('/api/v1/later')
    expect(anonymous.status).toBe(401)
    await expect(anonymous.json()).resolves.toEqual({ error: 'unauthorized' })

    const authenticated = await testApp.app.request('/api/v1/later', { headers: { cookie } })
    expect(authenticated.status).toBe(200)
    await expect(authenticated.json()).resolves.toEqual({ later: true })
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
