import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { leadEvents, leads, stages } from '../db/schema.ts'
import { isWithinDepthLimit } from '../intake/payload.ts'
import { err, ok, type Result } from '../result.ts'

/** Leads per page when the caller does not say, and the ceiling on what it may ask for. */
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/**
 * Longest search string accepted. Past it the search matches nothing rather
 * than being truncated: dropping the tail would quietly widen the result, and a
 * filter that widens itself is the one failure direction a list must not have.
 */
export const MAX_SEARCH_LENGTH = 256

export const MAX_NOTE_LENGTH = 5_000
/** RFC 5321's practical ceiling, matching auth/routes.ts. */
export const MAX_EMAIL_LENGTH = 254
export const MAX_CONTACT_FIELD_LENGTH = 200

/** The note the timeline records when a quarantined lead is promoted. */
export const NOT_SPAM_NOTE = 'Marked as not spam.'

export type LeadError =
  | 'not_found'
  | 'invalid_stage'
  | 'invalid_note'
  | 'invalid_contact'
  | 'invalid_source'
  | 'invalid_fields'
  | 'email_or_phone_required'
  | 'no_stage'

export interface LeadRecord {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  source: string | null
  formId: number | null
  stageId: number
  stageName: string
  isSpam: boolean
  /** The intake payload's non-reserved keys, parsed — see ADR-0003. */
  fields: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface LeadEventRecord {
  id: number
  type: string
  payload: Record<string, unknown>
  actor: string
  createdAt: string
}

export interface LeadDetail extends LeadRecord {
  events: LeadEventRecord[]
}

export interface LeadPage {
  leads: LeadRecord[]
  total: number
  limit: number
  offset: number
}

export interface ListLeadsFilters {
  stageId?: number | undefined
  formId?: number | undefined
  /** Spam is quarantined, so the default list is the non-spam one. */
  isSpam: boolean
  search?: string | undefined
  createdAfter?: Date | undefined
  createdBefore?: Date | undefined
  limit: number
  offset: number
}

/** Values arrive unvalidated — from a REST body today, from an MCP tool call next. */
export interface ContactPatch {
  name?: unknown
  email?: unknown
  phone?: unknown
}

/** A lead entered by hand rather than submitted. Same unvalidated contract. */
export interface CreateLeadInput extends ContactPatch {
  /** Where it came from, in the operator's words — intake stores the form's name here. */
  source?: unknown
  /** Omitted files the lead under the first stage of the funnel, as intake does. */
  stageId?: unknown
  /** Pre-screening answers, the same free-form shape intake stores — see ADR-0003. */
  fields?: unknown
}

/**
 * A search box is not a query language. FTS5's MATCH syntax has operators
 * (`AND`, `NEAR`, `-`, `^`, `:`) and would raise a syntax error on half of what
 * a person types, so the input is reduced to bare tokens and rebuilt as a
 * prefix query — every token must appear, which is FTS5's default conjunction.
 *
 * Quoting each token is what makes the rebuild safe: inside a quoted string
 * FTS5 hands the contents to the tokenizer instead of its parser, so no user
 * input can reach the grammar. Returns undefined when nothing tokenizable was
 * typed — a search for `***` matches nothing, which is not the same as no
 * search at all.
 */
export function toMatchQuery(search: string): string | undefined {
  if (search.length > MAX_SEARCH_LENGTH) return undefined
  const tokens = search.match(/[\p{L}\p{N}_]+/gu)
  if (tokens === null || tokens.length === 0) return undefined
  return tokens.map((token) => `"${token}"*`).join(' ')
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  // Returned as data, never spread or merged: a stored payload can carry a
  // `__proto__` key — see intake/payload.ts (mapSubmission).
  return parsed as Record<string, unknown>
}

const LEAD_COLUMNS = {
  id: leads.id,
  name: leads.name,
  email: leads.email,
  phone: leads.phone,
  source: leads.source,
  formId: leads.formId,
  stageId: leads.currentStageId,
  stageName: stages.name,
  isSpam: leads.isSpam,
  fields: leads.fields,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
} as const

function toRecord(row: {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  source: string | null
  formId: number | null
  stageId: number
  stageName: string
  isSpam: boolean
  fields: string
  createdAt: Date
  updatedAt: Date
}): LeadRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    formId: row.formId,
    stageId: row.stageId,
    stageName: row.stageName,
    isSpam: row.isSpam,
    fields: parseJsonObject(row.fields),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function buildFilters(filters: ListLeadsFilters, match: string | undefined): SQL | undefined {
  const conditions: SQL[] = [eq(leads.isSpam, filters.isSpam)]
  if (filters.stageId !== undefined) conditions.push(eq(leads.currentStageId, filters.stageId))
  if (filters.formId !== undefined) conditions.push(eq(leads.formId, filters.formId))
  if (filters.createdAfter !== undefined) conditions.push(gte(leads.createdAt, filters.createdAfter))
  if (filters.createdBefore !== undefined) conditions.push(lte(leads.createdAt, filters.createdBefore))
  if (match !== undefined) {
    // `leads_fts.rowid` mirrors `leads.id` — see drizzle/0001_leads_fts.sql.
    conditions.push(sql`${leads.id} IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH ${match})`)
  }
  return and(...conditions)
}

/**
 * Ordered newest first, with `id` breaking ties so a page boundary cannot show
 * the same lead twice. Relevance ranking is deliberately not used even when
 * searching: recency is the ordering the funnel is read in, and one ordering
 * that never changes underfoot beats two that do.
 */
export function listLeads(db: Db, filters: ListLeadsFilters): LeadPage {
  // An empty or blank `search` is no search at all — a client that clears its
  // search box still sends the key — so it is not the "matched nothing" case
  // below. Getting that wrong answers the funnel's main screen with "no leads".
  const search = filters.search?.trim() ?? ''
  const match = search.length === 0 ? undefined : toMatchQuery(search)
  // A search that tokenized to nothing matched nothing, which is not the same
  // answer as running the query with no search filter at all.
  if (search.length > 0 && match === undefined) {
    return { leads: [], total: 0, limit: filters.limit, offset: filters.offset }
  }

  const where = buildFilters(filters, match)
  const rows = db
    .select(LEAD_COLUMNS)
    .from(leads)
    .innerJoin(stages, eq(stages.id, leads.currentStageId))
    .where(where)
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(filters.limit)
    .offset(filters.offset)
    .all()

  const [counted] = db
    .select({ total: sql<number>`count(*)` })
    .from(leads)
    .where(where)
    .all()

  return {
    leads: rows.map(toRecord),
    total: counted?.total ?? 0,
    limit: filters.limit,
    offset: filters.offset,
  }
}

function findLead(db: Db, id: number): LeadRecord | undefined {
  const [row] = db
    .select(LEAD_COLUMNS)
    .from(leads)
    .innerJoin(stages, eq(stages.id, leads.currentStageId))
    .where(eq(leads.id, id))
    .limit(1)
    .all()
  return row === undefined ? undefined : toRecord(row)
}

function timeline(db: Db, leadId: number): LeadEventRecord[] {
  return db
    .select({
      id: leadEvents.id,
      type: leadEvents.type,
      payload: leadEvents.payload,
      actor: leadEvents.actor,
      createdAt: leadEvents.createdAt,
    })
    .from(leadEvents)
    .where(eq(leadEvents.leadId, leadId))
    .orderBy(asc(leadEvents.createdAt), asc(leadEvents.id))
    .all()
    .map((event) => ({
      id: event.id,
      type: event.type,
      payload: parseJsonObject(event.payload),
      actor: event.actor,
      createdAt: event.createdAt.toISOString(),
    }))
}

/** The record plus its whole timeline — the shape every action here answers with. */
export function getLead(db: Db, id: number): LeadDetail | undefined {
  const record = findLead(db, id)
  if (record === undefined) return undefined
  return { ...record, events: timeline(db, id) }
}

function requireLead(db: Db, id: number): Result<LeadDetail, LeadError> {
  const detail = getLead(db, id)
  return detail === undefined ? err('not_found') : ok(detail)
}

function trimmedOrNull(value: string, max: number): string | null | undefined {
  if (value.length > max) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * One contact field from the patch: `undefined` for "not being changed", `null`
 * for "cleared", a string for a new value. A value of the wrong type or past
 * the length cap is a validation failure, not a silent drop, so it comes back
 * as the sentinel the caller checks.
 */
const INVALID = Symbol('invalid')

function contactField(raw: unknown, max: number): string | null | undefined | typeof INVALID {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') return INVALID
  const value = trimmedOrNull(raw, max)
  return value === undefined ? INVALID : value
}

/**
 * The `fields` column as JSON, or undefined for a value that cannot be stored.
 * The depth cap is the same one intake applies: the FTS trigger walks this with
 * `json_tree`, and a payload past SQLite's parser limit would turn every later
 * insert into a failed write.
 */
function leadFields(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return '{}'
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const fields = raw as Record<string, unknown>
  return isWithinDepthLimit(fields) ? JSON.stringify(fields) : undefined
}

/**
 * A lead entered rather than submitted — an agent writing up a phone screen, a
 * script importing from elsewhere. `formId` stays null (there is no form behind
 * it) and `isSpam` false (there was no honeypot to trip).
 *
 * Deliberately does not fire the lead-created pipeline that intake fires. Both
 * MVP templates speak to a submission that just arrived (DESIGN.md, Email): the
 * acknowledgment would thank someone for an application they never sent, and the
 * notification would announce a lead to the person whose own agent just filed it.
 * Sending an email nobody asked for is the failure that cannot be taken back.
 */
export function createLead(
  db: Db,
  input: CreateLeadInput,
  actor: string,
): Result<LeadDetail, LeadError> {
  const name = contactField(input.name, MAX_CONTACT_FIELD_LENGTH)
  const email = contactField(input.email, MAX_EMAIL_LENGTH)
  const phone = contactField(input.phone, MAX_CONTACT_FIELD_LENGTH)
  if (name === INVALID || email === INVALID || phone === INVALID) return err('invalid_contact')

  const source = contactField(input.source, MAX_CONTACT_FIELD_LENGTH)
  if (source === INVALID) return err('invalid_source')

  const fields = leadFields(input.fields)
  if (fields === undefined) return err('invalid_fields')

  // Lowercased for the same reason updateLeadContact does it: the unique lookups
  // intake and auth run against this column are case-sensitive.
  const nextEmail = email?.toLowerCase() ?? null
  const nextPhone = phone ?? null
  // The rule intake applies at 422 — a lead nobody can answer is not a lead.
  if (nextEmail === null && nextPhone === null) return err('email_or_phone_required')

  const requested = input.stageId
  if (requested !== undefined && (!Number.isSafeInteger(requested) || (requested as number) <= 0)) {
    return err('invalid_stage')
  }
  const requestedStageId = requested as number | undefined

  const outcome = db.transaction((tx) => {
    // Unnamed files the lead under the funnel's first stage, exactly as intake
    // does — one pipeline in the MVP, ordered by it too so the choice stays
    // deterministic if a second one ever appears.
    const [stage] =
      requestedStageId === undefined
        ? tx
            .select({ id: stages.id })
            .from(stages)
            .orderBy(asc(stages.pipelineId), asc(stages.position), asc(stages.id))
            .limit(1)
            .all()
        : tx.select({ id: stages.id }).from(stages).where(eq(stages.id, requestedStageId)).limit(1).all()
    if (stage === undefined) return requestedStageId === undefined ? 'no_stage' : 'invalid_stage'

    const [lead] = tx
      .insert(leads)
      .values({
        name: name ?? null,
        email: nextEmail,
        phone: nextPhone,
        source: source ?? null,
        currentStageId: stage.id,
        fields,
      })
      .returning({ id: leads.id })
      .all()
    if (lead === undefined) throw new Error('lead insert returned no row')

    // Same transaction as the row it records — DESIGN.md (Data model). `via`
    // names the shape of the caller, not the surface: `actor` already carries
    // which key did it, and REST would write the same thing if it grew a create.
    tx.insert(leadEvents)
      .values({
        leadId: lead.id,
        type: 'created',
        payload: JSON.stringify({ via: 'api' }),
        actor,
      })
      .run()
    return lead.id
  })

  if (typeof outcome === 'string') return err(outcome)
  return requireLead(db, outcome)
}

/**
 * Contact fields only. `fields` is the intake payload as submitted and stays
 * that way; editing it would make the record disagree with what the applicant
 * actually sent.
 *
 * The result must stay contactable — the same rule intake applies at 422, kept
 * here so an edit cannot leave behind a lead nobody can answer. A patch may set
 * email and phone together, so there is always a way through.
 */
export function updateLeadContact(
  db: Db,
  id: number,
  patch: ContactPatch,
): Result<LeadDetail, LeadError> {
  const name = contactField(patch.name, MAX_CONTACT_FIELD_LENGTH)
  const email = contactField(patch.email, MAX_EMAIL_LENGTH)
  const phone = contactField(patch.phone, MAX_CONTACT_FIELD_LENGTH)
  if (name === INVALID || email === INVALID || phone === INVALID) return err('invalid_contact')

  const outcome = db.transaction((tx) => {
    const [current] = tx
      .select({ email: leads.email, phone: leads.phone })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1)
      .all()
    if (current === undefined) return 'not_found' as const

    // Lowercased to match intake and auth, whose unique lookups are case-sensitive.
    const nextEmail = email === undefined ? current.email : (email?.toLowerCase() ?? null)
    const nextPhone = phone === undefined ? current.phone : phone
    if (nextEmail === null && nextPhone === null) return 'email_or_phone_required' as const

    // A patch that names none of the three fields is a no-op, not an error: a UI
    // that PATCHes only what changed will send one. Returning early is also what
    // keeps it off drizzle's update builder, which rejects an empty `set`.
    if (name === undefined && email === undefined && phone === undefined) return 'updated' as const

    tx.update(leads)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email: nextEmail }),
        ...(phone === undefined ? {} : { phone: nextPhone }),
      })
      .where(eq(leads.id, id))
      .run()
    return 'updated' as const
  })

  if (outcome !== 'updated') return err(outcome)
  return requireLead(db, id)
}

