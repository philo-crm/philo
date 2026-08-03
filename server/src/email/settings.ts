import { inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { settings } from '../db/schema.ts'
import { err, ok, type Result } from '../result.ts'

/** RFC 5321's practical ceiling, matching auth/routes.ts and leads/service.ts. */
export const MAX_EMAIL_LENGTH = 254
export const MAX_HOST_LENGTH = 255
export const MAX_USERNAME_LENGTH = 255
/** Provider tokens are the long case here — an app password is ~20 characters. */
export const MAX_PASSWORD_LENGTH = 512
export const MAX_NAME_LENGTH = 200

/**
 * Submission over STARTTLS. Port 465 is the implicit-TLS alternative and wants
 * `smtpSecure` with it; every provider in the quick-start docs offers both.
 */
export const DEFAULT_SMTP_PORT = 587

/**
 * Namespaced keys in the `settings` table — DESIGN.md (Architecture): env vars
 * carry what the process needs before it can serve, everything else lives here
 * and is editable in the UI. The prefix is what keeps a later settings section
 * from colliding with this one.
 */
const KEYS = {
  smtpHost: 'email.smtp_host',
  smtpPort: 'email.smtp_port',
  smtpSecure: 'email.smtp_secure',
  smtpUsername: 'email.smtp_username',
  smtpPassword: 'email.smtp_password',
  fromName: 'email.from_name',
  fromAddress: 'email.from_address',
  replyTo: 'email.reply_to',
  businessName: 'business.name',
} as const

export interface EmailSettings {
  smtpHost: string
  smtpPort: number
  /** Implicit TLS from the first byte (port 465). False means STARTTLS. */
  smtpSecure: boolean
  smtpUsername: string
  smtpPassword: string
  /** Display name on the From header. Empty sends the bare address. */
  fromName: string
  fromAddress: string
  /** Where replies to the acknowledgment land — DESIGN.md (Email). */
  replyTo: string
  businessName: string
}

/** Everything empty: what a fresh instance has until the operator fills it in. */
export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  smtpHost: '',
  smtpPort: DEFAULT_SMTP_PORT,
  smtpSecure: false,
  smtpUsername: '',
  smtpPassword: '',
  fromName: '',
  fromAddress: '',
  replyTo: '',
  businessName: '',
}

export type EmailSettingsError =
  | 'invalid_smtp_host'
  | 'invalid_smtp_port'
  | 'invalid_smtp_secure'
  | 'invalid_smtp_username'
  | 'invalid_smtp_password'
  | 'invalid_from_name'
  | 'invalid_from_address'
  | 'invalid_reply_to'
  | 'invalid_business_name'

/**
 * Deliberately loose. The only real validation for an email address is sending
 * to it, so this rejects the shapes that are certainly mistakes and nothing
 * more. Lowercased so a stored address matches one typed with different case.
 */
export function normalizeEmailAddress(raw: string): string | undefined {
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined
  return email
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SMTP_PORT
  const port = Number(raw)
  // A value the UI cannot have written means the row was edited by hand; the
  // default is a better answer than refusing to read the settings at all.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_SMTP_PORT
  return port
}

/**
 * Every stored value, with defaults for the rows a fresh database has not
 * written yet. Never throws: this is read on the path that sends a lead's
 * email, and a settings row nobody can parse must not take that path down.
 */
export function readEmailSettings(db: Db): EmailSettings {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)))
    .all()
  const stored = new Map(rows.map((row) => [row.key, row.value]))
  const text = (key: string, fallback = ''): string => stored.get(key) ?? fallback

  return {
    smtpHost: text(KEYS.smtpHost),
    smtpPort: parsePort(stored.get(KEYS.smtpPort)),
    smtpSecure: stored.get(KEYS.smtpSecure) === 'true',
    smtpUsername: text(KEYS.smtpUsername),
    smtpPassword: text(KEYS.smtpPassword),
    fromName: text(KEYS.fromName),
    fromAddress: text(KEYS.fromAddress),
    replyTo: text(KEYS.replyTo),
    businessName: text(KEYS.businessName),
  }
}

