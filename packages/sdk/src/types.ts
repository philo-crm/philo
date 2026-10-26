import type { ChangeType } from './limits.ts'

// The REST shapes are the contract. Each one mirrors a response the server
// builds; a change on either side lands in the same PR.

/** Mirrors packages/server/src/leads/service.ts. */
export interface LeadRecord {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  source: string | null
  formId: number | null
  /** The funnel the lead's current stage belongs to — ADR-0009. */
  funnelId: number
  stageId: number
  stageName: string
  isSpam: boolean
  /** The intake payload's non-reserved keys, as submitted — see ADR-0003. */
  fields: Record<string, unknown>
  /** Added after intake by users and agents — ADR-0008. */
  details: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface LeadEventRecord {
  id: number
  type: string
  payload: Record<string, unknown>
  /** `user:<id>`, `api_key:<id>`, `oauth:<client>` or `form:<id>`. */
  actor: string
  createdAt: string
}

/** A file on a lead. The bytes come from `leads.attachments.download`. */
export interface LeadAttachmentRecord {
  id: number
  filename: string
  contentType: string
  size: number
  sha256: string
  actor: string
  createdAt: string
}

export interface LeadDetail extends LeadRecord {
  events: LeadEventRecord[]
  attachments: LeadAttachmentRecord[]
}

export interface LeadPage {
  leads: LeadRecord[]
  total: number
  limit: number
  offset: number
}

export interface LeadQuery {
  /** Left out lists every funnel's leads. */
  funnelId?: number | undefined
  stageId?: number | undefined
  formId?: number | undefined
  /** The spam quarantine instead of the funnel. Defaults to false. */
  isSpam?: boolean | undefined
  search?: string | undefined
  /** Inclusive bounds; a date or a full timestamp. */
  createdAfter?: string | Date | undefined
  createdBefore?: string | Date | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/** A lead filed by hand rather than submitted through a form. Sends no email. */
export interface NewLead {
  name?: string | undefined
  email?: string | undefined
  phone?: string | undefined
  source?: string | undefined
  /** Left out with `stageId` too: the first stage of the default funnel. */
  funnelId?: number | undefined
  stageId?: number | undefined
  fields?: Record<string, unknown> | undefined
}

/** A field left out is unchanged; null clears it. */
export interface LeadContactPatch {
  name?: string | null | undefined
  email?: string | null | undefined
  phone?: string | null | undefined
}

/** Contact fields as in `LeadContactPatch`; `details` merges by key, and null removes one. */
export interface LeadPatch extends LeadContactPatch {
  details?: Record<string, unknown> | undefined
}

export interface StageRecord {
  id: number
  name: string
  position: number
  isTerminal: boolean
  leadCount: number
}

/** An intake form of a funnel, with the URL a website posts to. */
export interface FunnelForm {
  id: number
  name: string
  formKey: string
  intakeUrl: string
}

/**
 * Mirrors packages/server/src/funnels/routes.ts — ADR-0009. Each setting is an
 * override of the instance's: empty inherits it.
 */
export interface FunnelRecord {
  id: number
  name: string
  /** The funnel every call that names none acts on. */
  isDefault: boolean
  fromName: string
  replyTo: string
  /** Empty: everyone who can sign in gets the new-lead notification. */
  notifyRecipients: string[]
  leadCount: number
  forms: FunnelForm[]
  createdAt: string
}

/** Patch semantics: a key left out keeps its value; `""` or `[]` clears an override. */
export interface FunnelPatch {
  name?: string | undefined
  fromName?: string | undefined
  replyTo?: string | undefined
  notifyRecipients?: string[] | undefined
}

/**
 * Mirrors packages/server/src/settings/routes.ts. There is no `smtpPassword`
 * and there is not meant to be one: the credential is write-only.
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

/** Mirrors the row shape in packages/server/src/email/templates.ts. */
export interface EmailTemplate {
  trigger: string
  subject: string
  body: string
  enabled: boolean
  updatedAt: string
}

export interface EmailTemplatePatch {
  subject?: string | undefined
  body?: string | undefined
  enabled?: boolean | undefined
}

/**
 * Unsaved source to render. `leadId` left out renders against the server's
 * built-in sample lead.
 */
export interface EmailTemplateDraft {
  subject?: string | undefined
  body?: string | undefined
  leadId?: number | undefined
}

export interface EmailTemplatePreview {
  subject: string
  body: string
  /** Null when the built-in sample lead was used. */
  leadId: number | null
}

/**
 * Mirrors packages/server/src/auth/api-key-routes.ts. No secret on it: the key
 * is handed back exactly once, by `apiKeys.create`.
 */
export interface ApiKeyRecord {
  id: number
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

export interface User {
  id: number
  email: string
  name: string | null
}

/**
 * How a client should sign a person in — `GET /api/v1/auth/config`. The issuer
 * is Philo itself unless the operator pointed it at an external IdP.
 */
export interface AuthConfig {
  issuer: string
  /** The client id the PWA uses at that issuer. */
  clientId: string
  /** What to request. Always includes `openid`. */
  scope: string
}

/** Whose a token is — `GET /api/v1/auth/principal`. */
export interface Principal {
  /** The user the credential acts for, with exactly their authority. */
  user: User
  /** How the timeline names this credential: `user:<id>`, `api_key:<id>` or `oauth:<client>`. */
  actor: string
}

export interface VersionInfo {
  name: string
  version: string
}

/** A new lead on the in-app stream — `GET /api/v1/push/live`. The push payload's notification. */
export interface LiveNotification {
  title: string
  body: string
  /** Where a tap lands: the lead in the app. */
  navigate: string
  /** One per lead, so a repeat replaces the banner rather than stacking. */
  tag: string
}

/**
 * One change, as `GET /api/v1/events` streams it and a webhook receives it —
 * ADR-0010. Mirrors packages/server/src/events/feed.ts.
 */
export interface ChangeEvent {
  /** Unique per event: a retried webhook delivery repeats it. */
  id: string
  type: ChangeType
  occurredAt: string
  /** For a moved lead, the funnel it is in now; `data.from` says where it was. */
  funnelId: number
  data: {
    /** Every lead event but `lead.deleted`, which carries only `leadId`. */
    lead?: LeadRecord
    leadId?: number
    from?: { id: number; name: string; funnelId: number }
  }
}

/** The last attempt to reach a webhook. */
export interface WebhookDelivery {
  at: string
  /** Null when there was no HTTP answer at all. */
  status: number | null
  ok: boolean
  error: string | null
}

/** Mirrors packages/server/src/webhooks/service.ts. The secret is only ever in `NewWebhookResult`. */
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

export interface NewWebhook {
  url: string
  /** Left out or null: every funnel. */
  funnelId?: number | null | undefined
  /** Left out or empty: every type. */
  events?: ChangeType[] | undefined
  /** Left out or null: none — receivers verify the signature. */
  authHeader?: WebhookAuthHeader | null | undefined
}

/**
 * A header sent as-is on every delivery, beside the signature, for a receiver
 * that authenticates by a static key — `Authorization: Bearer …`, `X-Api-Key: …`.
 * The value is never answered back.
 */
export interface WebhookAuthHeader {
  name: string
  value: string
}

/** Only the auth header can change; null removes it. */
export interface WebhookPatch {
  authHeader: WebhookAuthHeader | null
}

export interface NewWebhookResult {
  webhook: WebhookRecord
  /** Signs every delivery (`X-Philo-Signature`). Shown once; nothing stores it for you. */
  secret: string
}