/**
 * Transitions are unrestricted — any stage to any stage, per DESIGN.md (Data
 * model). Moving a lead to the stage it is already in writes no event: the
 * timeline records changes, and a row saying nothing changed is noise a reader
 * has to filter out forever.
 */
export function moveLeadStage(
  db: Db,
  id: number,
  stageId: unknown,
  actor: string,
): Result<LeadDetail, LeadError> {
  // Validated here rather than in the handler, so the MCP surface (#15) does not
  // have to re-implement it to get the same answer.
  if (!Number.isSafeInteger(stageId) || (stageId as number) <= 0) return err('invalid_stage')
  const targetId = stageId as number

  const outcome = db.transaction((tx) => {
    const [lead] = tx
      .select({ currentStageId: leads.currentStageId })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1)
      .all()
    if (lead === undefined) return 'not_found' as const

    const [target] = tx
      .select({ id: stages.id, name: stages.name })
      .from(stages)
      .where(eq(stages.id, targetId))
      .limit(1)
      .all()
    if (target === undefined) return 'invalid_stage' as const
    if (lead.currentStageId === target.id) return 'unchanged' as const

    const [from] = tx
      .select({ id: stages.id, name: stages.name })
      .from(stages)
      .where(eq(stages.id, lead.currentStageId))
      .limit(1)
      .all()

    tx.update(leads).set({ currentStageId: target.id }).where(eq(leads.id, id)).run()
    // Same transaction as the move it records — DESIGN.md (Data model).
    tx.insert(leadEvents)
      .values({
        leadId: id,
        type: 'stage_changed',
        payload: JSON.stringify({
          from: { id: lead.currentStageId, name: from?.name ?? null },
          to: { id: target.id, name: target.name },
        }),
        actor,
      })
      .run()
    return 'moved' as const
  })

  if (outcome === 'not_found' || outcome === 'invalid_stage') return err(outcome)
  return requireLead(db, id)
}

