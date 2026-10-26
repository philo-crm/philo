import { randomBytes } from 'node:crypto'
import { asc, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { webhooks } from '../db/schema.ts'
import { CHANGE_TYPES, type ChangeEvent, type ChangeType } from '../events/feed.ts'
import { resolveFunnelId } from '../funnels/service.ts'
import { err, ok, type Result } from '../result.ts'

/** Far more integrations than one business wires up; a ceiling so a loop cannot fill the table. */
export const MAX_WEBHOOKS = 50
export const MAX_WEBHOOK_URL_LENGTH = 2_000
export const MAX_AUTH_HEADER_NAME_LENGTH = 100
export const MAX_AUTH_HEADER_VALUE_LENGTH = 4_000
/** Stored per attempt; enough to say what went wrong, not a copy of the response. */
const MAX_ERROR_LENGTH = 300

export type WebhookError =
  | 'not_found'
  | 'invalid_url'
  | 'invalid_funnel'
  | 'invalid_events'
  | 'invalid_auth_header'
  | 'too_many_webhooks'

/** A header the receiver authenticates by, sent on every delivery — ADR-0011. */
export interface AuthHeader {
  name: string
  value: string
}

/**
 * What Philo or the HTTP layer sets on every delivery. A receiver's header
 * replacing one would break the request or the signature it sits beside.
 */
const RESERVED_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
])
/** RFC 9110 field-name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Visible ASCII, spaces and tabs: what a token or key is made of, and nothing Node would refuse to send. */
const HEADER_VALUE = /^[\x20-\x7e\t]+$/

export interface WebhookDelivery {
  at: string
  /** Null when there was no HTTP answer at all. */
  status: number | null
  ok: boolean
  error: string | null
}

export interface WebhookRecord {
  id: number
  url: string
  /** Null: every funnel. */
  funnelId: number | null
  /** Empty: every type. */
  events: ChangeType[]
  /** The header sent beside the signature, by name only; null when there is none. */
  authHeaderName: string | null
  actor: string
  createdAt: string
  lastDelivery: WebhookDelivery | null
}

/** What delivery needs: the record, the key it signs with and the header it sends. */
export interface WebhookTarget {
  id: number
  url: string
  secret: string
  authHeader: AuthHeader | null
}

export interface NewWebhook {
  url?: unknown
  funnelId?: unknown
  events?: unknown
  authHeader?: unknown
}

export interface WebhookPatch {
  authHeader?: unknown
}

type Row = typeof webhooks.$inferSelect

function parseEvents(raw: string): ChangeType[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((type): type is ChangeType => (CHANGE_TYPES as readonly unknown[]).includes(type))
}

function toRecord(row: Row): WebhookRecord {
  return {
    id: row.id,
    url: row.url,
    funnelId: row.pipelineId,
    events: parseEvents(row.events),
    authHeaderName: row.authHeaderName,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
    lastDelivery:
      row.lastAttemptAt === null
        ? null
        : {
            at: row.lastAttemptAt.toISOString(),
            status: row.lastStatus,
            ok: row.lastStatus !== null && row.lastStatus >= 200 && row.lastStatus < 300,
            error: row.lastError,
          },
  }
}

/** http or https, absolute, and no credentials in it — those belong in the receiver's own config. */
function webhookUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_WEBHOOK_URL_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url.toString()
}

function eventTypes(raw: unknown): ChangeType[] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const types: unknown[] = raw
  if (!types.every((type) => (CHANGE_TYPES as readonly unknown[]).includes(type))) return undefined
  return [...new Set(types as ChangeType[])]
}

/** Null for none; undefined when it is not a header Philo can send. */
function authHeader(raw: unknown): AuthHeader | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { name, value } = raw as Record<string, unknown>
  if (typeof name !== 'string' || typeof value !== 'string') return undefined
  const trimmedName = name.trim()
  const trimmedValue = value.trim()
  if (trimmedName.length > MAX_AUTH_HEADER_NAME_LENGTH || !HEADER_NAME.test(trimmedName)) return undefined
  const lower = trimmedName.toLowerCase()
  if (RESERVED_HEADERS.has(lower) || lower.startsWith('x-philo-')) return undefined
  if (trimmedValue.length > MAX_AUTH_HEADER_VALUE_LENGTH || !HEADER_VALUE.test(trimmedValue)) return undefined
  return { name: trimmedName, value: trimmedValue }
}

