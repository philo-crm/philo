import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emailTemplates } from '../src/db/schema.ts'
import { DEFAULT_EMAIL_TEMPLATES } from '../src/db/seed.ts'
import {
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  SAMPLE_LEAD,
} from '../src/email/templates.ts'
import type { OutgoingEmail } from '../src/email/transport.ts'
import {
  ADMIN_EMAIL,
  cleanupTestApps,
  configureEmail,
  createTestApp,
  defaultFormKey,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from './support/app.ts'

const TEMPLATES_PATH = '/api/v1/settings/email/templates'
const NOTIFY_PATH = `${TEMPLATES_PATH}/new_lead_notify`
const ACK_PATH = `${TEMPLATES_PATH}/new_lead_ack`

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface TemplateResponse {
  trigger: string
  subject: string
  body: string
  enabled: boolean
  updatedAt: string
}

interface PreviewResponse {
  subject: string
  body: string
  leadId: number | null
}

function authed(method: string, body: unknown, cookie: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

async function listTemplates(testApp: TestApp, cookie: string): Promise<TemplateResponse[]> {
  const res = await testApp.app.request(TEMPLATES_PATH, { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { templates: TemplateResponse[] }
  return body.templates
}

async function preview(
  testApp: TestApp,
  cookie: string,
  draft: unknown,
  path = NOTIFY_PATH,
): Promise<PreviewResponse> {
  const res = await testApp.app.request(`${path}/preview`, authed('POST', draft, cookie))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { preview: PreviewResponse }
  return body.preview
}

function storedTemplate(testApp: TestApp, trigger: string): TemplateResponse | undefined {
  return testApp.db
    .select()
    .from(emailTemplates)
    .all()
    .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
    .find((row) => row.trigger === trigger)
}

/** Through the real intake endpoint, so `fields` and the stored record are real. */
async function submitLead(testApp: TestApp, payload: Record<string, unknown>): Promise<void> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status !== 201) throw new Error(`intake failed: ${res.status}`)
}

describe('GET /api/v1/settings/email/templates', () => {
  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(TEMPLATES_PATH)
    expect(res.status).toBe(401)
  })

  it('answers with the seeded pair, in seed order', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const templates = await listTemplates(testApp, cookie)

    expect(templates.map((template) => template.trigger)).toEqual([
      'new_lead_notify',
      'new_lead_ack',
    ])
    expect(templates[0]?.subject).toBe(DEFAULT_EMAIL_TEMPLATES[0].subject)
    expect(templates[0]?.enabled).toBe(true)
    expect(templates[1]?.body).toBe(DEFAULT_EMAIL_TEMPLATES[1].body)
  })
})

