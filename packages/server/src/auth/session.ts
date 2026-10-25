import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { sessions, users } from '../db/schema.ts'

export const SESSION_COOKIE_NAME = 'philo_session'

/** DESIGN.md (Auth and access): a ~30-day rolling session. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How much of the window must elapse before a request pushes expiry out again.
 * Rolling the expiry on literally every request would mean a write per request
 * for no practical gain.
 */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000

const TOKEN_BYTES = 32

export interface SessionUser {
  id: number
  email: string
  name: string | null
}

export interface ResolvedSession {
  user: SessionUser
  expiresAt: Date
  /** True when this lookup pushed expiry out, so the caller re-sends the cookie. */
  renewed: boolean
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * SHA-256 rather than argon2: the token is 256 bits we generated ourselves, so
 * there is no dictionary to slow an attacker down through — and every
 * authenticated request pays this cost.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Returns the bearer token to hand the client. Only its hash is stored. */
export function createSession(db: Db, userId: number, now = new Date()): { token: string; expiresAt: Date } {
  // Logins are rare and `sessions_expires_at_idx` makes this cheap, so it is a
  // natural place to keep dead rows from accumulating forever.
  deleteExpiredSessions(db, now)

  const token = generateSessionToken()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  db.insert(sessions).values({ tokenHash: hashSessionToken(token), userId, createdAt: now, expiresAt }).run()
  return { token, expiresAt }
}

/**
 * Looks up a session by token and rolls its expiry forward. Returns undefined
 * for an unknown or expired token; an expired row is deleted on the way out so a
 * stale cookie cannot keep resurrecting it.
 */
export function resolveSession(db: Db, token: string, now = new Date()): ResolvedSession | undefined {
  const tokenHash = hashSessionToken(token)
  const [row] = db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)
    .all()

  if (row === undefined) return undefined

  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run()
    return undefined
  }

  const user: SessionUser = { id: row.id, email: row.email, name: row.name }
  // `expiresAt - TTL` is when expiry was last written, so this measures how long
  // ago that was without storing a second timestamp.
  const setAt = row.expiresAt.getTime() - SESSION_TTL_MS
  if (now.getTime() - setAt < SESSION_RENEW_AFTER_MS) {
    return { user, expiresAt: row.expiresAt, renewed: false }
  }

  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash)).run()
  return { user, expiresAt, renewed: true }
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run()
}

export function deleteExpiredSessions(db: Db, now = new Date()): void {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
}
