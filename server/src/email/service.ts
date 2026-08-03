import { asc } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { emailTemplates, leadEvents, users } from '../db/schema.ts'
import { getLead, type LeadDetail, type LeadEventRecord } from '../leads/service.ts'
import type { LeadCreatedHook } from '../notify.ts'
import { buildContext, renderBody, renderSubject, type TemplateContext } from './render.ts'
import {
  isEmailConfigured,
  normalizeEmailAddress,
  readEmailSettings,
  type EmailSettings,
} from './settings.ts'
import { smtpSender, type EmailSenderFactory, type SendEmail } from './transport.ts'

/** The two the MVP sends. The column's enum is the contract — DESIGN.md (Email). */
export type EmailTrigger = 'new_lead_notify' | 'new_lead_ack'

/** Enough of an SMTP failure to act on, without pasting a stack into a screen. */
const MAX_FAILURE_DETAIL = 400

export interface EmailDeps {
  db: Db
  /** Builds `{{lead_url}}`, so the operator's notification links somewhere real. */
  publicBaseUrl: string
  /** Tests substitute one. Production leaves it unset and gets SMTP. */
  createSender?: EmailSenderFactory | undefined
}

interface TemplateRow {
  subject: string
  body: string
  enabled: boolean
}

function readTemplates(db: Db): Map<string, TemplateRow> {
  const rows = db
    .select({
      trigger: emailTemplates.trigger,
      subject: emailTemplates.subject,
      body: emailTemplates.body,
      enabled: emailTemplates.enabled,
    })
    .from(emailTemplates)
    .all()
  return new Map(rows.map((row) => [row.trigger, row]))
}

/**
 * Who the new-lead notification goes to: everyone who can sign in. There is no
 * separate recipient setting on purpose — on a single-tenant instance with one
 * or two accounts, "the people with logins" is the answer an operator would
 * have typed anyway, and it cannot drift out of date the way a copy would.
 */
function operatorRecipients(db: Db): string[] {
  return db
    .select({ email: users.email })
    .from(users)
    .orderBy(asc(users.id))
    .all()
    .map((row) => row.email)
}

/**
 * Whether this lead already has a send of its own recorded. The timeline is the
 * dedupe record: the hook is fired once per lead by construction (intake's
 * window, and the one call that actually promotes a quarantined lead), and this
 * is what holds if either of those is ever fired twice.
 */
function alreadySent(events: LeadEventRecord[], trigger: EmailTrigger): boolean {
  return events.some((event) => event.type === 'email_sent' && event.payload['template'] === trigger)
}

function recordSent(db: Db, leadId: number, trigger: EmailTrigger, subject: string, to: string[]): void {
  db.insert(leadEvents)
    .values({
      leadId,
      type: 'email_sent',
      // `template` is what alreadySent matches on, and `subject` is what the
      // timeline renders — see web/src/format.ts (describeEvent).
      payload: JSON.stringify({ template: trigger, subject, to: to.join(', ') }),
      actor: 'system',
    })
    .run()
}

interface SendPlan {
  trigger: EmailTrigger
  to: string[]
  replyTo?: string | undefined
}

/**
 * Recipients this is willing to hand to a mail server. Intake deliberately does
 * not validate the address a stranger typed (see intake/payload.ts), so this is
 * the boundary that has to: `normalizeEmailAddress` admits no whitespace, which
 * is what stops a submitted `dana@example.com\r\nBcc: …` from writing headers.
 * An address that fails is dropped rather than refused — the lead is filed
 * either way, and there was never anywhere to send it.
 */
function deliverable(addresses: (string | null)[]): string[] {
  return addresses
    .map((address) => (address === null ? undefined : normalizeEmailAddress(address)))
    .filter((address): address is string => address !== undefined)
}

function plansFor(deps: EmailDeps, lead: LeadDetail, config: EmailSettings): SendPlan[] {
  return [
    { trigger: 'new_lead_notify', to: deliverable(operatorRecipients(deps.db)) },
    {
      trigger: 'new_lead_ack',
      // A lead reachable only by phone gets no acknowledgment, which is not a
      // failure — intake accepts either contact method.
      to: deliverable([lead.email]),
      // DESIGN.md (Email): replies go to a real inbox. The From address is the
      // fallback because it is the only other one the instance knows.
      replyTo: config.replyTo === '' ? config.fromAddress : config.replyTo,
    },
  ]
}

