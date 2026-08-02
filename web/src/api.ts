import { ApiError, getJson, sendJson } from './http.ts'

/** Mirrors server/src/leads/service.ts — the REST shapes are the contract. */
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
  /** The intake payload's non-reserved keys, as submitted — see ADR-0003. */
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

export interface StageRecord {
  id: number
  name: string
  position: number
  isTerminal: boolean
  leadCount: number
}

export interface LeadQuery {
  stageId?: number | undefined
  search?: string | undefined
  isSpam: boolean
  limit: number
  offset: number
}

/** Rows per page. Well under the server's MAX_PAGE_SIZE, and a screenful. */
export const PAGE_SIZE = 50

/**
 * Cards per board column. A board is read for the shape of the funnel rather
 * than paged through, so a column shows its newest cards and says how many it
 * left out — see BoardColumn.
 */
export const BOARD_COLUMN_SIZE = 25

/** Mirrors MAX_NOTE_LENGTH in server/src/leads/service.ts, so the box can stop first. */
export const MAX_NOTE_LENGTH = 5_000

/** Mirrors MAX_STAGE_NAME_LENGTH in server/src/stages/service.ts, same reason. */
export const MAX_STAGE_NAME_LENGTH = 80

const LEADS_BASE = '/api/v1/leads'

const STAGES_BASE = '/api/v1/stages'

const MESSAGES: Record<string, string> = {
  not_found: 'That lead no longer exists.',
  invalid_stage: 'That stage no longer exists. Reload and try again.',
  invalid_note: 'A note has to have text, and fit within 5,000 characters.',
  invalid_contact: 'Those contact details are not valid.',
  email_or_phone_required: 'A lead needs either an email address or a phone number.',
  invalid_request: 'The server could not read that request.',
  unauthorized: 'Your session has expired. Sign in again.',
}

/**
 * The same codes read differently when the subject is a stage rather than a
 * lead — `not_found` above is about a lead, and telling someone renaming a
 * column that "that lead no longer exists" is worse than saying nothing.
 */
const STAGE_MESSAGES: Record<string, string> = {
  not_found: 'That stage no longer exists. Reload and try again.',
  invalid_name: `A stage needs a name of ${MAX_STAGE_NAME_LENGTH} characters or fewer.`,
  invalid_terminal: 'The server could not read that request.',
  invalid_order: 'The funnel changed while that reorder was in flight. Reload and try again.',
  stage_not_empty: 'Move its leads to another stage before deleting this one.',
  last_stage: 'A funnel has to keep at least one stage.',
  too_many_stages: 'That is as many stages as one funnel can hold.',
  no_pipeline: 'The funnel is unavailable. Reload and try again.',
}

/**
 * What a lead screen shows a person. A non-`ApiError` never came from the API,
 * so it is reported as a connection problem rather than as a rejection.
 */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return MESSAGES[error.code] ?? `Something went wrong (HTTP ${error.status}).`
}

/** The same, for a failure that came from editing the funnel rather than a lead. */
export function stageErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = STAGE_MESSAGES[error.code]
    if (message !== undefined) return message
  }
  return apiErrorMessage(error)
}

export async function fetchStages(signal?: AbortSignal): Promise<StageRecord[]> {
  const body = await getJson<{ stages: StageRecord[] }>(STAGES_BASE, signal)
  return body.stages
}

/** Appended to the end of the funnel — the server decides the position. */
export async function createStage(name: string, isTerminal: boolean): Promise<StageRecord> {
  const body = await sendJson<{ stage: StageRecord }>('POST', STAGES_BASE, { name, isTerminal })
  return body.stage
}

export async function updateStage(
  id: number,
  patch: { name?: string; isTerminal?: boolean },
): Promise<StageRecord> {
  const body = await sendJson<{ stage: StageRecord }>('PATCH', `${STAGES_BASE}/${id}`, patch)
  return body.stage
}

/**
 * Takes the complete funnel in its new order; the server refuses a partial one,
 * because a half-applied order leaves two stages claiming the same position.
 */
export async function reorderStages(stageIds: number[]): Promise<StageRecord[]> {
  const body = await sendJson<{ stages: StageRecord[] }>('POST', `${STAGES_BASE}/reorder`, { stageIds })
  return body.stages
}

/** Answers with the remaining funnel, so the board never has to refetch it. */
export async function deleteStage(id: number): Promise<StageRecord[]> {
  const body = await sendJson<{ stages: StageRecord[] }>('DELETE', `${STAGES_BASE}/${id}`)
  return body.stages
}

export interface BoardColumn {
  stage: StageRecord
  /** The newest cards in the stage, capped at BOARD_COLUMN_SIZE. */
  leads: LeadRecord[]
  /**
   * Every non-spam lead in the stage. Not `stage.leadCount`, which counts
   * quarantined leads too — the board shows none of those, so counting them
   * would label a column with a number nothing on screen adds up to.
   */
  total: number
}

/**
 * The whole board in one call: the funnel, then a page of cards per stage.
 * N+1 requests, where N is the number of stages a person is willing to read
 * across — the alternative is a board-shaped endpoint the REST surface does
 * not have, and this stays inside the contract #7 shipped.
 */
export async function fetchBoard(signal?: AbortSignal): Promise<BoardColumn[]> {
  const stages = await fetchStages(signal)
  return Promise.all(
    stages.map(async (stage) => {
      const page = await fetchLeads(
        { stageId: stage.id, isSpam: false, limit: BOARD_COLUMN_SIZE, offset: 0 },
        signal,
      )
      return { stage, leads: page.leads, total: page.total }
    }),
  )
}

export function fetchLeads(query: LeadQuery, signal?: AbortSignal): Promise<LeadPage> {
  const params = new URLSearchParams({
    spam: String(query.isSpam),
    limit: String(query.limit),
    offset: String(query.offset),
  })
  if (query.stageId !== undefined) params.set('stage', String(query.stageId))
  // An empty search is no search: the server reads a blank string as "no
  // filter", but leaving the key off entirely says the same thing in one place.
  const search = query.search?.trim() ?? ''
  if (search !== '') params.set('search', search)
  return getJson<LeadPage>(`${LEADS_BASE}?${params.toString()}`, signal)
}

export async function fetchLead(id: number, signal?: AbortSignal): Promise<LeadDetail> {
  const body = await getJson<{ lead: LeadDetail }>(`${LEADS_BASE}/${id}`, signal)
  return body.lead
}

/** Every mutation answers with the whole lead, so a screen never has to refetch. */
async function mutateLead(path: string, body: unknown = {}): Promise<LeadDetail> {
  const answer = await sendJson<{ lead: LeadDetail }>('POST', path, body)
  return answer.lead
}

export function moveLeadStage(id: number, stageId: number): Promise<LeadDetail> {
  return mutateLead(`${LEADS_BASE}/${id}/stage`, { stageId })
}

export function addLeadNote(id: number, note: string): Promise<LeadDetail> {
  return mutateLead(`${LEADS_BASE}/${id}/notes`, { note })
}

/** The spam view's "not spam": clears the flag and fires the held-back pipeline. */
export function promoteLead(id: number): Promise<LeadDetail> {
  return mutateLead(`${LEADS_BASE}/${id}/not-spam`)
}
