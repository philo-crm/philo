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

/** Mirrors MAX_NAME_LENGTH in server/src/email/settings.ts. */
export const MAX_SETTINGS_NAME_LENGTH = 200

/** Mirrors the caps in server/src/email/templates.ts, so a box can stop first. */
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500
export const MAX_TEMPLATE_BODY_LENGTH = 20_000

const LEADS_BASE = '/api/v1/leads'

const STAGES_BASE = '/api/v1/stages'

const EMAIL_SETTINGS_BASE = '/api/v1/settings/email'

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

/**
 * Mirrors the response shape in server/src/settings/routes.ts. There is no
 * `smtpPassword` and there is not meant to be one: the credential is
 * write-only, and `smtpPasswordSet` is everything a form needs to know.
 */
export interface EmailSettings {
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUsername: string
  smtpPasswordSet: boolean
  fromName: string
  fromAddress: string
  replyTo: string
  businessName: string
}

/** Patch semantics: a key left out keeps its stored value. */
export type EmailSettingsPatch = Partial<
  Omit<EmailSettings, 'smtpPasswordSet'> & { smtpPassword: string }
>

const SETTINGS_MESSAGES: Record<string, string> = {
  invalid_smtp_host: 'Enter the SMTP host your provider gave you.',
  invalid_smtp_port: 'A port is a whole number between 1 and 65535.',
  invalid_smtp_secure: 'The server could not read that request.',
  invalid_smtp_username: 'That username is too long.',
  invalid_smtp_password: 'That password is too long.',
  invalid_from_name: `A sender name has to fit within ${MAX_SETTINGS_NAME_LENGTH} characters.`,
  invalid_from_address: 'The sender address has to be a valid email address.',
  invalid_reply_to: 'The reply-to address has to be a valid email address.',
  invalid_business_name: `A business name has to fit within ${MAX_SETTINGS_NAME_LENGTH} characters.`,
  invalid_email: 'Enter the address the test should be sent to.',
  not_configured: 'Fill in an SMTP host and a sender address first, then save.',
  send_failed: 'The mail server refused the message.',
  invalid_subject: `A subject needs text, and has to fit within ${MAX_TEMPLATE_SUBJECT_LENGTH} characters.`,
  invalid_body: `A body needs text, and has to fit within ${MAX_TEMPLATE_BODY_LENGTH} characters.`,
  invalid_enabled: 'The server could not read that request.',
  // Both carry what Handlebars said, which `settingsErrorMessage` appends —
  // "Parse error on line 2" is the half that says where to look.
  invalid_subject_template: 'The subject is not valid Handlebars, so nothing was saved.',
  invalid_body_template: 'The body is not valid Handlebars, so nothing was saved.',
  invalid_lead: 'That lead no longer exists, so there was nothing to preview against.',
  not_found: 'That template no longer exists. Reload and try again.',
  // Reachable before the body's own cap bites: the server bounds the request in
  // bytes and the box counts characters, which differ for anything non-ASCII.
  payload_too_large: 'That is larger than the server will accept. Shorten the body.',
  invalid_subscription: 'This browser gave out a push subscription the server could not use.',
}

/**
 * A settings failure in words. `send_failed` appends whatever the SMTP server
 * said, because that sentence — not the code — is the thing an operator needs
 * in order to fix their configuration.
 */
export function settingsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = SETTINGS_MESSAGES[error.code]
    if (message !== undefined) {
      return error.detail === undefined ? message : `${message} ${error.detail}`
    }
  }
  return apiErrorMessage(error)
}

export async function fetchEmailSettings(signal?: AbortSignal): Promise<EmailSettings> {
  const body = await getJson<{ settings: EmailSettings }>(EMAIL_SETTINGS_BASE, signal)
  return body.settings
}

export async function updateEmailSettings(patch: EmailSettingsPatch): Promise<EmailSettings> {
  const body = await sendJson<{ settings: EmailSettings }>('PATCH', EMAIL_SETTINGS_BASE, patch)
  return body.settings
}

/**
 * Sends with the settings as stored, so the screen saves first — a green test
 * against unsaved values would say nothing about the next real lead.
 */
export async function sendTestEmail(to: string): Promise<void> {
  await sendJson<{ ok: true }>('POST', `${EMAIL_SETTINGS_BASE}/test`, { to })
}

const PUSH_BASE = '/api/v1/push'

/**
 * The VAPID public key this instance signs with, generated at its first boot.
 * Public by construction — it is what a push service checks the signature
 * against — and the browser needs it as `applicationServerKey`.
 */