/**
 * Whether there is enough to attempt a send. Both halves are needed: a host with
 * no sender identity is refused by every provider, and a From address with no
 * host has nothing to hand it to.
 */
export function isEmailConfigured(config: EmailSettings): boolean {
  return config.smtpHost !== '' && config.fromAddress !== ''
}

function optionalText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > max ? undefined : value
}

/**
 * An optional address: empty clears it, anything else has to look like an
 * address. Returns undefined for a value that is neither.
 */
function optionalAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.trim() === '') return ''
  return normalizeEmailAddress(raw)
}

/**
 * Patch semantics: a key the caller left out keeps its stored value. That is
 * what lets the password stay write-only — the settings screen never receives
 * it, so it cannot send it back, and an empty string is the explicit clear.
 */
export function validateEmailSettings(
  current: EmailSettings,
  patch: Record<string, unknown>,
): Result<EmailSettings, EmailSettingsError> {
  const next = { ...current }

  if ('smtpHost' in patch) {
    const host = optionalText(patch['smtpHost'], MAX_HOST_LENGTH)
    if (host === undefined) return err('invalid_smtp_host')
    next.smtpHost = host
  }
  if ('smtpPort' in patch) {
    const port = patch['smtpPort']
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      return err('invalid_smtp_port')
    }
    next.smtpPort = port as number
  }
  if ('smtpSecure' in patch) {
    if (typeof patch['smtpSecure'] !== 'boolean') return err('invalid_smtp_secure')
    next.smtpSecure = patch['smtpSecure']
  }
  if ('smtpUsername' in patch) {
    const username = optionalText(patch['smtpUsername'], MAX_USERNAME_LENGTH)
    if (username === undefined) return err('invalid_smtp_username')
    next.smtpUsername = username
  }
  if ('smtpPassword' in patch) {
    const password = patch['smtpPassword']
    // Not trimmed: leading and trailing spaces are legal in a password, and
    // silently removing them turns a working credential into a failing one.
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      return err('invalid_smtp_password')
    }
    next.smtpPassword = password
  }
  if ('fromName' in patch) {
    const name = optionalText(patch['fromName'], MAX_NAME_LENGTH)
    if (name === undefined) return err('invalid_from_name')
    next.fromName = name
  }
  if ('fromAddress' in patch) {
    const address = optionalAddress(patch['fromAddress'])
    if (address === undefined) return err('invalid_from_address')
    next.fromAddress = address
  }
  if ('replyTo' in patch) {
    const address = optionalAddress(patch['replyTo'])
    if (address === undefined) return err('invalid_reply_to')
    next.replyTo = address
  }
  if ('businessName' in patch) {
    const name = optionalText(patch['businessName'], MAX_NAME_LENGTH)
    if (name === undefined) return err('invalid_business_name')
    next.businessName = name
  }

  return ok(next)
}

/** One transaction, so a half-written SMTP configuration is never read back. */
export function writeEmailSettings(db: Db, config: EmailSettings): void {
  const values = [
    { key: KEYS.smtpHost, value: config.smtpHost },
    { key: KEYS.smtpPort, value: String(config.smtpPort) },
    { key: KEYS.smtpSecure, value: String(config.smtpSecure) },
    { key: KEYS.smtpUsername, value: config.smtpUsername },
    { key: KEYS.smtpPassword, value: config.smtpPassword },
    { key: KEYS.fromName, value: config.fromName },
    { key: KEYS.fromAddress, value: config.fromAddress },
    { key: KEYS.replyTo, value: config.replyTo },
    { key: KEYS.businessName, value: config.businessName },
  ]

  db.transaction((tx) => {
    for (const row of values) {
      tx.insert(settings)
        .values(row)
        // `$onUpdateFn` only fires for the update builder, so the conflict
        // branch has to stamp the timestamp itself.
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: row.value, updatedAt: new Date() },
        })
        .run()
    }
  })
}
