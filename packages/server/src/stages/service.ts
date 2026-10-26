import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { leads, stages } from '../db/schema.ts'
import { resolveFunnelId } from '../funnels/service.ts'
import { err, ok, type Result } from '../result.ts'

export const MAX_STAGE_NAME_LENGTH = 80
/** Enough for any funnel a person will read; a ceiling so reorder stays cheap. */
export const MAX_STAGES = 50

export type StageError =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_terminal'
  | 'invalid_order'
  | 'stage_not_empty'
  | 'last_stage'
  | 'too_many_stages'
  | 'no_pipeline'
  | 'funnel_not_found'

export interface StageRecord {
  id: number
  name: string
  position: number
  isTerminal: boolean
  /**
   * Every lead sitting in this stage, spam included. Counting all of them is
   * what makes `leadCount === 0` mean the same thing as "deletable" — a count
   * that hid quarantined leads would show an empty stage that refuses to go.
   */
  leadCount: number
}

/**
 * The funnel a call acts on — ADR-0009: the one named, or the default. Every
 * query here is scoped to it, so one funnel's edit can never reach another's.
 */
function scope(db: Db, funnelId: number | undefined): Result<number, StageError> {
  const id = resolveFunnelId(db, funnelId)
  if (id !== undefined) return ok(id)
  return err(funnelId === undefined ? 'no_pipeline' : 'funnel_not_found')
}

/** The funnel a stage belongs to — what an id-addressed edit is scoped by. */
export function funnelOfStage(db: Db, id: number): number | undefined {
  const [stage] = db.select({ pipelineId: stages.pipelineId }).from(stages).where(eq(stages.id, id)).limit(1).all()
  return stage?.pipelineId
}

function stagesOf(db: Db, pipelineId: number): StageRecord[] {
  return db
    .select({
      id: stages.id,
      name: stages.name,
      position: stages.position,
      isTerminal: stages.isTerminal,
      leadCount: sql<number>`count(${leads.id})`,
    })
    .from(stages)
    .leftJoin(leads, eq(leads.currentStageId, stages.id))
    .where(eq(stages.pipelineId, pipelineId))
    .groupBy(stages.id)
    .orderBy(asc(stages.position), asc(stages.id))
    .all()
}

export function listStages(db: Db, funnelId?: number): Result<StageRecord[], StageError> {
  const scoped = scope(db, funnelId)
  if (!scoped.ok) return funnelId === undefined ? ok([]) : scoped
  return ok(stagesOf(db, scoped.value))
}

function stageName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name.length === 0 || name.length > MAX_STAGE_NAME_LENGTH) return undefined
  return name
}

/**
 * Appended to the end of the funnel. Names are deliberately not unique: two
 * stages called "Follow up" is the operator's business, and a uniqueness rule
 * would only turn a rename into a fight.
 */
export function createStage(
  db: Db,
  input: { name?: unknown; isTerminal?: unknown },
  funnelId?: number,
): Result<StageRecord, StageError> {
  const name = stageName(input.name)
  if (name === undefined) return err('invalid_name')
  if (input.isTerminal !== undefined && typeof input.isTerminal !== 'boolean') {
    return err('invalid_terminal')
  }
  const isTerminal = input.isTerminal ?? false

  const scoped = scope(db, funnelId)
  if (!scoped.ok) return scoped
  const pipelineId = scoped.value

  const created = db.transaction((tx) => {
    const existing = tx
      .select({ position: stages.position })
      .from(stages)
      .where(eq(stages.pipelineId, pipelineId))
      .all()
    if (existing.length >= MAX_STAGES) return undefined
    const position = existing.reduce((next, stage) => Math.max(next, stage.position + 1), 0)
    const [stage] = tx
      .insert(stages)
      .values({ pipelineId, name, position, isTerminal })
      .returning({ id: stages.id })
      .all()
    return stage
  })
  if (created === undefined) return err('too_many_stages')

  const record = stagesOf(db, pipelineId).find((stage) => stage.id === created.id)
  return record === undefined ? err('not_found') : ok(record)
}