describe('PATCH /api/v1/settings/email/templates/:trigger', () => {
  it('stores an edited subject and body', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      ACK_PATH,
      authed('PATCH', { subject: 'Hello {{lead.name}}', body: '<p>Hi {{lead.name}}</p>' }, cookie),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { template: TemplateResponse }
    expect(body.template.subject).toBe('Hello {{lead.name}}')
    expect(storedTemplate(testApp, 'new_lead_ack')?.body).toBe('<p>Hi {{lead.name}}</p>')
  })

  it('keeps what the patch leaves out', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    await testApp.app.request(NOTIFY_PATH, authed('PATCH', { enabled: false }, cookie))

    const stored = storedTemplate(testApp, 'new_lead_notify')
    expect(stored?.enabled).toBe(false)
    expect(stored?.subject).toBe(DEFAULT_EMAIL_TEMPLATES[0].subject)
  })

  it('refuses a subject that is not valid Handlebars, and stores nothing', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      NOTIFY_PATH,
      authed('PATCH', { subject: 'New lead: {{#if lead.name}}{{lead.name}}' }, cookie),
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail?: string }
    expect(body.error).toBe('invalid_subject_template')
    // The sentence, not just the code — it is what says where the mistake is.
    expect(body.detail).toBeTypeOf('string')
    expect(body.detail?.length).toBeGreaterThan(0)
    expect(storedTemplate(testApp, 'new_lead_notify')?.subject).toBe(
      DEFAULT_EMAIL_TEMPLATES[0].subject,
    )
  })

  it('refuses a body that is not valid Handlebars, and stores nothing', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      ACK_PATH,
      authed('PATCH', { body: '<p>{{#each lead.fields}}{{this}}</p>' }, cookie),
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body_template')
    expect(storedTemplate(testApp, 'new_lead_ack')?.body).toBe(DEFAULT_EMAIL_TEMPLATES[1].body)
  })

  it('refuses an empty subject or body', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const blankSubject = await testApp.app.request(
      NOTIFY_PATH,
      authed('PATCH', { subject: '   ' }, cookie),
    )
    expect(blankSubject.status).toBe(400)
    expect(((await blankSubject.json()) as { error: string }).error).toBe('invalid_subject')

    const blankBody = await testApp.app.request(NOTIFY_PATH, authed('PATCH', { body: '' }, cookie))
    expect(((await blankBody.json()) as { error: string }).error).toBe('invalid_body')
  })

  it('refuses source past the length caps', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const longSubject = await testApp.app.request(
      NOTIFY_PATH,
      authed('PATCH', { subject: 'x'.repeat(MAX_TEMPLATE_SUBJECT_LENGTH + 1) }, cookie),
    )
    expect(((await longSubject.json()) as { error: string }).error).toBe('invalid_subject')

    const longBody = await testApp.app.request(
      NOTIFY_PATH,
      authed('PATCH', { body: 'x'.repeat(MAX_TEMPLATE_BODY_LENGTH + 1) }, cookie),
    )
    expect(((await longBody.json()) as { error: string }).error).toBe('invalid_body')
  })

  it('still switches off a template whose stored source no longer renders', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    // Only reachable by writing around the API — but an operator staring at a
    // template that cannot send needs the off switch to work regardless.
    testApp.db.update(emailTemplates).set({ subject: '{{#if}}' }).run()

    const res = await testApp.app.request(NOTIFY_PATH, authed('PATCH', { enabled: false }, cookie))

    expect(res.status).toBe(200)
    expect(storedTemplate(testApp, 'new_lead_notify')?.enabled).toBe(false)
  })

  it('404s a trigger that is not one of the pair', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      `${TEMPLATES_PATH}/stage_changed`,
      authed('PATCH', { subject: 'x' }, cookie),
    )

    expect(res.status).toBe(404)
  })

  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(NOTIFY_PATH, authed('PATCH', { enabled: false }, ''))
    expect(res.status).toBe(401)
    expect(storedTemplate(testApp, 'new_lead_notify')?.enabled).toBe(true)
  })
})

describe('POST /api/v1/settings/email/templates/:trigger/preview', () => {
  it('renders the stored template against the sample lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const rendered = await preview(testApp, cookie, {})

    expect(rendered.leadId).toBeNull()
    expect(rendered.subject).toBe(`New lead: ${SAMPLE_LEAD.name}`)
    expect(rendered.body).toContain(SAMPLE_LEAD.email)
    expect(rendered.body).toContain(`${TEST_PUBLIC_BASE_URL}/leads/${SAMPLE_LEAD.id}`)
  })

  it('renders the draft in the boxes without saving it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const rendered = await preview(testApp, cookie, {
      subject: 'Draft: {{lead.name}}',
      body: '<p>{{lead.fields.endorsements}}</p>',
    })

    expect(rendered.subject).toBe(`Draft: ${SAMPLE_LEAD.name}`)
    expect(rendered.body).toBe('<p>Hazmat, Tanker</p>')
    expect(storedTemplate(testApp, 'new_lead_notify')?.subject).toBe(
      DEFAULT_EMAIL_TEMPLATES[0].subject,
    )
  })

  it('renders against a real lead when one is named', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com', endorsements: 'Doubles' })
    const leadId = (await listLeadIds(testApp, cookie))[0]

    const rendered = await preview(testApp, cookie, {
      leadId,
      body: '<p>{{lead.name}} — {{lead.fields.endorsements}}</p>',
    })

    expect(rendered.leadId).toBe(leadId)
    expect(rendered.subject).toBe('New lead: Dana Rivers')
    expect(rendered.body).toBe('<p>Dana Rivers — Doubles</p>')
  })

  it('escapes what a stranger typed into the form', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    await submitLead(testApp, { name: '<script>alert(1)</script>', email: 'dana@example.com' })
    const leadId = (await listLeadIds(testApp, cookie))[0]

    const rendered = await preview(testApp, cookie, { leadId, body: '<p>{{lead.name}}</p>' })

    expect(rendered.body).not.toContain('<script>')
    expect(rendered.body).toContain('&lt;script&gt;')
  })

  it('refuses a lead that does not exist', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      `${NOTIFY_PATH}/preview`,
      authed('POST', { leadId: 9999 }, cookie),
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_lead')
  })

  it('reports what Handlebars said about a broken draft', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      `${NOTIFY_PATH}/preview`,
      authed('POST', { body: '{{#if lead.name}}' }, cookie),
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail?: string }
    expect(body.error).toBe('invalid_body_template')
    expect(body.detail).toBeTypeOf('string')
  })

  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(`${NOTIFY_PATH}/preview`, authed('POST', {}, ''))
    expect(res.status).toBe(401)
  })
})