function toTarget(row: Row): WebhookTarget {
  const header =
    row.authHeaderName === null || row.authHeaderValue === null
      ? null
      : { name: row.authHeaderName, value: row.authHeaderValue }
  return { id: row.id, url: row.url, secret: row.secret, authHeader: header }
}

export function listWebhooks(db: Db): WebhookRecord[] {
  return db.select().from(webhooks).orderBy(asc(webhooks.id)).all().map(toRecord)
}

/** The secret is answered here and never again. */
export function createWebhook(
  db: Db,
  input: NewWebhook,
  actor: string,
): Result<{ webhook: WebhookRecord; secret: string }, WebhookError> {
  const url = webhookUrl(input.url)
  if (url === undefined) return err('invalid_url')
  const events = eventTypes(input.events)
  if (events === undefined) return err('invalid_events')
  const header = authHeader(input.authHeader)
  if (header === undefined) return err('invalid_auth_header')

  let funnelId: number | null = null
  if (input.funnelId !== undefined && input.funnelId !== null) {
    if (!Number.isSafeInteger(input.funnelId) || (input.funnelId as number) <= 0) return err('invalid_funnel')
    const resolved = resolveFunnelId(db, input.funnelId as number)
    if (resolved === undefined) return err('invalid_funnel')
    funnelId = resolved
  }

  if (db.select({ id: webhooks.id }).from(webhooks).all().length >= MAX_WEBHOOKS) return err('too_many_webhooks')

  const secret = `whsec_${randomBytes(24).toString('hex')}`
  const [row] = db
    .insert(webhooks)
    .values({
      url,
      pipelineId: funnelId,
      events: JSON.stringify(events),
      secret,
      authHeaderName: header?.name ?? null,
      authHeaderValue: header?.value ?? null,
      actor,
    })
    .returning()
    .all()
  if (row === undefined) throw new Error('webhook insert returned no row')
  return ok({ webhook: toRecord(row), secret })
}

/** Sets or, with null, removes the header. Nothing else about a registration changes. */
export function updateWebhook(db: Db, id: number, patch: WebhookPatch): Result<WebhookRecord, WebhookError> {
  if (!('authHeader' in patch)) return err('invalid_auth_header')
  const header = authHeader(patch.authHeader)
  if (header === undefined) return err('invalid_auth_header')
  const [row] = db
    .update(webhooks)
    .set({ authHeaderName: header?.name ?? null, authHeaderValue: header?.value ?? null })
    .where(eq(webhooks.id, id))
    .returning()
    .all()
  return row === undefined ? err('not_found') : ok(toRecord(row))
}

export function deleteWebhook(db: Db, id: number): boolean {
  return db.delete(webhooks).where(eq(webhooks.id, id)).run().changes > 0
}

export function findWebhookTarget(db: Db, id: number): WebhookTarget | undefined {
  const [row] = db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1).all()
  return row && toTarget(row)
}

/** Registrations that want this event: its funnel (or the one a lead left), or every funnel. */
export function webhooksFor(db: Db, event: ChangeEvent): WebhookTarget[] {
  const funnels = [event.funnelId, event.data.from?.funnelId].filter((id): id is number => id !== undefined)
  return db
    .select()
    .from(webhooks)
    .where(or(isNull(webhooks.pipelineId), ...funnels.map((id) => eq(webhooks.pipelineId, id))))
    .orderBy(asc(webhooks.id))
    .all()
    .filter((row) => {
      const types = parseEvents(row.events)
      return types.length === 0 || types.includes(event.type)
    })
    .map(toTarget)
}

export function recordDelivery(db: Db, id: number, status: number | null, error: string | null): void {
  db.update(webhooks)
    .set({ lastAttemptAt: new Date(), lastStatus: status, lastError: error?.slice(0, MAX_ERROR_LENGTH) ?? null })
    .where(eq(webhooks.id, id))
    .run()
}
