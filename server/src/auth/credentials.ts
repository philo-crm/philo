import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password.ts'
import type { SessionUser } from './session.ts'

/** RFC 5321's practical ceiling; also stops a giant string reaching the database. */
const MAX_EMAIL_LENGTH = 254

/**
 * Deliberately loose. The only real validation for an email address is sending to
 * it, and this MVP's guardrail is minimal PII rather than deliverability — so
 * this rejects the shapes that are certainly mistakes and nothing more.
 */
export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Lowercased on the way in because SQLite's unique index is case-sensitive:
  // without this, Admin@example.com and admin@example.com are two accounts.
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined
  return email
}

export function validatePassword(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) return undefined
  return raw
}

/**
 * The account behind an email and password, or undefined.
 *
 * Shared by the two places a password is checked — the login route and the
 * OAuth consent page — so both get the same constant-time behaviour rather than
 * one of them growing a subtly cheaper version.
 *
 * Callers hold a `ConcurrencyGate` slot around this: argon2id is deliberately
 * expensive in memory, and both callers are reachable without credentials.
 */
export async function verifyCredentials(
  db: Db,
  email: string,
  password: string,
): Promise<SessionUser | undefined> {
  const [found] = db
    .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all()

  // Verify even when there is no such account, against a hash that cannot
  // match, so a missing account and a wrong password take the same time.
  const ok = await verifyPassword(found?.passwordHash ?? (await unmatchableHash()), password)
  if (found === undefined || !ok) return undefined
  return { id: found.id, email: found.email, name: found.name }
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
