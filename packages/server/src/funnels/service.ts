import { randomBytes } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { intakeForms, leads, pipelines, stages } from '../db/schema.ts'
import { insertFunnelDefaults } from '../db/seed.ts'
import { MAX_NAME_LENGTH, normalizeEmailAddress } from '../email/settings.ts'
import { err, ok, type Result } from '../result.ts'

export const MAX_FUNNEL_NAME_LENGTH = 80
/** Far more intake flows than one business runs; a ceiling so the selector stays a list. */
export const MAX_FUNNELS = 20
export const MAX_NOTIFY_RECIPIENTS = 20

export type FunnelError =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_from_name'
  | 'invalid_reply_to'
  | 'invalid_notify_recipients'
  | 'too_many_funnels'
  | 'funnel_not_empty'
  | 'last_funnel'

export interface FunnelFormRecord {
  id: number
  name: string
  formKey: string
}

/**
 * A funnel and its scoped settings — ADR-0009. Each setting is an override:
 * empty inherits the instance-wide value.
 */
export interface FunnelRecord {
  id: number
  name: string
  /** The lowest-numbered funnel: what every route that names none acts on. */
  isDefault: boolean
  fromName: string
  replyTo: string
  notifyRecipients: string[]
  /** Every lead in the funnel, spam included — so 0 means the same as deletable. */
  leadCount: number
  forms: FunnelFormRecord[]
  createdAt: string
}

/** What the send path needs from a lead's funnel. */
export interface FunnelEmailSettings {
  id: number
  name: string
  fromName: string
  replyTo: string
  notifyRecipients: string[]
}

export function defaultFunnelId(db: Db): number | undefined {
  const [row] = db.select({ id: pipelines.id }).from(pipelines).orderBy(asc(pipelines.id)).limit(1).all()
  return row?.id
}

/**
 * The funnel a request means: the one it named, or the default when it named
 * none. Undefined when the named one does not exist — never the default in its
 * place, since acting on a funnel the caller did not ask for is the worse error.
 */
export function resolveFunnelId(db: Db, requested: number | undefined): number | undefined {
  if (requested === undefined) return defaultFunnelId(db)
  const [row] = db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.id, requested)).limit(1).all()
  return row?.id
}

/** Parses a `?funnel=` value. `undefined` for absent; `null` for present but not an id. */
export function parseFunnelParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** A malformed stored value reads as no override, so the send path never breaks on it. */
function parseRecipients(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((address): address is string => typeof address === 'string')
}

const FUNNEL_COLUMNS = {
  id: pipelines.id,
  name: pipelines.name,
  fromName: pipelines.fromName,
  replyTo: pipelines.replyTo,
  notifyRecipients: pipelines.notifyRecipients,
  createdAt: pipelines.createdAt,
} as const

export function readFunnelEmailSettings(db: Db, id: number): FunnelEmailSettings | undefined {
  const [row] = db.select(FUNNEL_COLUMNS).from(pipelines).where(eq(pipelines.id, id)).limit(1).all()
  if (row === undefined) return undefined
  return {
    id: row.id,
    name: row.name,
    fromName: row.fromName,
    replyTo: row.replyTo,
    notifyRecipients: parseRecipients(row.notifyRecipients),
  }
}

/** The funnel a lead is in: its current stage's. */
export function funnelOfLead(db: Db, leadId: number): number | undefined {
  const [row] = db
    .select({ id: stages.pipelineId })
    .from(leads)
    .innerJoin(stages, eq(stages.id, leads.currentStageId))
    .where(eq(leads.id, leadId))
    .limit(1)
    .all()
  return row?.id
}

export function listFunnels(db: Db): FunnelRecord[] {
  const rows = db.select(FUNNEL_COLUMNS).from(pipelines).orderBy(asc(pipelines.id)).all()
  const counts = new Map(
    db
      .select({ pipelineId: stages.pipelineId, count: sql<number>`count(${leads.id})` })
      .from(leads)
      .innerJoin(stages, eq(stages.id, leads.currentStageId))
      .groupBy(stages.pipelineId)
      .all()
      .map((row) => [row.pipelineId, row.count]),
  )
  const forms = db
    .select({
      id: intakeForms.id,
      name: intakeForms.name,
      formKey: intakeForms.formKey,
      pipelineId: intakeForms.pipelineId,
    })
    .from(intakeForms)
    .orderBy(asc(intakeForms.id))
    .all()
  const defaultId = rows[0]?.id

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.id === defaultId,
    fromName: row.fromName,
    replyTo: row.replyTo,
    notifyRecipients: parseRecipients(row.notifyRecipients),
    leadCount: counts.get(row.id) ?? 0,
    forms: forms
      .filter((form) => (form.pipelineId ?? defaultId) === row.id)
      .map(({ id, name, formKey }) => ({ id, name, formKey })),
    createdAt: row.createdAt.toISOString(),
  }))
}

