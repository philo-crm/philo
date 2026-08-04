import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { emailTemplates } from '../db/schema.ts'
import { getLead, type LeadRecord } from '../leads/service.ts'
import { buildContext, renderBodyResult, renderSubjectResult, type TemplateContext } from './render.ts'
import type { EmailTrigger } from './service.ts'
import { readEmailSettings } from './settings.ts'

/** The pair the MVP sends. Mirrors the `trigger` column's enum — DESIGN.md (Email). */
export const TEMPLATE_TRIGGERS: readonly EmailTrigger[] = ['new_lead_notify', 'new_lead_ack']

/**
 * Handlebars source, not the rendered header — `renderSubject` caps what
 * actually reaches a header at MAX_SUBJECT_LENGTH, and a subject written with a
 * block helper in it is longer as source than as output.
 */
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500

/**
 * Chosen against the 64 KiB request ceiling in app.ts, which counts bytes while
 * this counts UTF-16 code units: at three UTF-8 bytes per unit — the worst any
 * text reaches — a full-length body and subject together come to about 61 KiB,
 * so the cap here is what refuses an over-long template rather than the body
 * limit's 413.
 */
export const MAX_TEMPLATE_BODY_LENGTH = 20_000

export interface EmailTemplateRecord {
  trigger: EmailTrigger
  subject: string
  body: string
  enabled: boolean
  updatedAt: string
}

export type EmailTemplateError =
  | 'not_found'
  | 'invalid_subject'
  | 'invalid_body'
  | 'invalid_enabled'
  | 'invalid_subject_template'
  | 'invalid_body_template'
  | 'invalid_lead'

/**
 * Like `Result`, plus the sentence Handlebars gave. The two template codes are
 * useless without it: "that is not valid Handlebars" does not tell an operator
 * which brace they left open. Same shape as `TestEmailResult` in service.ts,
 * which carries an SMTP server's complaint for the same reason.
 */
export type TemplateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EmailTemplateError; detail?: string | undefined }

function fail<T>(error: EmailTemplateError, detail?: string): TemplateResult<T> {
  return { ok: false, error, ...(detail === undefined ? {} : { detail }) }
}

/**
 * The lead a preview renders against when none is named — so the editor works
 * on an instance that has not taken a lead yet, which is exactly when the
 * templates are being written. Pre-screening answers only: no DOT/DQ fields
 * (AGENTS.md, Scope Guardrail).
 */
export const SAMPLE_LEAD = {
  /** Not a real row. Numbered so `{{lead_url}}` previews as a link and not as `/leads/0`. */
  id: 1,
  name: 'Sample Applicant',
  email: 'applicant@example.com',
  phone: '555-0100',
  source: 'Careers page',
  fields: {
    years_experience: '6',
    endorsements: 'Hazmat, Tanker',
    equipment: 'Dry van',
    available_from: 'Immediately',
  } as Record<string, unknown>,
} satisfies Pick<LeadRecord, 'id' | 'name' | 'email' | 'phone' | 'source' | 'fields'>

export function isEmailTrigger(value: string): value is EmailTrigger {
  return (TEMPLATE_TRIGGERS as readonly string[]).includes(value)
}

function toRecord(row: {
  trigger: EmailTrigger
  subject: string
  body: string
  enabled: boolean
  updatedAt: Date
}): EmailTemplateRecord {
  return { ...row, updatedAt: row.updatedAt.toISOString() }
}

const TEMPLATE_COLUMNS = {
  trigger: emailTemplates.trigger,
  subject: emailTemplates.subject,
  body: emailTemplates.body,
  enabled: emailTemplates.enabled,
  updatedAt: emailTemplates.updatedAt,
} as const

/** Ordered by id, which is seed order — so the editor's two panels never swap places. */
export function listEmailTemplates(db: Db): EmailTemplateRecord[] {
  return db
    .select(TEMPLATE_COLUMNS)
    .from(emailTemplates)
    .orderBy(asc(emailTemplates.id))
    .all()
    .map(toRecord)
}

export function getEmailTemplate(db: Db, trigger: EmailTrigger): EmailTemplateRecord | undefined {
  const [row] = db
    .select(TEMPLATE_COLUMNS)
    .from(emailTemplates)
    .where(eq(emailTemplates.trigger, trigger))
    .limit(1)
    .all()
  return row === undefined ? undefined : toRecord(row)
}

/** What a template is: the two halves that get rendered, plus whether it fires. */
interface TemplateFields {
  subject: string
  body: string
  enabled: boolean
}

/**
 * The three writable columns, picked out rather than spread from the record —
 * a spread would carry `trigger` and the serialized `updatedAt` into the
 * update's `set`, where the string date is not a date the driver can bind.
 */
function fieldsOf(record: EmailTemplateRecord): TemplateFields {
  return { subject: record.subject, body: record.body, enabled: record.enabled }
}

function text(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.length > max) return undefined
  // Empty is refused rather than stored: a template with no subject or no body
  // is one that sends a blank email, which is worse than not sending at all.
  return raw.trim() === '' ? undefined : raw
}

