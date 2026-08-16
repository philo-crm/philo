import { and, asc, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { emailTemplates, leadEvents, leads, users } from '../db/schema.ts'
import { getLead, CREATED_VIA_API, type LeadDetail, type LeadEventRecord } from '../leads/service.ts'
import type { LeadCreatedHook } from '../notify.ts'
import { buildContext, renderBody, renderSubject, type TemplateContext } from './render.ts'
import {
  maxAttempts,
  retryDelayMs,
  scheduleWithTimer,
  SWEEP_LIMIT,
  SWEEP_WINDOW_MS,
  type RetryTuning,
  type ScheduleRetry,
} from './retry.ts'
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
  /** Attempt count and backoff curve. Defaults are the production ones. */
  retry?: RetryTuning | undefined
  /** How a delayed retry is booked. Tests pass one that runs without waiting. */
  scheduleRetry?: ScheduleRetry | undefined
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

/**
 * Whether this trigger was already given up on. Durable for the same reason the
 * sent record is: the attempt budget lives in memory, so without a mark on the
 * timeline every boot's sweep would spend the whole budget again and append
 * another identical note — the per-attempt spam that `recordGaveUp` exists to
 * avoid, arriving one boot at a time instead.
 */
function gaveUp(events: LeadEventRecord[], trigger: EmailTrigger): boolean {
  return events.some((event) => event.payload['emailFailed'] === trigger)
}

/** Nothing more is owed for this trigger, whether it got through or not. */
function settled(events: LeadEventRecord[], trigger: EmailTrigger): boolean {
  return alreadySent(events, trigger) || gaveUp(events, trigger)
}

/**
 * Whether the lead was entered rather than submitted — `createLead` stamps
 * `CREATED_VIA_API` on its `created` event. Nothing was ever owed for one:
 * DESIGN.md (Email) sends only for a submission that arrived.
 *
 * Read from the timeline rather than trusted to the caller, because the hook is
 * not the only road here. The sweep below asks the same question of every recent
 * lead with no send recorded, and to it a lead the hook was never fired for is
 * indistinguishable from one whose process died mid-send.
 */
function wasEntered(events: LeadEventRecord[]): boolean {
  return events.some((event) => event.type === 'created' && event.payload['via'] === CREATED_VIA_API)
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

/**
 * A send Philo has given up on, on the lead's own timeline. ADR-0004 makes
 * email the guaranteed channel, and a failure that exists only in stdout is one
 * nobody reading the lead will ever know about — which is the silently-missed
 * lead that ADR is written against.
 *
 * Written once, after the last attempt, never per attempt: a greylisting loop
 * would otherwise put five identical notes on a timeline a person reads.
 *
 * Recorded as a system note rather than a new event type: the four types in
 * DESIGN.md (Data model) are the contract, and `clearLeadSpam` already
 * establishes that a system-authored note is how a fact reaches the timeline
 * without changing it.
 */
function recordGaveUp(db: Db, leadId: number, failure: SendFailure, attempts: number): void {
  const reason = failureDetail(failure.error) ?? 'no reason given'
  db.insert(leadEvents)
    .values({
      leadId,
      type: 'note_added',
      payload: JSON.stringify({
        note:
          `Could not send the ${failure.trigger} email after ` +
          `${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}. ` +
          'Philo will not try this one again.',
        system: true,
        // Machine-readable alongside the sentence: this is what `gaveUp` reads,
        // so a later sweep knows the decision was already made.
        emailFailed: failure.trigger,
      }),
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

/**
 * Where a reply to the acknowledgment lands — DESIGN.md (Email): a real inbox.
 * The From address is the fallback because it is the only other one the instance
 * knows. Shared with the settings screen's template test-send, so a rehearsal
 * carries the same header the real message will.
 */
export function ackReplyTo(config: EmailSettings): string {
  return config.replyTo === '' ? config.fromAddress : config.replyTo
}

function plansFor(deps: EmailDeps, lead: LeadDetail, config: EmailSettings): SendPlan[] {
  return [
    { trigger: 'new_lead_notify', to: deliverable(operatorRecipients(deps.db)) },
    {
      trigger: 'new_lead_ack',
      // A lead reachable only by phone gets no acknowledgment, which is not a
      // failure — intake accepts either contact method.
      to: deliverable([lead.email]),
      replyTo: ackReplyTo(config),
    },
  ]
}

/**
 * Nothing to send is not the same as a send that failed, so the two answers are
 * distinguishable — only the second belongs on the timeline as a failure.
 */
type SendOutcome = { status: 'skipped' } | { status: 'sent'; subject: string; accepted: string[] }

const SKIPPED = { status: 'skipped' } as const

/**
 * Renders and sends one of the pair, and reports what happened. It deliberately
 * writes nothing: the caller records the outcome, so a database that refuses
 * the row cannot be mistaken for a message that failed to leave.
 */
async function sendOne(
  send: SendEmail,
  lead: LeadDetail,
  context: TemplateContext,
  templates: Map<string, TemplateRow>,
  plan: SendPlan,
): Promise<SendOutcome> {
  if (plan.to.length === 0) return SKIPPED
  if (settled(lead.events, plan.trigger)) return SKIPPED

  const template = templates.get(plan.trigger)
  // An operator who switched a template off has decided something; a missing
  // row means it was deleted, which is the same decision by another route.
  if (template === undefined || !template.enabled) return SKIPPED

  const subject = renderSubject(template.subject, context)
  const html = renderBody(template.body, context)
  if (subject === undefined || html === undefined) return SKIPPED

  const { accepted } = await send({ to: plan.to, subject, html, replyTo: plan.replyTo })
  // Only the addresses the server took — an event for a message that never
  // left would make the timeline claim something that did not happen. A send
  // where it took none is a failure even though the transport did not say so.
  if (accepted.length === 0) throw new Error('no recipient was accepted')
  if (accepted.length < plan.to.length) {
    const refused = plan.to.filter((address) => !accepted.includes(address))
    console.error(`lead ${lead.id}: ${plan.trigger} email refused for ${refused.join(', ')}`)
  }
  return { status: 'sent', subject, accepted }
}

/**
 * A timeline write, isolated. The message has already left — or already failed
 * — by the time this runs, so a refused row (a locked database during a backup,
 * say) must not decide whether the other email is attempted.
 */
function record(leadId: number, write: () => void): void {
  try {
    write()
  } catch (error: unknown) {
    console.error(`lead ${leadId}: could not record the email on the timeline`, error)
  }
}

/** A trigger that was attempted and did not get through, and why. */
interface SendFailure {
  trigger: EmailTrigger
  error: unknown
}

/**
 * One pass at both emails. Returns the triggers that failed — an empty list
 * means there is nothing left owed, whether because everything went out or
 * because nothing was owed in the first place.
 *
 * Never rejects and never throws: DESIGN.md (Intake endpoint) puts every
 * downstream failure behind the 201 the form already got, and the two sends are
 * independent — a bounced acknowledgment must not cost the operator their
 * notification.
 */
async function attemptNewLeadEmails(deps: EmailDeps, leadId: number): Promise<SendFailure[]> {
  const failures: SendFailure[] = []
  try {
    const lead = getLead(deps.db, leadId)
    if (lead === undefined) return failures
    // Belt to the callers' braces: intake and the promotion route both withhold
    // the hook for a quarantined lead already.
    if (lead.isSpam) return failures
    // Not belt-and-braces: `createLead` fires no hook at all, so the sweep is
    // the only caller that ever reaches one of these, and this is the whole of
    // what keeps an agent-filed lead from being emailed at the next boot.
    if (wasEntered(lead.events)) return failures

    const config = readEmailSettings(deps.db)
    if (!isEmailConfigured(config)) {
      // Not a failure to retry: nothing about waiting a minute changes it, and
      // the next boot's sweep picks the lead up once SMTP is filled in.
      console.warn(`lead ${leadId}: no SMTP settings configured, so no email was sent`)
      return failures
    }

    const templates = readTemplates(deps.db)
    const context = buildContext(lead, {
      businessName: config.businessName,
      fromName: config.fromName,
      publicBaseUrl: deps.publicBaseUrl,
    })
    const send = (deps.createSender ?? smtpSender)(config)

    for (const plan of plansFor(deps, lead, config)) {
      let outcome: SendOutcome
      try {
        outcome = await sendOne(send, lead, context, templates, plan)
      } catch (error: unknown) {
        console.error(`lead ${leadId}: ${plan.trigger} email failed`, error)
        failures.push({ trigger: plan.trigger, error })
        continue
      }
      if (outcome.status === 'sent') {
        record(leadId, () => recordSent(deps.db, leadId, plan.trigger, outcome.subject, outcome.accepted))
      }
    }
  } catch (error: unknown) {
    console.error(`lead ${leadId}: new-lead email failed`, error)
  }
  return failures
}

/**
 * Leads currently being worked, so the boot sweep and a live intake cannot both
 * be mid-send for the same one. Single-tenant means one process, so a set in
 * memory is the whole of the coordination this needs — and `alreadySent` is
 * still the durable guard behind it.
 */
const inFlight = new Set<number>()

/**
 * Both new-lead emails, retried on failure until they get through or the
 * attempt budget runs out. ADR-0004 makes email the guaranteed channel;
 * greylisting — a receiver refusing a first-time sender and accepting the same
 * message minutes later — is the ordinary case a single attempt loses to.
 *
 * Resolves as soon as one attempt is done. Later attempts are booked on a timer
 * and nothing awaits them, so a caller never waits on a retry.
 */
export async function sendNewLeadEmails(deps: EmailDeps, leadId: number, attempt = 1): Promise<void> {
  // Dropping this call rather than queueing it is safe because the pass already
  // running will book its own retry for anything it fails to send — so the lead
  // stays covered by that chain instead of gaining a second one.
  if (inFlight.has(leadId)) return
  inFlight.add(leadId)
  let failures: SendFailure[]
  try {
    failures = await attemptNewLeadEmails(deps, leadId)
  } finally {
    inFlight.delete(leadId)
  }
  if (failures.length === 0) return

  const limit = maxAttempts(deps.retry)
  if (attempt >= limit) {
    for (const failure of failures) {
      console.error(`lead ${leadId}: giving up on the ${failure.trigger} email after ${limit} attempts`)
      record(leadId, () => recordGaveUp(deps.db, leadId, failure, limit))
    }
    return
  }

  const delay = retryDelayMs(attempt, deps.retry)
  console.warn(`lead ${leadId}: retrying ${failures.length} email(s) in ${Math.round(delay / 1000)}s`)
  // A retry re-reads the lead and its timeline, so a trigger that did get
  // through on this pass is skipped by `alreadySent` on the next one.
  ;(deps.scheduleRetry ?? scheduleWithTimer)(() => {
    void sendNewLeadEmails(deps, leadId, attempt + 1)
  }, delay)
}

/** What `AppOptions.onLeadCreated` is wired to in production — see src/index.ts. */
export function createLeadEmailHook(deps: EmailDeps): LeadCreatedHook {
  return (lead) => {
    void sendNewLeadEmails(deps, lead.id)
  }
}

/**
 * Every non-spam lead recent enough to still be owed an email. Deliberately not
 * a query that works out which trigger is outstanding: `sendNewLeadEmails`
 * already decides that per lead from the timeline, and a second copy of that
 * rule in SQL is one that can drift out of agreement with the first. For a lead
 * that needs nothing this costs two indexed reads.
 */
export function leadsAwaitingEmail(db: Db, since: Date, limit = SWEEP_LIMIT): number[] {
  return db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.isSpam, false), gte(leads.createdAt, since)))
    // Oldest first, so the cap drops the newest rather than the oldest. The
    // oldest are the ones about to fall out of the window and never be looked
    // at again; the newest are still inside it at the next boot.
    .orderBy(asc(leads.createdAt))
    .limit(limit)
    .all()
    .map((row) => row.id)
}

/**
 * Catches up anything the last run of the process left owed — the retry
 * schedule lives in memory, so without this a restart mid-backoff drops it, and
 * a lead that arrived while SMTP was misconfigured would never be revisited.
 *
 * Never throws: this runs at boot, and an instance that will not start because
 * a mail server is down is worse than one that missed a notification.
 */
export async function sweepUnsentEmails(deps: EmailDeps, now = new Date()): Promise<number> {
  try {
    const since = new Date(now.getTime() - SWEEP_WINDOW_MS)
    const pending = leadsAwaitingEmail(deps.db, since)
    if (pending.length === SWEEP_LIMIT) {
      // Never silently: a truncated sweep looks exactly like a complete one.
      console.warn(`email sweep hit its ${SWEEP_LIMIT}-lead ceiling; older leads in the window were skipped`)
    }
    for (const leadId of pending) await sendNewLeadEmails(deps, leadId)
    return pending.length
  } catch (error: unknown) {
    console.error('email sweep failed', error)
    return 0
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

/** What a test-send puts in the message when the caller does not supply one. */
const SMTP_TEST_MESSAGE = {
  subject: 'Philo test email',
  html: '<p>This is a test message from Philo. Your SMTP settings work.</p>',
}

/**
 * The settings screen's test-send. Unlike a lead's email this one reports its
 * failure — the whole point is telling an operator why their SMTP settings do
 * not work, and the caller is an authenticated user rather than a stranger's
 * browser.
 *
 * The configuration is passed in rather than read here, and every caller passes
 * the stored one — so the screen saves before it tests, and a green result is a
 * statement about what the next real lead will be sent with.
 */
export async function sendTestEmail(
  deps: { createSender?: EmailSenderFactory | undefined },
  config: EmailSettings,
  rawTo: unknown,
  /** A rendered template, when the thing being tested is the template rather than SMTP. */
  message: { subject: string; html: string; replyTo?: string | undefined } = SMTP_TEST_MESSAGE,
): Promise<TestEmailResult> {
  if (typeof rawTo !== 'string') return { ok: false, error: 'invalid_email' }
  const to = normalizeEmailAddress(rawTo)
  if (to === undefined) return { ok: false, error: 'invalid_email' }
  if (!isEmailConfigured(config)) return { ok: false, error: 'not_configured' }

  const send = (deps.createSender ?? smtpSender)(config)
  try {
    const { accepted } = await send({ to: [to], ...message })
    // A server that connected, authenticated, and then refused the recipient is
    // not a working configuration, however cheerfully the transport returned.
    if (accepted.length === 0) return { ok: false, error: 'send_failed', detail: 'the server refused the recipient' }
    return { ok: true, to }
  } catch (error: unknown) {
    console.error('test email failed', error)
    return { ok: false, error: 'send_failed', detail: failureDetail(error) }
  }
}
