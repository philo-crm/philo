import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { currentUser, requireUser, type AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { ackReplyTo, sendTestEmail, type TestEmailError } from '../email/service.ts'
import {
  readEmailSettings,
  validateEmailSettings,
  writeEmailSettings,
  type EmailSettings,
} from '../email/settings.ts'
import {
  isEmailTrigger,
  listEmailTemplates,
  previewEmailTemplate,
  updateEmailTemplate,
  type EmailTemplateError,
  type TemplateResult,
} from '../email/templates.ts'
import type { EmailSenderFactory } from '../email/transport.ts'
import { readJsonBody } from '../json-body.ts'

export interface SettingsRoutesDeps {
  db: Db
  /** Builds `{{lead_url}}` in a template preview, as it does on the send path. */
  publicBaseUrl: string
  createEmailSender?: EmailSenderFactory | undefined
}

/**
 * What the settings screen reads back. The SMTP password is deliberately not on
 * it — it is write-only, and a boolean is all a form needs to say whether one is
 * stored. Round-tripping it would put the credential in every GET, in the
 * browser's memory, and in anything that logs a response body.
 */
interface EmailSettingsResponse extends Omit<EmailSettings, 'smtpPassword'> {
  smtpPasswordSet: boolean
}

function toResponse(config: EmailSettings): EmailSettingsResponse {
  const { smtpPassword, ...rest } = config
  return { ...rest, smtpPasswordSet: smtpPassword !== '' }
}

const TEST_STATUS: Record<TestEmailError, ContentfulStatusCode> = {
  invalid_email: 400,
  // The request was fine and the instance's state is what refused it.
  not_configured: 409,
  // The failure came from the SMTP server, not from here.
  send_failed: 502,
}

/** A refused template edit, with the Handlebars complaint when there is one. */
function templateError(c: Context<AuthEnv>, result: TemplateResult<unknown> & { ok: false }) {
  return c.json(
    { error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) },
    TEMPLATE_STATUS[result.error],
  )
}

const TEMPLATE_STATUS: Record<EmailTemplateError, ContentfulStatusCode> = {
  not_found: 404,
  invalid_subject: 400,
  invalid_body: 400,
  invalid_enabled: 400,
  invalid_subject_template: 400,
  invalid_body_template: 400,
  invalid_lead: 400,
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  /**
   * Session-only, this route and the two below it. The mail server's host,
   * username and password are the instance's own credentials, and the test-send
   * takes an arbitrary recipient — between them they are enough to repoint every
   * outgoing notification at somebody else's server and to send from the
   * business's identity to anyone. Nothing in the MCP tool set (DESIGN.md, MCP
   * surface) needs either, so an API key does not reach them. Templates below
   * are the deliberate exception: designing the emails is an agent's job.
   */
  routes.get('/email', requireUser, (c) => c.json({ settings: toResponse(readEmailSettings(deps.db)) }))

  /**
   * PATCH rather than PUT: a key the body leaves out keeps its stored value,
   * which is what lets the password stay write-only. Sending `""` clears it.
   */
  routes.patch('/email', requireUser, async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    // Every validation code names a field the caller got wrong, so they all
    // answer 400 — there is no state on this resource that could refuse one.
    const validated = validateEmailSettings(readEmailSettings(deps.db), body)
    if (!validated.ok) return c.json({ error: validated.error }, 400)

    writeEmailSettings(deps.db, validated.value)
    return c.json({ settings: toResponse(validated.value) })
  })

  /**
   * Sends with the settings as stored, not as typed — so the screen saves before
   * it tests, and a green result is a statement about the configuration the next
   * lead will actually be sent with.
   */
  routes.post('/email/test', requireUser, async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const result = await sendTestEmail(
      { createSender: deps.createEmailSender },
      readEmailSettings(deps.db),
      body['to'],
    )
    if (result.ok) return c.json({ ok: true, to: result.to })
    return c.json(
      { error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) },
      TEST_STATUS[result.error],
    )
  })

  routes.get('/email/templates', (c) => c.json({ templates: listEmailTemplates(deps.db) }))

  routes.patch('/email/templates/:trigger', async (c) => {
    const trigger = c.req.param('trigger')
    if (!isEmailTrigger(trigger)) return c.json({ error: 'not_found' }, 404)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const result = updateEmailTemplate(deps.db, deps.publicBaseUrl, trigger, body)
    if (!result.ok) return templateError(c, result)
    return c.json({ template: result.value })
  })

  /**
   * Renders the draft in the boxes — nothing is saved, so an operator can iterate
   * on a template without committing anything a real lead would then be sent.
   */
  routes.post('/email/templates/:trigger/preview', async (c) => {
    const trigger = c.req.param('trigger')
    if (!isEmailTrigger(trigger)) return c.json({ error: 'not_found' }, 404)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const result = previewEmailTemplate(deps.db, deps.publicBaseUrl, trigger, body)
    if (!result.ok) return templateError(c, result)
    return c.json({ preview: result.value })
  })

  /**
   * The same rendering, put through SMTP to the address of whoever is signed in.
   * Deliberately not an arbitrary recipient: the question a template test answers
   * is "does this read right in my mail client", and the operator's own inbox is
   * the only one that can answer it. Which is also why it is session-only — an
   * API key has no inbox for the answer to land in.
   */
  routes.post('/email/templates/:trigger/test', requireUser, async (c) => {
    const trigger = c.req.param('trigger')
    if (!isEmailTrigger(trigger)) return c.json({ error: 'not_found' }, 404)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const rendered = previewEmailTemplate(deps.db, deps.publicBaseUrl, trigger, body)
    if (!rendered.ok) return templateError(c, rendered)

    const config = readEmailSettings(deps.db)
    const result = await sendTestEmail(
      { createSender: deps.createEmailSender },
      config,
      currentUser(c).email,
      {
        subject: rendered.value.subject,
        html: rendered.value.body,
        // The acknowledgment carries one in production, so the rehearsal has to
        // as well — a reply-to that is wrong is exactly what this test is for.
        ...(trigger === 'new_lead_ack' ? { replyTo: ackReplyTo(config) } : {}),
      },
    )
    if (result.ok) return c.json({ ok: true, to: result.to })
    return c.json(
      { error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) },
      TEST_STATUS[result.error],
    )
  })

  return routes
}
