import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STAGES } from '../src/db/seed.ts'
import { sendNewLeadEmails } from '../src/email/service.ts'
import type { EmailSettings } from '../src/email/settings.ts'
import type { EmailSenderFactory, OutgoingEmail } from '../src/email/transport.ts'
import {
  cleanupTestApps,
  configureEmail,
  createTestApp,
  jsonPost,
  setupAdmin,
  TEST_APP_URL,
  type TestApp,
} from './support/app.ts'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface FormResponse {
  id: number
  name: string
  formKey: string
  intakeUrl: string
}

interface FunnelResponse {
  id: number
  name: string
  isDefault: boolean
  fromName: string
  replyTo: string
  notifyRecipients: string[]
  leadCount: number
  forms: FormResponse[]
}

interface StageResponse {
  id: number
  name: string
}

interface LeadResponse {
  id: number
  funnelId: number
  stageId: number
}

async function call<T>(
  testApp: TestApp,
  authorization: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await testApp.app.request(`/api/v1${path}`, {
    ...init,
    headers: { authorization, 'content-type': 'application/json', ...init.headers },
  })
  return { status: res.status, body: (await res.json()) as T }
}

async function setup() {
  const testApp = createTestApp()
  const authorization = await setupAdmin(testApp)
  return { testApp, authorization }
}

async function createFunnel(testApp: TestApp, authorization: string, name: string): Promise<FunnelResponse> {
  const { status, body } = await call<{ funnel: FunnelResponse }>(testApp, authorization, '/funnels', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  expect(status).toBe(201)
  return body.funnel
}

async function stagesOf(testApp: TestApp, authorization: string, funnelId?: number): Promise<StageResponse[]> {
  const query = funnelId === undefined ? '' : `?funnel=${funnelId}`
  const { body } = await call<{ stages: StageResponse[] }>(testApp, authorization, `/stages${query}`)
  return body.stages
}

async function submit(testApp: TestApp, formKey: string, body: Record<string, unknown>): Promise<void> {
  const res = await testApp.app.request(`/api/intake/${formKey}`, jsonPost(body))
  expect(res.status).toBe(201)
}

async function leadsOf(testApp: TestApp, authorization: string, query = ''): Promise<LeadResponse[]> {
  const { body } = await call<{ leads: LeadResponse[] }>(testApp, authorization, `/leads${query}`)
  return body.leads
}

describe('funnels', () => {
  it('starts with one default funnel that owns the seeded form', async () => {
    const { testApp, authorization } = await setup()
    const { body } = await call<{ funnels: FunnelResponse[] }>(testApp, authorization, '/funnels')
    expect(body.funnels).toHaveLength(1)
    const [funnel] = body.funnels
    expect(funnel).toMatchObject({ name: 'Default', isDefault: true, notifyRecipients: [], leadCount: 0 })
    expect(funnel?.forms).toHaveLength(1)
    expect(funnel?.forms[0]?.intakeUrl).toMatch(/\/api\/intake\/[0-9a-f]{48}$/)
  })

  it('creates a funnel born with stages, templates and a form', async () => {
    const { testApp, authorization } = await setup()
    const funnel = await createFunnel(testApp, authorization, 'Owner-operators')
    expect(funnel).toMatchObject({ name: 'Owner-operators', isDefault: false })
    expect(funnel.forms).toHaveLength(1)
    expect((await stagesOf(testApp, authorization, funnel.id)).map((stage) => stage.name)).toEqual(
      DEFAULT_STAGES.map((stage) => stage.name),
    )
    const { body } = await call<{ templates: { trigger: string }[] }>(
      testApp,
      authorization,
      `/settings/email/templates?funnel=${funnel.id}`,
    )
    expect(body.templates.map((template) => template.trigger)).toEqual(['new_lead_notify', 'new_lead_ack'])
  })

  it('refuses a blank name', async () => {
    const { testApp, authorization } = await setup()
    const { status, body } = await call(testApp, authorization, '/funnels', {
      method: 'POST',
      body: JSON.stringify({ name: '  ' }),
    })
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'invalid_name' })
  })

  it('updates the funnel-scoped settings and validates them', async () => {
    const { testApp, authorization } = await setup()
    const funnel = await createFunnel(testApp, authorization, 'Sales')
    const updated = await call<{ funnel: FunnelResponse }>(testApp, authorization, `/funnels/${funnel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Sales inquiries',
        fromName: 'Example Sales',
        replyTo: 'Sales@Example.com',
        notifyRecipients: ['a@example.com', 'A@example.com', 'b@example.com'],
      }),
    })
    expect(updated.status).toBe(200)
    expect(updated.body.funnel).toMatchObject({
      name: 'Sales inquiries',
      fromName: 'Example Sales',
      replyTo: 'sales@example.com',
      notifyRecipients: ['a@example.com', 'b@example.com'],
    })

    const bad = await call(testApp, authorization, `/funnels/${funnel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notifyRecipients: ['not an address'] }),
    })
    expect(bad).toEqual({ status: 400, body: { error: 'invalid_notify_recipients' } })

    const missing = await call(testApp, authorization, '/funnels/999', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x' }),
    })
    expect(missing.status).toBe(404)
  })

  it('deletes only an empty funnel, and never the last one', async () => {
    const { testApp, authorization } = await setup()
    const funnel = await createFunnel(testApp, authorization, 'Temporary')
    await submit(testApp, funnel.forms[0]!.formKey, { name: 'Dana', email: 'dana@example.com' })

    const occupied = await call(testApp, authorization, `/funnels/${funnel.id}`, { method: 'DELETE' })
    expect(occupied).toEqual({ status: 409, body: { error: 'funnel_not_empty' } })

    const empty = await createFunnel(testApp, authorization, 'Empty')
    const deleted = await call<{ funnels: FunnelResponse[] }>(testApp, authorization, `/funnels/${empty.id}`, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(200)
    expect(deleted.body.funnels.map((f) => f.id)).not.toContain(empty.id)
    // Its form key stops answering with it.
    const res = await testApp.app.request(`/api/intake/${empty.forms[0]!.formKey}`, jsonPost({ email: 'x@example.com' }))
    expect(res.status).toBe(404)

    const fresh = await setup()
    const [only] = (await call<{ funnels: FunnelResponse[] }>(fresh.testApp, fresh.authorization, '/funnels')).body.funnels
    const last = await call(fresh.testApp, fresh.authorization, `/funnels/${only!.id}`, { method: 'DELETE' })
    expect(last).toEqual({ status: 409, body: { error: 'last_funnel' } })
  })
})

