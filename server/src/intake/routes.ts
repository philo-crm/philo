import { asc, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { clientKey } from '../client-key.ts'
import type { Db } from '../db/index.ts'
import { intakeForms, leadEvents, leads, stages } from '../db/schema.ts'
import { DedupeWindow } from './dedupe.ts'
import { TokenBucket, type TokenBucketOptions } from './rate-limit.ts'
import {
  isContactable,
  isWithinDepthLimit,
  mapSubmission,
  parseFormEncoded,
  submissionHash,
  type Submission,
} from './payload.ts'

/**
 * Ceiling on an intake body. Unauthenticated and cross-origin by design, so
 * something has to bound what a stranger can make the server buffer; a form with
 * a hundred fields is still orders of magnitude under this.
 */
export const MAX_INTAKE_BODY_BYTES = 32 * 1024

/** Submissions a single source can burst before the refill rate governs. */
export const INTAKE_BURST = 20
/** Sustained submissions per second once that burst is spent — 20 a minute. */
export const INTAKE_REFILL_PER_SECOND = 1 / 3

/** DESIGN.md (Intake endpoint): "an identical submission within ~10 minutes". */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000

/** How long a browser may cache the preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600

export interface CreatedLead {
  id: number
  formId: number
  isSpam: boolean
}

export interface IntakeDeps {
  db: Db
  /**
   * Fired once the lead is committed, and nothing it does can change the answer
   * the form gets — DESIGN.md (Intake endpoint): a failing notification must not
   * turn an accepted lead into an error. Email (#11) and push (#13) hang here.
   * Spam submissions are not announced.
   */
  onLeadCreated?: ((lead: CreatedLead) => void) | undefined
}

export interface IntakeTuning {
  rateLimit?: Partial<TokenBucketOptions>
  dedupeWindowMs?: number
}

interface IntakeForm {
  id: number
  formKey: string
  name: string
  allowedOrigins: string
}

/**
 * Origins the form's own site posts from. Stored as a JSON array; a bad value is
 * treated as an empty list rather than crashing the endpoint, since this is
 * browser etiquette (DESIGN.md) and not the thing keeping anyone out.
 */
function allowedOrigins(form: IntakeForm): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(form.allowedOrigins)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((origin): origin is string => typeof origin === 'string')
}

function isOriginAllowed(form: IntakeForm, origin: string): boolean {
  const origins = allowedOrigins(form)
  return origins.includes('*') || origins.includes(origin)
}

/**
 * CORS is per-form, so the headers can only be decided after the form is known.
 * A disallowed origin gets a normal response with no CORS headers on it — the
 * browser is what refuses, which is the whole shape of this mechanism.
 */
function applyCors(c: Context, form: IntakeForm): boolean {
  // Answers differ by origin, so a shared cache must not reuse one for another.
  c.header('Vary', 'Origin', { append: true })
  const origin = c.req.header('origin')
  if (origin === undefined || !isOriginAllowed(form, origin)) return false
  c.header('Access-Control-Allow-Origin', origin)
  return true
}

function findForm(db: Db, formKey: string): IntakeForm | undefined {
  const [form] = db
    .select({
      id: intakeForms.id,
      formKey: intakeForms.formKey,
      name: intakeForms.name,
      allowedOrigins: intakeForms.allowedOrigins,
    })
    .from(intakeForms)
    .where(eq(intakeForms.formKey, formKey))
    .limit(1)
    .all()
  return form
}

/**
 * The mapped payload, or a status to answer with. `undefined` content type and
 * anything other than the two a plain HTML form or a fetch() can send is a 415,
 * so a misconfigured integration gets told what is wrong instead of silently
 * filing an empty lead.
 */
async function readPayload(c: Context): Promise<Record<string, unknown> | undefined> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
  if (contentType.startsWith('application/json')) {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return undefined
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
    return body as Record<string, unknown>
  }
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    return parseFormEncoded(await c.req.text())
  }
  return undefined
}

function isSupportedContentType(c: Context): boolean {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
  return (
    contentType.startsWith('application/json') ||
    contentType.startsWith('application/x-www-form-urlencoded')
  )
}

/**
 * Lead and its `created` event in one transaction — DESIGN.md (Data model): the
 * timeline is written with the mutation it records, never after it. Returns
 * undefined when the instance has no stage to file the lead under, which only
 * happens if an operator deleted every one of them.
 */
