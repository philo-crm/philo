import { getConnInfo } from '@hono/node-server/conninfo'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import {
  clearSessionCookie,
  currentUser,
  readSessionCookie,
  requireAuth,
  writeSessionCookie,
  type AuthDeps,
  type AuthEnv,
} from './middleware.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password.ts'
import { FailureLimiter } from './rate-limit.ts'
import { createSession, deleteSession, type SessionUser } from './session.ts'

/** Failed logins tolerated per key before a key gets 429s for the rest of the window. */
export const LOGIN_FAILURE_LIMIT = 10
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/** RFC 5321's practical ceiling; also stops a giant string reaching the database. */
const MAX_EMAIL_LENGTH = 254

interface UserResponse {
  id: number
  email: string
  name: string | null
}

function toUserResponse(user: SessionUser): UserResponse {
  return { id: user.id, email: user.email, name: user.name }
}

/**
 * Requiring `application/json` is the third CSRF layer, behind the SameSite
 * cookie and the origin check in `csrf()`: a cross-origin form can be POSTed
 * without JavaScript, but it cannot set this content type, and a `fetch` that
 * can must first survive a CORS preflight this server never answers.
 */
async function readJsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) return undefined
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

/**
 * Deliberately loose. The only real validation for an email address is sending to
 * it, and this MVP's guardrail is minimal PII rather than deliverability — so
 * this rejects the shapes that are certainly mistakes and nothing more.
 */
function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Lowercased on the way in because SQLite's unique index is case-sensitive:
  // without this, Admin@example.com and admin@example.com are two accounts.
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined
  return email
}

function validatePassword(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) return undefined
  return raw
}

function optionalName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name.length > 0 ? name : null
}

/**
 * Rate-limit key for the caller. Behind a reverse proxy every request arrives
 * from the proxy, so this collapses to one bucket for the whole deployment;
 * per-IP fidelity there needs a trusted-proxy setting Philo does not model yet.
 * The per-email key below is what keeps that case from being useless.
 */
function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // No socket behind the request — `app.request()` in tests, for one.
    return 'unknown'
  }
}

function hasAnyUser(db: Db): boolean {
  return db.select({ id: users.id }).from(users).limit(1).all().length > 0
}

export function createAuthRoutes(deps: AuthDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()
  // Per app instance, so a test gets a fresh budget and a restart forgives.
  const limiter = new FailureLimiter(LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS)

  /** Drives the first-boot screen: the PWA asks this before rendering anything. */
  routes.get('/status', (c) =>
    c.json({
      needsSetup: !hasAnyUser(deps.db),
      authenticated: c.get('user') !== undefined,
    }),
  )

  routes.post('/setup', async (c) => {
    // Before anything expensive. Without this check up front, every POST to a
    // long-configured instance would still pay for an argon2 hash on the way to
    // its 409 — an unauthenticated amplifier that never closes. The transaction
    // below is what actually makes the decision; this only keeps it cheap.
    if (hasAnyUser(deps.db)) return c.json({ error: 'setup_already_complete' }, 409)

    // Setup is reachable without credentials, so the window before the first
    // account exists is rate limited too. Every attempt counts, not just failed
    // ones: there is no account here to lock anybody out of, and the first
    // success retires the endpoint.
    const setupKey = `setup:${clientKey(c)}`
    const setupCheck = limiter.check(setupKey)
    if (!setupCheck.allowed) return tooManyRequests(c, setupCheck.retryAfterSeconds)
    limiter.recordFailure(setupKey)

    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const email = normalizeEmail(body['email'])
    const password = validatePassword(body['password'])
    if (email === undefined) return c.json({ error: 'invalid_email' }, 400)
    if (password === undefined) {
      return c.json(
        { error: 'invalid_password', minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
        400,
      )
    }

    // Hash before opening the transaction: better-sqlite3 is synchronous, so
    // awaiting inside one would hold it open across the whole hash.
    const passwordHash = await hashPassword(password)
    const name = optionalName(body['name'])

    // The existence check and the insert share a transaction so two racing setup
    // requests cannot both find an empty table and both create an admin.
    const created = deps.db.transaction((tx) => {
      if (tx.select({ id: users.id }).from(users).limit(1).all().length > 0) return undefined
      const [user] = tx
        .insert(users)
        .values({ email, passwordHash, name })
        .returning({ id: users.id, email: users.email, name: users.name })
        .all()
      return user
    })
    if (created === undefined) return c.json({ error: 'setup_already_complete' }, 409)

    const { token } = createSession(deps.db, created.id)
    await writeSessionCookie(c, deps, token)
    return c.json({ user: toUserResponse(created) }, 201)
  })

  routes.post('/login', async (c) => {
    const body = await readJsonBody(c)
    const ipKey = `ip:${clientKey(c)}`

    const ipCheck = limiter.check(ipKey)
    if (!ipCheck.allowed) return tooManyRequests(c, ipCheck.retryAfterSeconds)

    if (body === undefined) {
      limiter.recordFailure(ipKey)
      return c.json({ error: 'invalid_request' }, 400)
    }

    const email = normalizeEmail(body['email'])
    const password = validatePassword(body['password'])
    if (email === undefined || password === undefined) {
      limiter.recordFailure(ipKey)
      // Deliberately not saying which field: the login form is not a place to
      // confirm that an address is or is not a real account.
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    const emailKey = `email:${email}`
    const emailCheck = limiter.check(emailKey)
    if (!emailCheck.allowed) return tooManyRequests(c, emailCheck.retryAfterSeconds)

    const [account] = deps.db
      .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
      .all()

    // Verify even when there is no such account, against a hash that cannot
    // match, so a missing account and a wrong password take the same time.
    const passwordHash = account?.passwordHash ?? (await unmatchableHash())
    const passwordOk = await verifyPassword(passwordHash, password)

    if (account === undefined || !passwordOk) {
      limiter.recordFailure(ipKey)
      limiter.recordFailure(emailKey)
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    limiter.reset(ipKey)
    limiter.reset(emailKey)

    const { token } = createSession(deps.db, account.id)
    await writeSessionCookie(c, deps, token)
    return c.json({ user: toUserResponse(account) })
  })

  /**
   * Public and idempotent: a client holding a cookie the server has forgotten
   * still needs a way to be told to drop it.
   */
  routes.post('/logout', async (c) => {
    const token = await readSessionCookie(c, deps.sessionKey)
    if (token !== undefined) deleteSession(deps.db, token)
    clearSessionCookie(c, deps)
    return c.body(null, 204)
  })

  routes.get('/session', requireAuth, (c) => c.json({ user: toUserResponse(currentUser(c)) }))

  return routes
}

function tooManyRequests(c: Context, retryAfterSeconds: number) {
  c.header('Retry-After', String(retryAfterSeconds))
  return c.json({ error: 'too_many_requests', retryAfterSeconds }, 429)
}

let unmatchable: Promise<string> | undefined

/**
 * A real argon2id hash of a random value nobody can supply, so a login for an
 * address with no account spends the same work as one with a wrong password.
 * Computed once, on first use rather than at module load, and never checked in.
 */
function unmatchableHash(): Promise<string> {
  unmatchable ??= hashPassword(`no-such-account:${randomUUID()}`)
  return unmatchable
}