export function addLeadNote(
  db: Db,
  id: number,
  rawNote: unknown,
  actor: string,
): Result<LeadDetail, LeadError> {
  if (typeof rawNote !== 'string') return err('invalid_note')
  const note = rawNote.trim()
  if (note.length === 0 || note.length > MAX_NOTE_LENGTH) return err('invalid_note')

  const found = db.transaction((tx) => {
    const [lead] = tx.select({ id: leads.id }).from(leads).where(eq(leads.id, id)).limit(1).all()
    if (lead === undefined) return false
    tx.insert(leadEvents)
      .values({ leadId: id, type: 'note_added', payload: JSON.stringify({ note }), actor })
      .run()
    return true
  })

  if (!found) return err('not_found')
  return requireLead(db, id)
}

export interface SpamPromotion {
  lead: LeadDetail
  /**
   * True only for the call that actually flipped the flag. The pipeline
   * suppressed at intake fires on that call and no other, so promoting an
   * already-clean lead cannot send its acknowledgment a second time.
   */
  promoted: boolean
  formId: number | null
}

/**
 * Promotes a quarantined lead — DESIGN.md (Intake endpoint): the spam view's
 * "not spam" action clears the flag and fires the pipeline that was held back.
 *
 * The promotion is recorded as a note rather than an event type of its own: the
 * four types in DESIGN.md (Data model) are the contract, and a system-authored
 * note puts the same fact on the timeline without changing it.
 */
export function clearLeadSpam(db: Db, id: number, actor: string): Result<SpamPromotion, LeadError> {
  const outcome = db.transaction((tx) => {
    const [lead] = tx
      .select({ isSpam: leads.isSpam, formId: leads.formId })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1)
      .all()
    if (lead === undefined) return undefined
    if (!lead.isSpam) return { promoted: false, formId: lead.formId }

    tx.update(leads).set({ isSpam: false }).where(eq(leads.id, id)).run()
    tx.insert(leadEvents)
      .values({
        leadId: id,
        type: 'note_added',
        payload: JSON.stringify({ note: NOT_SPAM_NOTE, system: true }),
        actor,
      })
      .run()
    return { promoted: true, formId: lead.formId }
  })

  if (outcome === undefined) return err('not_found')
  const detail = getLead(db, id)
  if (detail === undefined) return err('not_found')
  return ok({ lead: detail, promoted: outcome.promoted, formId: outcome.formId })
}