export async function fetchVapidPublicKey(signal?: AbortSignal): Promise<string> {
  const body = await getJson<{ publicKey: string }>(`${PUSH_BASE}/key`, signal)
  return body.publicKey
}

/** Takes the serialized `PushSubscription` as the browser hands it over. */
export async function storePushSubscription(subscription: unknown): Promise<void> {
  await sendJson<{ ok: true }>('POST', `${PUSH_BASE}/subscriptions`, subscription)
}

export async function forgetPushSubscription(endpoint: string): Promise<void> {
  await sendJson<{ ok: true }>('DELETE', `${PUSH_BASE}/subscriptions`, { endpoint })
}

/** Mirrors MAX_API_KEY_NAME_LENGTH in server/src/auth/api-keys.ts. */
export const MAX_API_KEY_NAME_LENGTH = 80

/**
 * Mirrors the response shape in server/src/auth/api-key-routes.ts. There is no
 * secret on it and there is not meant to be one: the key is handed back exactly
 * once, by `createApiKey`, and `keyPrefix` is all a list can ever show.
 */
export interface ApiKeyRecord {
  id: number
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

const API_KEYS_BASE = '/api/v1/api-keys'

/**
 * The same codes again, read as a key rather than a lead or a stage —
 * `not_found` here is about a key somebody else already revoked.
 */
const API_KEY_MESSAGES: Record<string, string> = {
  invalid_name: `A key needs a name of ${MAX_API_KEY_NAME_LENGTH} characters or fewer, so you can tell later what it was for.`,
  not_found: 'That key has already been revoked. Reload to see the current list.',
  invalid_request: 'The server could not read that request.',
}

export function apiKeyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = API_KEY_MESSAGES[error.code]
    if (message !== undefined) return message
  }
  return apiErrorMessage(error)
}

export async function fetchApiKeys(signal?: AbortSignal): Promise<ApiKeyRecord[]> {
  const body = await getJson<{ keys: ApiKeyRecord[] }>(API_KEYS_BASE, signal)
  return body.keys
}

/**
 * The one call that ever sees a secret. Nothing stores it — the screen shows it
 * until the next render that clears it, and after that it is unrecoverable.
 */
export async function createApiKey(name: string): Promise<{ key: ApiKeyRecord; secret: string }> {
  return sendJson<{ key: ApiKeyRecord; secret: string }>('POST', API_KEYS_BASE, { name })
}

export async function revokeApiKey(id: number): Promise<void> {
  await sendJson<{ ok: true }>('DELETE', `${API_KEYS_BASE}/${id}`)
}

/** Mirrors the row shape in server/src/email/templates.ts. */
export interface EmailTemplate {
  trigger: string
  subject: string
  body: string
  enabled: boolean
  updatedAt: string
}

/**
 * The boxes as they are typed. Preview and test-send both take one, so neither
 * needs a save first — which is what makes edit → preview a loop rather than a
 * commit. `leadId` left out renders against the server's sample lead.
 */
export interface EmailTemplateDraft {
  subject?: string
  body?: string
  leadId?: number
}

export interface EmailTemplatePreview {
  subject: string
  body: string
  /** Null when the built-in sample lead was used. */
  leadId: number | null
}

const TEMPLATES_BASE = `${EMAIL_SETTINGS_BASE}/templates`

export async function fetchEmailTemplates(signal?: AbortSignal): Promise<EmailTemplate[]> {
  const body = await getJson<{ templates: EmailTemplate[] }>(TEMPLATES_BASE, signal)
  return body.templates
}

/** Refused outright if the source does not render, so nothing saves silently. */
export async function updateEmailTemplate(
  trigger: string,
  patch: { subject?: string; body?: string; enabled?: boolean },
): Promise<EmailTemplate> {
  const body = await sendJson<{ template: EmailTemplate }>(
    'PATCH',
    `${TEMPLATES_BASE}/${trigger}`,
    patch,
  )
  return body.template
}

export async function previewEmailTemplate(
  trigger: string,
  draft: EmailTemplateDraft,
): Promise<EmailTemplatePreview> {
  const body = await sendJson<{ preview: EmailTemplatePreview }>(
    'POST',
    `${TEMPLATES_BASE}/${trigger}/preview`,
    draft,
  )
  return body.preview
}

/** Goes to the signed-in operator's own address — the server decides, not the screen. */
export async function sendTemplateTestEmail(
  trigger: string,
  draft: EmailTemplateDraft,
): Promise<string> {
  const body = await sendJson<{ ok: true; to: string }>(
    'POST',
    `${TEMPLATES_BASE}/${trigger}/test`,
    draft,
  )
  return body.to
}
