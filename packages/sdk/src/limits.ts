// Bounds the server enforces, so a client can stop a value before sending it.
// Each mirrors a constant in packages/server/src; the server stays the
// authority and refuses anything past them regardless.

/** packages/server/src/leads/service.ts */
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
export const MAX_SEARCH_LENGTH = 256
export const MAX_NOTE_LENGTH = 5_000
export const MAX_CONTACT_FIELD_LENGTH = 200
export const MAX_EMAIL_LENGTH = 254
export const MAX_DETAIL_KEY_LENGTH = 100
export const MAX_DETAILS_BYTES = 32_000

/** packages/server/src/leads/attachments.ts */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255

/** packages/server/src/stages/service.ts */
export const MAX_STAGE_NAME_LENGTH = 80

/** packages/server/src/email/settings.ts */
export const MAX_SETTINGS_NAME_LENGTH = 200

/** packages/server/src/email/templates.ts */
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500
export const MAX_TEMPLATE_BODY_LENGTH = 20_000
export const TEMPLATE_TRIGGERS = ['new_lead_notify', 'new_lead_ack'] as const
export type TemplateTrigger = (typeof TEMPLATE_TRIGGERS)[number]

/** packages/server/src/auth/api-keys.ts */
export const MAX_API_KEY_NAME_LENGTH = 80

/** packages/server/src/auth/credentials.ts */
export const MIN_PASSWORD_LENGTH = 12
