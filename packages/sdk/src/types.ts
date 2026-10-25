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
  /** `user:<id>`, `api_key:<id>`, `oauth:<client>` or `form:<id>`. */
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

export interface LeadQuery {
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
  stageId?: number | undefined
  fields?: Record<string, unknown> | undefined
}

/** A field left out is unchanged; null clears it. */
export interface LeadContactPatch {
  name?: string | null | undefined
  email?: string | null | undefined
  phone?: string | null | undefined
}

export interface StageRecord {
  id: number
  name: string
  position: number
  isTerminal: boolean
  leadCount: number
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