export function getFunnel(db: Db, id: number): FunnelRecord | undefined {
  return listFunnels(db).find((funnel) => funnel.id === id)
}

function funnelName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name.length === 0 || name.length > MAX_FUNNEL_NAME_LENGTH) return undefined
  return name
}

/** Same intake-form key shape as migration 0002: 24 random bytes, hex. */
function newFormKey(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Born usable: the default stages, both templates, and an intake form to post
 * to — in one transaction, so no funnel ever exists without a first stage.
 */
export function createFunnel(db: Db, input: { name?: unknown }): Result<FunnelRecord, FunnelError> {
  const name = funnelName(input.name)
  if (name === undefined) return err('invalid_name')

  const created = db.transaction((tx) => {
    const count = tx.select({ id: pipelines.id }).from(pipelines).all().length
    if (count >= MAX_FUNNELS) return undefined
    const [pipeline] = tx.insert(pipelines).values({ name }).returning({ id: pipelines.id }).all()
    if (pipeline === undefined) throw new Error('funnel insert returned no row')
    insertFunnelDefaults(tx, pipeline.id)
    tx.insert(intakeForms)
      .values({ name, formKey: newFormKey(), allowedOrigins: '["*"]', pipelineId: pipeline.id })
      .run()
    return pipeline.id
  })
  if (created === undefined) return err('too_many_funnels')

  const record = getFunnel(db, created)
  return record === undefined ? err('not_found') : ok(record)
}

function optionalText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > max ? undefined : value
}

function recipients(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_NOTIFY_RECIPIENTS) return undefined
  const addresses: string[] = []
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'string') return undefined
    const address = normalizeEmailAddress(entry)
    if (address === undefined) return undefined
    if (!addresses.includes(address)) addresses.push(address)
  }
  return addresses
}

/** Patch semantics: a key left out keeps its stored value; `""` or `[]` clears an override. */
export function updateFunnel(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
): Result<FunnelRecord, FunnelError> {
  const set: Partial<typeof pipelines.$inferInsert> = {}

  if ('name' in patch) {
    const name = funnelName(patch['name'])
    if (name === undefined) return err('invalid_name')
    set.name = name
  }
  if ('fromName' in patch) {
    const fromName = optionalText(patch['fromName'], MAX_NAME_LENGTH)
    if (fromName === undefined) return err('invalid_from_name')
    set.fromName = fromName
  }
  if ('replyTo' in patch) {
    const raw = patch['replyTo']
    if (typeof raw !== 'string') return err('invalid_reply_to')
    const replyTo = raw.trim() === '' ? '' : normalizeEmailAddress(raw)
    if (replyTo === undefined) return err('invalid_reply_to')
    set.replyTo = replyTo
  }
  if ('notifyRecipients' in patch) {
    const addresses = recipients(patch['notifyRecipients'])
    if (addresses === undefined) return err('invalid_notify_recipients')
    set.notifyRecipients = JSON.stringify(addresses)
  }

  if (resolveFunnelId(db, id) === undefined) return err('not_found')
  if (Object.keys(set).length > 0) db.update(pipelines).set(set).where(eq(pipelines.id, id)).run()

  const record = getFunnel(db, id)
  return record === undefined ? err('not_found') : ok(record)
}

/**
 * Delete-if-empty, and never the last one: intake and every unscoped route need
 * a default funnel to land in. Its stages, templates and forms cascade with it,
 * so its form keys stop answering.
 */
export function deleteFunnel(db: Db, id: number): Result<FunnelRecord[], FunnelError> {
  const outcome = db.transaction((tx) => {
    const all = tx.select({ id: pipelines.id }).from(pipelines).all()
    if (!all.some((row) => row.id === id)) return 'not_found' as const
    if (all.length <= 1) return 'last_funnel' as const

    const [occupant] = tx
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(stages, eq(stages.id, leads.currentStageId))
      .where(eq(stages.pipelineId, id))
      .limit(1)
      .all()
    if (occupant !== undefined) return 'funnel_not_empty' as const

    // Forms written before ADR-0009 carry no funnel and mean the default; if
    // this is the default, they are this funnel's, and cascade with it too.
    if (defaultFunnelId(db) === id) {
      tx.delete(intakeForms).where(sql`${intakeForms.pipelineId} IS NULL`).run()
    }
    tx.delete(pipelines).where(eq(pipelines.id, id)).run()
    return 'deleted' as const
  })

  if (outcome !== 'deleted') return err(outcome)
  return ok(listFunnels(db))
}