describe('funnel-scoped stages', () => {
  it('keeps each funnel’s stages to itself', async () => {
    const { testApp, authorization } = await setup()
    const second = await createFunnel(testApp, authorization, 'Second')
    const defaultStages = await stagesOf(testApp, authorization)
    const secondStages = await stagesOf(testApp, authorization, second.id)
    expect(defaultStages.map((s) => s.id)).not.toEqual(secondStages.map((s) => s.id))

    const created = await call<{ stage: StageResponse }>(testApp, authorization, `/stages?funnel=${second.id}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Interview' }),
    })
    expect(created.status).toBe(201)
    expect((await stagesOf(testApp, authorization)).map((s) => s.name)).not.toContain('Interview')
    expect((await stagesOf(testApp, authorization, second.id)).map((s) => s.name)).toContain('Interview')
  })

  it('refuses to reorder one funnel with another’s stage ids', async () => {
    const { testApp, authorization } = await setup()
    const second = await createFunnel(testApp, authorization, 'Second')
    const ids = (await stagesOf(testApp, authorization, second.id)).map((s) => s.id).toReversed()
    const wrong = await call(testApp, authorization, '/stages/reorder', {
      method: 'POST',
      body: JSON.stringify({ stageIds: ids }),
    })
    expect(wrong).toEqual({ status: 400, body: { error: 'invalid_order' } })
    const right = await call(testApp, authorization, `/stages/reorder?funnel=${second.id}`, {
      method: 'POST',
      body: JSON.stringify({ stageIds: ids }),
    })
    expect(right.status).toBe(200)
  })

  it('answers 404 for a funnel that does not exist and 400 for a malformed one', async () => {
    const { testApp, authorization } = await setup()
    expect((await call(testApp, authorization, '/stages?funnel=999')).status).toBe(404)
    expect((await call(testApp, authorization, '/stages?funnel=abc')).status).toBe(400)
    expect((await call(testApp, authorization, '/settings/email/templates?funnel=999')).status).toBe(404)
  })
})

describe('funnel-scoped leads', () => {
  it('files a submission under the first stage of its form’s funnel', async () => {
    const { testApp, authorization } = await setup()
    const second = await createFunnel(testApp, authorization, 'Second')
    await submit(testApp, second.forms[0]!.formKey, { name: 'Dana', email: 'dana@example.com' })

    const [lead] = await leadsOf(testApp, authorization, `?funnel=${second.id}`)
    const [firstStage] = await stagesOf(testApp, authorization, second.id)
    expect(lead).toMatchObject({ funnelId: second.id, stageId: firstStage!.id })
    expect(await leadsOf(testApp, authorization, `?funnel=${second.id - 1}`)).toEqual([])
    expect(await leadsOf(testApp, authorization)).toHaveLength(1)
  })

  it('creates a lead in a named funnel and refuses a stage from another', async () => {
    const { testApp, authorization } = await setup()
    const second = await createFunnel(testApp, authorization, 'Second')
    const created = await call<{ lead: LeadResponse }>(testApp, authorization, '/leads', {
      method: 'POST',
      body: JSON.stringify({ email: 'pat@example.com', funnelId: second.id }),
    })
    expect(created.status).toBe(201)
    expect(created.body.lead.funnelId).toBe(second.id)

    const [defaultStage] = await stagesOf(testApp, authorization)
    const mismatch = await call(testApp, authorization, '/leads', {
      method: 'POST',
      body: JSON.stringify({ email: 'pat@example.com', funnelId: second.id, stageId: defaultStage!.id }),
    })
    expect(mismatch).toEqual({ status: 422, body: { error: 'invalid_stage' } })

    const unknown = await call(testApp, authorization, '/leads', {
      method: 'POST',
      body: JSON.stringify({ email: 'pat@example.com', funnelId: 999 }),
    })
    expect(unknown).toEqual({ status: 422, body: { error: 'invalid_funnel' } })
  })

  it('moves a lead into another funnel', async () => {
    const { testApp, authorization } = await setup()
    const second = await createFunnel(testApp, authorization, 'Second')
    const created = await call<{ lead: LeadResponse }>(testApp, authorization, '/leads', {
      method: 'POST',
      body: JSON.stringify({ email: 'pat@example.com' }),
    })
    const [target] = await stagesOf(testApp, authorization, second.id)
    const moved = await call<{ lead: LeadResponse }>(testApp, authorization, `/leads/${created.body.lead.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stageId: target!.id }),
    })
    expect(moved.body.lead.funnelId).toBe(second.id)
  })
})

