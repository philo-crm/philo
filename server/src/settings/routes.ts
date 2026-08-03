import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { sendTestEmail, type TestEmailError } from '../email/service.ts'
import {
  readEmailSettings,
  validateEmailSettings,
  writeEmailSettings,
  type EmailSettings,
} from '../email/settings.ts'
import type { EmailSenderFactory } from '../email/transport.ts'
import { readJsonBody } from '../json-body.ts'

export interface SettingsRoutesDeps {
  db: Db
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

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  routes.get('/email', (c) => c.json({ settings: toResponse(readEmailSettings(deps.db)) }))

  /**
   * PATCH rather than PUT: a key the body leaves out keeps its stored value,
   * which is what lets the password stay write-only. Sending `""` clears it.
   */
  routes.patch('/email', async (c) => {
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
  routes.post('/email/test', async (c) => {
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

  return routes
}
