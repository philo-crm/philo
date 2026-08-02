import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { clientKey } from '../client-key.ts'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { readJsonBody } from '../json-body.ts'
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
import { ConcurrencyGate, FailureThrottle, type ThrottleOptions } from './rate-limit.ts'
import { createSession, deleteSession, type SessionUser } from './session.ts'

/**
 * Failed attempts per key that cost nothing. Above this the next attempt waits,
 * doubling up to the ceiling — see FailureThrottle for why this slows callers
 * down instead of refusing them.
 */
export const LOGIN_FREE_ATTEMPTS = 5
export const LOGIN_BASE_DELAY_MS = 250
export const LOGIN_MAX_DELAY_MS = 2_000
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * Simultaneous password hashes. Node's default libuv threadpool is four, so
 * beyond that a request would queue anyway; this bounds the memory those hashes
 * reserve rather than letting a burst decide it.
 */
export const MAX_CONCURRENT_HASHES = 8

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

function hasAnyUser(db: Db): boolean {
  return db.select({ id: users.id }).from(users).limit(1).all().length > 0
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  windowMs: LOGIN_FAILURE_WINDOW_MS,
  freeAttempts: LOGIN_FREE_ATTEMPTS,
  baseDelayMs: LOGIN_BASE_DELAY_MS,
  maxDelayMs: LOGIN_MAX_DELAY_MS,
}

export interface AuthTuning {
  /** Overridden in tests, which would otherwise spend real seconds asleep. */
  throttle?: Partial<ThrottleOptions>
  maxConcurrentHashes?: number
}

export function createAuthRoutes(deps: AuthDeps, tuning: AuthTuning = {}): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()
  // Per app instance, so a test gets a fresh budget and a restart forgives.
  const throttle = new FailureThrottle({ ...DEFAULT_THROTTLE, ...tuning.throttle })
  const hashGate = new ConcurrencyGate(tuning.maxConcurrentHashes ?? MAX_CONCURRENT_HASHES)

  /** Drives the first-boot screen: the PWA asks this before rendering anything. */
  routes.get('/status', (c) =>
    c.json({
      needsSetup: !hasAnyUser(deps.db),
      authenticated: c.get('user') !== undefined,
    }),
  )

  /**
   * Unauthenticated by design, per DESIGN.md (Auth and access) — which means
   * whoever reaches a fresh instance first becomes its admin, including a scanner
   * that finds it before the operator opens it. Reviewed and accepted rather than
   * overlooked: the window closes at the first success, and it exists only while
   * the instance holds no data, so the worst case is deleting an empty database
   * and starting over. A one-time setup token in the boot log is the standard
   * mitigation if that ever stops being true — do not add one without revisiting
   * the install story in DESIGN.md, since it changes how Philo is set up.
   */
  routes.post('/setup', async (c) => {
    // Before anything expensive. Without this check up front, every POST to a
    // long-configured instance would still pay for an argon2 hash on the way to
    // its 409 — an unauthenticated amplifier that never closes. The transaction
    // below is what actually makes the decision; this only keeps it cheap.
    if (hasAnyUser(deps.db)) return c.json({ error: 'setup_already_complete' }, 409)

    // Setup is reachable without credentials, so the window before the first
    // account exists is throttled too. Every attempt counts here, not just failed
    // ones: there is no account yet to lock anybody out of, and the first success
    // retires the endpoint for good.
    const setupKey = `setup:${clientKey(c, deps.trustProxy)}`
    throttle.recordAttempt(setupKey)
    await delay(throttle.delayFor(setupKey), c.req.raw.signal)

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

    if (!hashGate.tryAcquire()) return tooManyRequests(c, 1)
    let passwordHash: string
    try {
      // Hash before opening the transaction: better-sqlite3 is synchronous, so
      // awaiting inside one would hold it open across the whole hash.
      passwordHash = await hashPassword(password)
    } finally {
      hashGate.release()
    }
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
    const ipKey = `ip:${clientKey(c, deps.trustProxy)}`

    if (body === undefined) {
      throttle.recordAttempt(ipKey)
      await delay(throttle.delayFor(ipKey), c.req.raw.signal)
      return c.json({ error: 'invalid_request' }, 400)
    }

    const email = normalizeEmail(body['email'])
    const password = validatePassword(body['password'])
    if (email === undefined || password === undefined) {
      throttle.recordAttempt(ipKey)
      await delay(throttle.delayFor(ipKey), c.req.raw.signal)
      // Deliberately not saying which field: the login form is not a place to
      // confirm that an address is or is not a real account.
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    // Both keys matter: the address bounds credential stuffing against one
    // account, and the caller bounds someone working through many. The slower of
    // the two wins, and neither can refuse a correct password.
    //
    // Counted before the delay, not after the verify: otherwise every request in
    // a concurrent burst reads the same low count and pays the same small delay.
    const emailKey = `email:${email}`
    throttle.recordAttempt(ipKey)
    throttle.recordAttempt(emailKey)
    await delay(Math.max(throttle.delayFor(ipKey), throttle.delayFor(emailKey)), c.req.raw.signal)

    // Whoever sent this is gone, so there is nobody to answer and no reason to
    // spend a hash. The attempt is already counted, which is the point.
    if (c.req.raw.signal.aborted) return c.json({ error: 'invalid_credentials' }, 401)

    // Shedding here is safe where refusing on attempt count is not: a slot frees
    // the moment a hash finishes, so this outlasts no flood. It does mean a login
    // arriving mid-flood can be told to retry — see the PR notes.
    if (!hashGate.tryAcquire()) return tooManyRequests(c, 1)
    let account: { id: number; email: string; name: string | null } | undefined
    let passwordOk: boolean
    try {
      const [found] = deps.db
        .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .all()

      // Verify even when there is no such account, against a hash that cannot
      // match, so a missing account and a wrong password take the same time.
      passwordOk = await verifyPassword(found?.passwordHash ?? (await unmatchableHash()), password)
      account = found
    } finally {
      hashGate.release()
    }

    if (account === undefined || !passwordOk) {
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    throttle.reset(ipKey)
    throttle.reset(emailKey)

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

/**
 * Waits, but stops early if the caller hangs up. Without the signal an attacker
 * could fire and forget: they release everything while the server keeps a request
 * context and a timer alive for the full delay, once per guess.
 */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined)
  } catch {
    // Aborted. The caller checks the signal; nothing here needs to distinguish.
  }
}

let unmatchable: Promise<string> | undefined

/**
 * A real argon2id hash of a random value nobody can supply, so a login for an
 * address with no account spends the same work as one with a wrong password.
 * Computed once, on first use rather than at module load, and never checked in.
 */
function unmatchableHash(): Promise<string> {
  unmatchable ??= hashPassword(`no-such-account:${randomUUID()}`).catch((error: unknown) => {
    // Caching a rejection would break every later login, not just this one.
    unmatchable = undefined
    throw error
  })
  return unmatchable
}