async function sendOne(
  deps: EmailDeps,
  send: SendEmail,
  lead: LeadDetail,
  context: TemplateContext,
  templates: Map<string, TemplateRow>,
  plan: SendPlan,
): Promise<void> {
  if (plan.to.length === 0) return
  if (alreadySent(lead.events, plan.trigger)) return

  const template = templates.get(plan.trigger)
  // An operator who switched a template off has decided something; a missing
  // row means it was deleted, which is the same decision by another route.
  if (template === undefined || !template.enabled) return

  const subject = renderSubject(template.subject, context)
  const html = renderBody(template.body, context)
  if (subject === undefined || html === undefined) return

  await send({ to: plan.to, subject, html, replyTo: plan.replyTo })
  // Only after the transport accepted it — an event for a message that never
  // left would make the timeline claim something that did not happen.
  recordSent(deps.db, lead.id, plan.trigger, subject, plan.to)
}

/**
 * Both new-lead emails, best effort. Never rejects and never throws: DESIGN.md
 * (Intake endpoint) puts every downstream failure behind the 201 the form
 * already got, and the two sends are independent — a bounced acknowledgment
 * must not cost the operator their notification.
 */
export async function sendNewLeadEmails(deps: EmailDeps, leadId: number): Promise<void> {
  try {
    const lead = getLead(deps.db, leadId)
    if (lead === undefined) return
    // Belt to the callers' braces: intake and the promotion route both withhold
    // the hook for a quarantined lead already.
    if (lead.isSpam) return

    const config = readEmailSettings(deps.db)
    if (!isEmailConfigured(config)) {
      console.warn(`lead ${leadId}: no SMTP settings configured, so no email was sent`)
      return
    }

    const templates = readTemplates(deps.db)
    const context = buildContext(lead, {
      businessName: config.businessName,
      fromName: config.fromName,
      publicBaseUrl: deps.publicBaseUrl,
    })
    const send = (deps.createSender ?? smtpSender)(config)

    for (const plan of plansFor(deps, lead, config)) {
      try {
        await sendOne(deps, send, lead, context, templates, plan)
      } catch (error: unknown) {
        console.error(`lead ${leadId}: ${plan.trigger} email failed`, error)
      }
    }
  } catch (error: unknown) {
    console.error(`lead ${leadId}: new-lead email failed`, error)
  }
}

/** What `AppOptions.onLeadCreated` is wired to in production — see src/index.ts. */
export function createLeadEmailHook(deps: EmailDeps): LeadCreatedHook {
  return (lead) => {
    void sendNewLeadEmails(deps, lead.id)
  }
}

export type TestEmailError = 'not_configured' | 'invalid_email' | 'send_failed'

export type TestEmailResult =
  | { ok: true; to: string }
  | { ok: false; error: TestEmailError; detail?: string | undefined }

function failureDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, MAX_FAILURE_DETAIL)
}

/**
 * The settings screen's test-send. Unlike a lead's email this one reports its
 * failure — the whole point is telling an operator why their SMTP settings do
 * not work, and the caller is an authenticated user rather than a stranger's
 * browser.
 *
 * Sends with the settings as supplied rather than as stored, so a password
 * typed into the form can be tested before it is saved.
 */
export async function sendTestEmail(
  deps: { createSender?: EmailSenderFactory | undefined },
  config: EmailSettings,
  rawTo: unknown,
): Promise<TestEmailResult> {
  if (typeof rawTo !== 'string') return { ok: false, error: 'invalid_email' }
  const to = normalizeEmailAddress(rawTo)
  if (to === undefined) return { ok: false, error: 'invalid_email' }
  if (!isEmailConfigured(config)) return { ok: false, error: 'not_configured' }

  const send = (deps.createSender ?? smtpSender)(config)
  try {
    await send({
      to: [to],
      subject: 'Philo test email',
      html: '<p>This is a test message from Philo. Your SMTP settings work.</p>',
    })
    return { ok: true, to }
  } catch (error: unknown) {
    console.error('test email failed', error)
    return { ok: false, error: 'send_failed', detail: failureDetail(error) }
  }
}