/** Records each message with the sender name its configuration carried. */
function capturingSender(): { sent: (OutgoingEmail & { fromName: string })[]; factory: EmailSenderFactory } {
  const sent: (OutgoingEmail & { fromName: string })[] = []
  return {
    sent,
    factory: (config: EmailSettings) => async (email) => {
      sent.push({ ...email, fromName: config.fromName })
      return { accepted: email.to }
    },
  }
}

describe('funnel-scoped email', () => {
  async function funnelLead(): Promise<{ testApp: TestApp; leadId: number; funnelId: number; authorization: string }> {
    const { testApp, authorization } = await setup()
    configureEmail(testApp)
    const second = await createFunnel(testApp, authorization, 'Owner-operators')
    await submit(testApp, second.forms[0]!.formKey, { name: 'Dana', email: 'dana@example.com' })
    const [lead] = await leadsOf(testApp, authorization, `?funnel=${second.id}`)
    return { testApp, leadId: lead!.id, funnelId: second.id, authorization }
  }

  it('sends the lead’s own funnel’s templates', async () => {
    const { testApp, leadId, funnelId, authorization } = await funnelLead()
    await call(testApp, authorization, `/settings/email/templates/new_lead_ack?funnel=${funnelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Thanks from {{funnel.name}}' }),
    })
    const sender = capturingSender()
    await sendNewLeadEmails({ db: testApp.db, appUrl: TEST_APP_URL, createSender: sender.factory }, leadId)
    expect(sender.sent.map((email) => email.subject)).toContain('Thanks from Owner-operators')
  })

  it('leaves the other funnel’s templates alone', async () => {
    const { testApp, funnelId, authorization } = await funnelLead()
    await call(testApp, authorization, `/settings/email/templates/new_lead_ack?funnel=${funnelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ subject: 'Changed' }),
    })
    const { body } = await call<{ template: { subject: string } }>(
      testApp,
      authorization,
      '/settings/email/templates/new_lead_ack',
    )
    expect(body.template.subject).toBe('Thanks for getting in touch')
  })

  it('inherits the instance sender settings until the funnel overrides them', async () => {
    const { testApp, leadId, funnelId, authorization } = await funnelLead()
    const inherited = capturingSender()
    await sendNewLeadEmails({ db: testApp.db, appUrl: TEST_APP_URL, createSender: inherited.factory }, leadId)
    const notify = inherited.sent.find((email) => email.subject.startsWith('New lead'))
    const ack = inherited.sent.find((email) => email.subject.startsWith('Thanks'))
    expect(notify?.to).toEqual(['admin@example.com'])
    expect(ack).toMatchObject({ fromName: 'Example Co', replyTo: 'hello@example.com' })

    await call(testApp, authorization, `/funnels/${funnelId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fromName: 'Owner-operator Team',
        replyTo: 'owners@example.com',
        notifyRecipients: ['recruiter@example.com'],
      }),
    })
    await submit(testApp, (await call<{ funnel: FunnelResponse }>(testApp, authorization, `/funnels/${funnelId}`)).body.funnel.forms[0]!.formKey, {
      name: 'Sam',
      email: 'sam@example.com',
    })
    const [next] = await leadsOf(testApp, authorization, `?funnel=${funnelId}`)
    const overridden = capturingSender()
    await sendNewLeadEmails({ db: testApp.db, appUrl: TEST_APP_URL, createSender: overridden.factory }, next!.id)
    const notify2 = overridden.sent.find((email) => email.subject.startsWith('New lead'))
    const ack2 = overridden.sent.find((email) => email.subject.startsWith('Thanks'))
    expect(notify2?.to).toEqual(['recruiter@example.com'])
    expect(ack2).toMatchObject({ fromName: 'Owner-operator Team', replyTo: 'owners@example.com' })
  })
})
