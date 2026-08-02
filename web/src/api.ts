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

/** Mirrors MAX_NOTE_LENGTH in server/src/leads/service.ts, so the box can stop first. */
export const MAX_NOTE_LENGTH = 5_000

const LEADS_BASE = '/api/v1/leads'

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
 * What a lead screen shows a person. A non-`ApiError` never came from the API,
 * so it is reported as a connection problem rather than as a rejection.
 */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return MESSAGES[error.code] ?? `Something went wrong (HTTP ${error.status}).`
}

export async function fetchStages(signal?: AbortSignal): Promise<StageRecord[]> {
  const body = await getJson<{ stages: StageRecord[] }>('/api/v1/stages', signal)
  return body.stages
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
