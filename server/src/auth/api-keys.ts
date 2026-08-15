import { createHash, randomBytes } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { apiKeys } from '../db/schema.ts'

/** DESIGN.md (Auth and access). Also what makes a leaked key greppable. */
export const API_KEY_PREFIX = 'philo_'

const SECRET_BYTES = 32

/**
 * How much of the secret the stored prefix keeps, so a list can tell two keys
 * apart. Six of 43 base64url characters leaves ~220 bits unshown, which is
 * still far past anything guessable.
 */
const DISPLAY_CHARS = 6

export const MAX_API_KEY_NAME_LENGTH = 80

/**
 * How stale `last_used_at` is allowed to get. Writing it on literally every
 * request would put a write in front of every read an agent makes, and the
 * question the column answers — "is this key still in use" — does not need
 * better than hourly. Same trade as SESSION_RENEW_AFTER_MS.
 */
export const API_KEY_LAST_USED_RESOLUTION_MS = 60 * 60 * 1000

export interface ApiKeyRecord {
  id: number
  name: string
  keyPrefix: string
  createdAt: Date
  lastUsedAt: Date | null
}

/** Who the timeline records for a headless caller — `api_key:<id>`. */
export interface ApiKeyPrincipal {
  id: number
  name: string
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
}

/**
 * SHA-256, not argon2, for the same reason session tokens use it: the secret is
 * 256 bits this server generated, so there is no dictionary to slow an attacker
 * down through, and every authenticated request would pay the argon2 cost.
 *
 * CodeQL reads the `Key` in the name and calls this a password hash
 * (js/insufficient-password-hash). It is not: a slow KDF exists to make
 * guessing a human-chosen secret expensive, and nothing here is human-chosen —
 * the input is `generateApiKey`'s CSPRNG output and cannot be anything else.
 * `hashSessionToken` is the same call for the same reason and goes unflagged
 * only because "token" does not trip the heuristic. An inline
 * `// codeql[...]` suppression was tried and is not honoured by code scanning,
 * so the alert has to be dismissed as a false positive in the repo's security
 * tab; this comment is the justification for doing so.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** The leading characters a list can show for a key nobody can read again. */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + DISPLAY_CHARS)
}

export function validateApiKeyName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name.length === 0 || name.length > MAX_API_KEY_NAME_LENGTH) return undefined
  return name
}

export interface CreatedApiKey {
  record: ApiKeyRecord
  /** The only time the secret exists outside the caller's hands. Never stored. */
  key: string
}

export function createApiKey(db: Db, name: string, now = new Date()): CreatedApiKey {
  const key = generateApiKey()
  const [row] = db
    .insert(apiKeys)
    .values({
      name,
      keyHash: hashApiKey(key),
      keyPrefix: apiKeyDisplayPrefix(key),
      createdAt: now,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .all()
  if (row === undefined) throw new Error('api key insert returned no row')
  return { record: row, key }
}

/** Newest first: the one just created is the one being looked for. */
export function listApiKeys(db: Db): ApiKeyRecord[] {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.id))
    .all()
}

/** True when a row was actually removed, so a repeat revoke can answer 404. */
export function revokeApiKey(db: Db, id: number): boolean {
  return db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id }).all().length > 0
}

/**
 * The key behind a presented secret, or undefined. Revocation is a row delete,
 * so a revoked key stops resolving on the very next request — there is no
 * cached token to outlive it.
 */
export function resolveApiKey(db: Db, key: string, now = new Date()): ApiKeyPrincipal | undefined {
  // Cheap reject before touching the database: anything without the prefix is
  // not one of ours, and the bearer header is attacker-controlled.
  if (!key.startsWith(API_KEY_PREFIX)) return undefined

  const [row] = db
    .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(key)))
    .limit(1)
    .all()
  if (row === undefined) return undefined

  const stale =
    row.lastUsedAt === null ||
    now.getTime() - row.lastUsedAt.getTime() >= API_KEY_LAST_USED_RESOLUTION_MS
  if (stale) db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)).run()

  return { id: row.id, name: row.name }
}