export function updateStage(
  db: Db,
  id: number,
  patch: { name?: unknown; isTerminal?: unknown },
): Result<StageRecord, StageError> {
  if (patch.name !== undefined && stageName(patch.name) === undefined) return err('invalid_name')
  if (patch.isTerminal !== undefined && typeof patch.isTerminal !== 'boolean') {
    return err('invalid_terminal')
  }
  const name = patch.name === undefined ? undefined : stageName(patch.name)
  const isTerminal = patch.isTerminal as boolean | undefined

  const pipelineId = funnelOfStage(db, id)
  if (pipelineId === undefined) return err('not_found')

  const updated = db.transaction((tx) => {
    const [stage] = tx
      .select({ id: stages.id })
      .from(stages)
      .where(and(eq(stages.id, id), eq(stages.pipelineId, pipelineId)))
      .limit(1)
      .all()
    if (stage === undefined) return false
    if (name === undefined && isTerminal === undefined) return true
    tx.update(stages)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(isTerminal === undefined ? {} : { isTerminal }),
      })
      .where(eq(stages.id, id))
      .run()
    return true
  })
  if (!updated) return err('not_found')

  const record = stagesOf(db, pipelineId).find((stage) => stage.id === id)
  return record === undefined ? err('not_found') : ok(record)
}

/**
 * Takes the complete funnel in its new order. A partial list is rejected rather
 * than applied to a prefix: `position` is not unique, so a half-applied order
 * would leave two stages claiming the same slot and the board's ordering would
 * come down to which id sorted first.
 */
export function reorderStages(
  db: Db,
  stageIds: unknown,
  funnelId?: number,
): Result<StageRecord[], StageError> {
  if (!Array.isArray(stageIds)) return err('invalid_order')
  const requested: unknown[] = stageIds
  if (!requested.every((id) => Number.isInteger(id) && (id as number) > 0)) return err('invalid_order')
  const order = requested as number[]
  if (new Set(order).size !== order.length) return err('invalid_order')

  const scoped = scope(db, funnelId)
  if (!scoped.ok) return scoped
  const pipelineId = scoped.value

  const applied = db.transaction((tx) => {
    const existing = tx
      .select({ id: stages.id })
      .from(stages)
      .where(eq(stages.pipelineId, pipelineId))
      .all()
    if (existing.length !== order.length) return false
    const known = new Set(existing.map((stage) => stage.id))
    if (!order.every((id) => known.has(id))) return false

    order.forEach((id, position) => {
      tx.update(stages).set({ position }).where(eq(stages.id, id)).run()
    })
    return true
  })
  if (!applied) return err('invalid_order')

  return ok(stagesOf(db, pipelineId))
}

/**
 * Delete-if-empty, scoped to the stage's own funnel. The last stage is kept whatever its count: `leads` references
 * it with `ON DELETE RESTRICT` and intake files every submission under the first
 * stage, so an instance with none would answer its own form with a 503.
 */
export function deleteStage(db: Db, id: number): Result<StageRecord[], StageError> {
  const pipelineId = funnelOfStage(db, id)
  if (pipelineId === undefined) return err('not_found')

  const outcome = db.transaction((tx) => {
    const [stage] = tx
      .select({ id: stages.id })
      .from(stages)
      .where(and(eq(stages.id, id), eq(stages.pipelineId, pipelineId)))
      .limit(1)
      .all()
    if (stage === undefined) return 'not_found' as const

    const remaining = tx
      .select({ id: stages.id })
      .from(stages)
      .where(eq(stages.pipelineId, pipelineId))
      .all().length
    if (remaining <= 1) return 'last_stage' as const

    const [occupant] = tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.currentStageId, id))
      .limit(1)
      .all()
    if (occupant !== undefined) return 'stage_not_empty' as const

    tx.delete(stages).where(eq(stages.id, id)).run()
    return 'deleted' as const
  })

  if (outcome !== 'deleted') return err(outcome)
  return ok(stagesOf(db, pipelineId))
}