async function listLeadIds(testApp: TestApp, cookie: string): Promise<number[]> {
  const res = await testApp.app.request('/api/v1/leads', { headers: { cookie } })
  const body = (await res.json()) as { leads: { id: number }[] }
  return body.leads.map((lead) => lead.id)
}

function withSender(sent: OutgoingEmail[], fail?: string) {
  return createTestApp({
    createEmailSender: () => async (email) => {
      if (fail !== undefined) throw new Error(fail)
      sent.push(email)
      return { accepted: email.to }
    },
  })
}

describe('POST /api/v1/settings/email/templates/:trigger/test', () => {
  it('sends the rendered draft to whoever is signed in', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(
      `${ACK_PATH}/test`,
      authed('POST', { subject: 'Draft: {{lead.name}}', body: '<p>Draft body</p>' }, cookie),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, to: ADMIN_EMAIL })
    expect(sent[0]?.to).toEqual([ADMIN_EMAIL])
    expect(sent[0]?.subject).toBe(`Draft: ${SAMPLE_LEAD.name}`)
    expect(sent[0]?.html).toBe('<p>Draft body</p>')
    // A test-send is a rehearsal, never a save.
    expect(storedTemplate(testApp, 'new_lead_ack')?.body).toBe(DEFAULT_EMAIL_TEMPLATES[1].body)
  })

  it('carries the acknowledgment’s reply-to, as the real send does', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp, { replyTo: 'hello@example.com' })

    await testApp.app.request(`${ACK_PATH}/test`, authed('POST', {}, cookie))
    // The notification has no reply-to in production, so its rehearsal has none.
    await testApp.app.request(`${NOTIFY_PATH}/test`, authed('POST', {}, cookie))

    expect(sent[0]?.replyTo).toBe('hello@example.com')
    expect(sent[1]?.replyTo).toBeUndefined()
  })

  it('falls back to the from address when no reply-to is set', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp, { replyTo: '' })

    await testApp.app.request(`${ACK_PATH}/test`, authed('POST', {}, cookie))

    expect(sent[0]?.replyTo).toBe('no-reply@example.com')
  })

  it('says so when SMTP has not been set up', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(`${ACK_PATH}/test`, authed('POST', {}, cookie))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_configured' })
    expect(sent).toEqual([])
  })

  it('passes the SMTP server’s complaint back to the operator', async () => {
    const testApp = withSender([], '535 authentication failed')
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(`${ACK_PATH}/test`, authed('POST', {}, cookie))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'send_failed', detail: '535 authentication failed' })
  })

  it('refuses to send a draft that does not render', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(
      `${ACK_PATH}/test`,
      authed('POST', { subject: '{{#if}}' }, cookie),
    )

    expect(res.status).toBe(400)
    expect(sent).toEqual([])
  })

  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(`${ACK_PATH}/test`, authed('POST', {}, ''))
    expect(res.status).toBe(401)
  })
})
