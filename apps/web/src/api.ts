import {
  ApiError,
  MAX_API_KEY_NAME_LENGTH,
  MAX_SETTINGS_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  type ApiKeyRecord,
  type EmailSettings,
  type EmailSettingsPatch,
  type EmailTemplate,
  type EmailTemplateDraft,
  type EmailTemplatePreview,
  type LeadDetail,
  type LeadPage,
  type LeadRecord,
  type StageRecord,
} from '@philo/sdk'
import { philo } from './client.ts'
import { PushSubscribeError } from './http.ts'

export type {
  ApiKeyRecord,
  EmailSettings,
  EmailSettingsPatch,
  EmailTemplate,
  EmailTemplateDraft,
  EmailTemplatePreview,
  LeadDetail,
  LeadEventRecord,
  LeadPage,
  LeadRecord,
  StageRecord,
} from '@philo/sdk'

/** The screens always say which view they want and page explicitly. */
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

export {
  MAX_API_KEY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SETTINGS_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
} from '@philo/sdk'


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

export function fetchStages(signal?: AbortSignal): Promise<StageRecord[]> {
  return philo.stages.list(signal)
}

/** Appended to the end of the funnel — the server decides the position. */
export function createStage(name: string, isTerminal: boolean): Promise<StageRecord> {
  return philo.stages.create(name, isTerminal)
}

export function updateStage(id: number, patch: { name?: string; isTerminal?: boolean }): Promise<StageRecord> {
  return philo.stages.update(id, patch)
}

/**
 * Takes the complete funnel in its new order; the server refuses a partial one,
 * because a half-applied order leaves two stages claiming the same position.
 */
export function reorderStages(stageIds: number[]): Promise<StageRecord[]> {
  return philo.stages.reorder(stageIds)
}

/** Answers with the remaining funnel, so the board never has to refetch it. */
export function deleteStage(id: number): Promise<StageRecord[]> {
  return philo.stages.delete(id)
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
/**
 * The whole board in one call: the funnel, then a page of cards per stage.
 * N+1 requests, where N is the number of stages a person is willing to read
 * across — the alternative is a board-shaped endpoint the REST surface does
 * not have.
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
  return philo.leads.list(query, signal)
}

export function fetchLead(id: number, signal?: AbortSignal): Promise<LeadDetail> {
  return philo.leads.get(id, signal)
}

export function moveLeadStage(id: number, stageId: number): Promise<LeadDetail> {
  return philo.leads.moveStage(id, stageId)
}

export function addLeadNote(id: number, note: string): Promise<LeadDetail> {
  return philo.leads.addNote(id, note)
}

/** The spam view's "not spam": clears the flag and fires the held-back pipeline. */
export function promoteLead(id: number): Promise<LeadDetail> {
  return philo.leads.markNotSpam(id)
}

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
  if (error instanceof PushSubscribeError) {
    return `This browser couldn't register for push (${error.reason}: ${error.message}).`
  }
  if (error instanceof ApiError) {
    const message = SETTINGS_MESSAGES[error.code]
    if (message !== undefined) {
      return error.detail === undefined ? message : `${message} ${error.detail}`
    }
  }
  return apiErrorMessage(error)
}

export function fetchEmailSettings(signal?: AbortSignal): Promise<EmailSettings> {
  return philo.emailSettings.get(signal)
}

export function updateEmailSettings(patch: EmailSettingsPatch): Promise<EmailSettings> {
  return philo.emailSettings.update(patch)
}

/**
 * Sends with the settings as stored, so the screen saves first — a green test
 * against unsaved values would say nothing about the next real lead.
 */
export function sendTestEmail(to: string): Promise<void> {
  return philo.emailSettings.sendTest(to)
}

export function fetchVapidPublicKey(signal?: AbortSignal): Promise<string> {
  return philo.push.publicKey(signal)
}

/** Takes the serialized `PushSubscription` as the browser hands it over. */
export function storePushSubscription(subscription: unknown): Promise<void> {
  return philo.push.subscribe(subscription)
}

export function forgetPushSubscription(endpoint: string): Promise<void> {
  return philo.push.unsubscribe(endpoint)
}

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

export function fetchApiKeys(signal?: AbortSignal): Promise<ApiKeyRecord[]> {
  return philo.apiKeys.list(signal)
}

/**
 * The one call that ever sees a secret. Nothing stores it — the screen shows it
 * until the next render that clears it, and after that it is unrecoverable.
 */
export function createApiKey(name: string): Promise<{ key: ApiKeyRecord; secret: string }> {
  return philo.apiKeys.create(name)
}

export function revokeApiKey(id: number): Promise<void> {
  return philo.apiKeys.revoke(id)
}

export function fetchEmailTemplates(signal?: AbortSignal): Promise<EmailTemplate[]> {
  return philo.emailTemplates.list(signal)
}

/** Refused outright if the source does not render, so nothing saves silently. */
export function updateEmailTemplate(
  trigger: string,
  patch: { subject?: string; body?: string; enabled?: boolean },
): Promise<EmailTemplate> {
  return philo.emailTemplates.update(trigger, patch)
}

export function previewEmailTemplate(trigger: string, draft: EmailTemplateDraft): Promise<EmailTemplatePreview> {
  return philo.emailTemplates.preview(trigger, draft)
}

/** Goes to the signed-in operator's own address — the server decides, not the screen. */
export function sendTemplateTestEmail(trigger: string, draft: EmailTemplateDraft): Promise<string> {
  return philo.emailTemplates.sendTest(trigger, draft)
}