function createLead(db: Db, form: IntakeForm, submission: Submission): CreatedLead | undefined {
  return db.transaction((tx) => {
    // One pipeline in the MVP; ordering by it as well keeps the choice
    // deterministic if a second one ever appears.
    const [stage] = tx
      .select({ id: stages.id })
      .from(stages)
      .orderBy(asc(stages.pipelineId), asc(stages.position), asc(stages.id))
      .limit(1)
      .all()
    if (stage === undefined) return undefined

    const [lead] = tx
      .insert(leads)
      .values({
        name: submission.name,
        email: submission.email,
        phone: submission.phone,
        source: form.name,
        formId: form.id,
        currentStageId: stage.id,
        fields: JSON.stringify(submission.fields),
        isSpam: submission.isSpam,
      })
      .returning({ id: leads.id })
      .all()
    if (lead === undefined) throw new Error('intake insert returned no lead')

    tx.insert(leadEvents)
      .values({
        leadId: lead.id,
        type: 'created',
        payload: JSON.stringify({ via: 'intake', form: form.name, isSpam: submission.isSpam }),
        actor: `form:${form.formKey}`,
      })
      .run()

    return { id: lead.id, formId: form.id, isSpam: submission.isSpam }
  })
}

export function createIntakeRoutes(deps: IntakeDeps, tuning: IntakeTuning = {}): Hono {
  const routes = new Hono()
  // Per app instance, so a test gets a fresh budget and a restart forgives.
  const bucket = new TokenBucket({
    capacity: INTAKE_BURST,
    refillPerSecond: INTAKE_REFILL_PER_SECOND,
    ...tuning.rateLimit,
  })
  const dedupe = new DedupeWindow(tuning.dedupeWindowMs ?? DEDUPE_WINDOW_MS)

  routes.use(
    '/:formKey',
    bodyLimit({
      maxSize: MAX_INTAKE_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  )

  // A submission is never cacheable, and neither is the 404 for a rotated key.
  routes.use('/:formKey', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  /**
   * Preflight. Deliberately outside the rate limit: browsers send one of these
   * per submission, so counting them would halve a form's real budget, and the
   * work is a single indexed lookup.
   */
  routes.options('/:formKey', (c) => {
    const form = findForm(deps.db, c.req.param('formKey'))
    if (form === undefined) return c.json({ error: 'not_found' }, 404)
    if (applyCors(c, form)) {
      c.header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Content-Type')
      c.header('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS))
    }
    return c.body(null, 204)
  })

  routes.post('/:formKey', async (c) => {
    // Looked up before the limit is charged, so a 429 can still carry the CORS
    // headers the form needs to read it. An unknown key therefore costs one
    // indexed lookup and no token — cheaper than the app shell this server
    // hands back for any other unmatched path, so it is not worth budgeting.
    const form = findForm(deps.db, c.req.param('formKey'))
    if (form === undefined) return c.json({ error: 'not_found' }, 404)
    applyCors(c, form)

    const key = clientKey(c)
    if (!bucket.take(key)) {
      const retryAfterSeconds = bucket.retryAfterSeconds(key)
      c.header('Retry-After', String(retryAfterSeconds))
      return c.json({ error: 'too_many_requests', retryAfterSeconds }, 429)
    }

    if (!isSupportedContentType(c)) return c.json({ error: 'unsupported_media_type' }, 415)
    const payload = await readPayload(c)
    if (payload === undefined) return c.json({ error: 'invalid_request' }, 400)
    if (!isWithinDepthLimit(payload)) return c.json({ error: 'payload_too_deep' }, 400)

    const submission = mapSubmission(payload)
    if (!isContactable(submission)) return c.json({ error: 'email_or_phone_required' }, 422)

    // Spam is accepted and answered exactly like anything else, so a bot cannot
    // tell the honeypot tripped — including through the dedupe window.
    const hash = submissionHash(form.formKey, submission)
    if (dedupe.has(hash)) return accepted(c)

    const created = createLead(deps.db, form, submission)
    if (created === undefined) return c.json({ error: 'no_stage_configured' }, 503)
    dedupe.record(hash)

    if (!created.isSpam) notify(deps, created)
    return accepted(c)
  })

  return routes
}

/**
 * The only success this endpoint has. No lead id: the poster is anonymous, and
 * an incrementing id would tell anyone who asks how many leads the business
 * gets.
 */
function accepted(c: Context) {
  return c.json({ ok: true }, 201)
}

/**
 * Downstream effects, isolated from the response. A hook that throws — or one
 * that returns a promise which rejects — is logged and dropped; the lead is
 * already committed, and an SMTP outage is not the form's problem to report.
 */
function notify(deps: IntakeDeps, lead: CreatedLead): void {
  if (deps.onLeadCreated === undefined) return
  try {
    const result = deps.onLeadCreated(lead) as unknown
    if (result instanceof Promise) result.catch(logHookFailure)
  } catch (error: unknown) {
    logHookFailure(error)
  }
}

function logHookFailure(error: unknown): void {
  console.error('intake: lead-created hook failed', error)
}