/**
 * Patch semantics, matching the settings route above it: a key the body leaves
 * out keeps its stored value.
 */
function applyPatch(
  current: TemplateFields,
  patch: Record<string, unknown>,
): TemplateResult<TemplateFields> {
  const next = { ...current }

  if ('subject' in patch) {
    // Trimmed on the way in — a subject is a single header line, and leading
    // whitespace in one is invisible in the editor and wrong in the mailbox.
    const subject = text(patch['subject'], MAX_TEMPLATE_SUBJECT_LENGTH)
    if (subject === undefined) return fail('invalid_subject')
    next.subject = subject.trim()
  }
  if ('body' in patch) {
    // Not trimmed: a body is HTML the operator laid out, and whitespace in it
    // is theirs to keep.
    const body = text(patch['body'], MAX_TEMPLATE_BODY_LENGTH)
    if (body === undefined) return fail('invalid_body')
    next.body = body
  }
  if ('enabled' in patch) {
    if (typeof patch['enabled'] !== 'boolean') return fail('invalid_enabled')
    next.enabled = patch['enabled']
  }

  return { ok: true, value: next }
}

/** What a template renders to, with the lead it was rendered against. */
export interface TemplatePreview {
  subject: string
  body: string
  /** Null when the built-in sample was used rather than a stored lead. */
  leadId: number | null
}

/**
 * The context a preview renders in: a real lead when one is named, the sample
 * otherwise. `{{business.name}}` and `{{lead_url}}` come from the same settings
 * the send path reads, so a preview is a statement about the real thing.
 */
function previewContext(
  db: Db,
  publicBaseUrl: string,
  rawLeadId: unknown,
): TemplateResult<{ context: TemplateContext; leadId: number | null }> {
  const config = readEmailSettings(db)
  const options = {
    businessName: config.businessName,
    fromName: config.fromName,
    publicBaseUrl,
  }

  if (rawLeadId === undefined || rawLeadId === null) {
    return { ok: true, value: { context: buildContext(SAMPLE_LEAD, options), leadId: null } }
  }
  if (!Number.isInteger(rawLeadId)) return fail('invalid_lead')

  const lead = getLead(db, rawLeadId as number)
  if (lead === undefined) return fail('invalid_lead')
  return { ok: true, value: { context: buildContext(lead, options), leadId: lead.id } }
}

/**
 * Renders a draft — the boxes as they are typed, falling back to what is stored
 * for anything the caller left out. Nothing is written: this is what makes
 * edit → preview a loop that costs no saves, and it is the same code the save
 * path runs to decide whether a template is valid at all.
 */
export function previewEmailTemplate(
  db: Db,
  publicBaseUrl: string,
  trigger: EmailTrigger,
  input: Record<string, unknown>,
): TemplateResult<TemplatePreview> {
  const stored = getEmailTemplate(db, trigger)
  if (stored === undefined) return fail('not_found')

  const draft = applyPatch(fieldsOf(stored), input)
  if (!draft.ok) return draft

  const resolved = previewContext(db, publicBaseUrl, input['leadId'])
  if (!resolved.ok) return resolved

  const subject = renderSubjectResult(draft.value.subject, resolved.value.context)
  if (!subject.ok) return fail('invalid_subject_template', subject.message)
  const body = renderBodyResult(draft.value.body, resolved.value.context)
  if (!body.ok) return fail('invalid_body_template', body.message)

  return {
    ok: true,
    value: { subject: subject.value, body: body.value, leadId: resolved.value.leadId },
  }
}

/**
 * Saves an edit, but only one that renders. Handlebars compiles lazily, so a
 * template with an unclosed block is accepted by `compile` and only throws when
 * a lead is finally put through it — by which time the send path has already
 * swallowed it as "no email" (see service.ts). Rendering it here against the
 * sample is what turns that into a message someone can act on.
 */
export function updateEmailTemplate(
  db: Db,
  publicBaseUrl: string,
  trigger: EmailTrigger,
  patch: Record<string, unknown>,
): TemplateResult<EmailTemplateRecord> {
  const stored = getEmailTemplate(db, trigger)
  if (stored === undefined) return fail('not_found')

  const next = applyPatch(fieldsOf(stored), patch)
  if (!next.ok) return next

  // Only when there is new source to check. Rendering on an `enabled`-only
  // toggle would make a template that somehow got stored broken impossible to
  // switch off, which is the one thing an operator would want to do with it.
  //
  // Deliberately against the sample rather than any lead the caller named: the
  // question here is whether the template is well-formed, and one lead's data
  // must not be what decides whether a save is allowed.
  if ('subject' in patch || 'body' in patch) {
    const rendered = previewEmailTemplate(db, publicBaseUrl, trigger, {
      subject: next.value.subject,
      body: next.value.body,
    })
    if (!rendered.ok) return rendered
  }

  const [row] = db
    .update(emailTemplates)
    .set(next.value)
    .where(eq(emailTemplates.trigger, trigger))
    .returning(TEMPLATE_COLUMNS)
    .all()
  if (row === undefined) return fail('not_found')
  return { ok: true, value: toRecord(row) }
}
