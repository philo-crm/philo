import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emailTemplates, leadEvents, leads } from '../src/db/schema.ts'
import { createLeadEmailHook, sendNewLeadEmails, sendTestEmail } from '../src/email/service.ts'
import { DEFAULT_EMAIL_SETTINGS } from '../src/email/settings.ts'
import type { OutgoingEmail } from '../src/email/transport.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import type { CreatedLead } from '../src/notify.ts'
import {
  cleanupTestApps,
  configureEmail,
  createTestApp,
  defaultFormKey,
  recordingSender,
  setupAdmin,
  TEST_EMAIL_SETTINGS,
  type TestApp,
} from './support/app.ts'

const PUBLIC_BASE_URL = 'https://crm.example.com'

beforeEach(() => {
  // The service logs every skip and every failure. Tests assert on behaviour,
  // and a passing run should not look like a broken one.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

/** Submits through the public form with no hook attached, so nothing is sent yet. */
async function submitLead(testApp: TestApp, body: Record<string, unknown>): Promise<number> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status !== 201) throw new Error(`intake failed: ${res.status}`)
  const [lead] = testApp.db.select({ id: leads.id }).from(leads).all().toReversed()
  if (lead === undefined) throw new Error('intake created no lead')
  return lead.id
}

function sentEvents(testApp: TestApp, leadId: number) {
  return testApp.db
    .select({ payload: leadEvents.payload, actor: leadEvents.actor })
    .from(leadEvents)
    .where(eq(leadEvents.leadId, leadId))
    .all()
    .filter((event) => event.payload.includes('"template"'))
    .map((event) => ({ actor: event.actor, payload: JSON.parse(event.payload) as Record<string, unknown> }))
}

function byTemplate(sent: OutgoingEmail[], subjectFragment: string): OutgoingEmail | undefined {
  return sent.find((email) => email.subject.includes(subjectFragment))
}

describe('sendNewLeadEmails', () => {
  it('sends the notification and the acknowledgment, and records each on the timeline', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender()
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent).toHaveLength(2)
    const notify = byTemplate(sender.sent, 'New lead')
    const ack = byTemplate(sender.sent, 'Thanks for getting in touch')
    expect(notify?.to).toEqual(['admin@example.com'])
    expect(notify?.subject).toBe('New lead: Dana Rivers')
    expect(notify?.html).toContain(`${PUBLIC_BASE_URL}/leads/${leadId}`)
    expect(ack?.to).toEqual(['dana@example.com'])
    // DESIGN.md (Email): replies to the acknowledgment go to a real inbox.
    expect(ack?.replyTo).toBe(TEST_EMAIL_SETTINGS.replyTo)
    expect(ack?.html).toContain('Example Co')

    const events = sentEvents(testApp, leadId)
    expect(events.map((event) => event.payload['template']).toSorted()).toEqual([
      'new_lead_ack',
      'new_lead_notify',
    ])
    expect(events.every((event) => event.actor === 'system')).toBe(true)
    expect(events.map((event) => event.payload['subject'])).toContain('New lead: Dana Rivers')
  })

  it('sends nothing twice when the hook fires again for the same lead', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender()
    const deps = { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory }
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(deps, leadId)
    await sendNewLeadEmails(deps, leadId)

    expect(sender.sent).toHaveLength(2)
    expect(sentEvents(testApp, leadId)).toHaveLength(2)
  })

  it('sends nothing for a quarantined lead', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender()
    const leadId = await submitLead(testApp, {
      name: 'Bot',
      email: 'bot@example.com',
      [HONEYPOT_FIELD]: 'gotcha',
    })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent).toEqual([])
    expect(sentEvents(testApp, leadId)).toEqual([])
  })

  it('sends nothing when SMTP is not configured', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const sender = recordingSender()
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent).toEqual([])
    expect(sentEvents(testApp, leadId)).toEqual([])
  })

  it('respects a template that has been switched off', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    testApp.db
      .update(emailTemplates)
      .set({ enabled: false })
      .where(eq(emailTemplates.trigger, 'new_lead_ack'))
      .run()
    const sender = recordingSender()
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]?.subject).toBe('New lead: Dana Rivers')
    expect(sentEvents(testApp, leadId).map((event) => event.payload['template'])).toEqual([
      'new_lead_notify',
    ])
  })

  it('still notifies the operator when the lead left no email address', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender()
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', phone: '555-0100' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent.map((email) => email.to)).toEqual([['admin@example.com']])
  })

  it('sends the acknowledgment even when nobody has a login yet', async () => {
    const testApp = createTestApp()
    configureEmail(testApp)
    const sender = recordingSender()
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent.map((email) => email.to)).toEqual([['dana@example.com']])
  })

  it('will not send to an address a stranger wrote headers into', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender()
    // Intake stores the address as submitted — it does no format check by
    // design (intake/payload.ts), so this is the boundary that has to.
    const leadId = await submitLead(testApp, {
      name: 'Dana Rivers',
      email: 'dana@example.com\r\nBcc: attacker@example.com',
    })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    // The operator still hears about the lead; only the acknowledgment is dropped.
    expect(sender.sent.map((email) => email.to)).toEqual([['admin@example.com']])
    expect(sentEvents(testApp, leadId).map((event) => event.payload['template'])).toEqual([
      'new_lead_notify',
    ])
  })

  it('isolates one failed send from the other, and records no event for it', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const sender = recordingSender({ failOn: (email) => email.to.includes('dana@example.com') })
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      leadId,
    )

    expect(sender.sent.map((email) => email.to)).toEqual([['admin@example.com']])
    expect(sentEvents(testApp, leadId).map((event) => event.payload['template'])).toEqual([
      'new_lead_notify',
    ])
  })

  it('retries the failed half on a later run, without repeating the delivered one', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    let failing = true
    const sent: OutgoingEmail[] = []
    const deps = {
      db: testApp.db,
      publicBaseUrl: PUBLIC_BASE_URL,
      createSender: () => async (email: OutgoingEmail) => {
        if (failing && email.to.includes('dana@example.com')) throw new Error('greylisted')
        sent.push(email)
      },
    }
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })

    await sendNewLeadEmails(deps, leadId)
    failing = false
    await sendNewLeadEmails(deps, leadId)

    expect(sent.map((email) => email.to)).toEqual([['admin@example.com'], ['dana@example.com']])
  })

  it('does nothing for a lead that no longer exists', async () => {
    const testApp = createTestApp()
    configureEmail(testApp)
    const sender = recordingSender()
    await sendNewLeadEmails(
      { db: testApp.db, publicBaseUrl: PUBLIC_BASE_URL, createSender: sender.factory },
      9999,
    )
    expect(sender.sent).toEqual([])
  })
})

describe('createLeadEmailHook', () => {
  it('never lets a send failure reach the caller', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    configureEmail(testApp)
    const leadId = await submitLead(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
    const hook = createLeadEmailHook({
      db: testApp.db,
      publicBaseUrl: PUBLIC_BASE_URL,
      createSender: () => () => Promise.reject(new Error('smtp is down')),
    })

    const lead: CreatedLead = { id: leadId, formId: null, isSpam: false }
    expect(() => hook(lead)).not.toThrow()
    // Let the fire-and-forget send settle; an unhandled rejection would fail here.
    await new Promise((resolve) => setImmediate(resolve))
  })
})

describe('intake with email attached', () => {
  it('answers 201 even when every send fails', async () => {
    let pending: Promise<void> = Promise.resolve()
    const testApp = createTestApp({
      onLeadCreated: (lead) => {
        pending = sendNewLeadEmails(
          {
            db: testApp.db,
            publicBaseUrl: PUBLIC_BASE_URL,
            createSender: () => () => Promise.reject(new Error('smtp is down')),
          },
          lead.id,
        )
      },
    })
    await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dana Rivers', email: 'dana@example.com' }),
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('sendTestEmail', () => {
  it('sends to the address it was given', async () => {
    const sender = recordingSender()
    const result = await sendTestEmail({ createSender: sender.factory }, TEST_EMAIL_SETTINGS, 'Ops@Example.com')

    expect(result).toEqual({ ok: true, to: 'ops@example.com' })
    expect(sender.sent[0]?.to).toEqual(['ops@example.com'])
  })

  it('refuses an address that is not one', async () => {
    const sender = recordingSender()
    for (const to of ['not-an-address', '', 42]) {
      expect(await sendTestEmail({ createSender: sender.factory }, TEST_EMAIL_SETTINGS, to)).toEqual({
        ok: false,
        error: 'invalid_email',
      })
    }
    expect(sender.sent).toEqual([])
  })

  it('reports that nothing is configured rather than attempting a send', async () => {
    const sender = recordingSender()
    const result = await sendTestEmail(
      { createSender: sender.factory },
      DEFAULT_EMAIL_SETTINGS,
      'ops@example.com',
    )

    expect(result).toEqual({ ok: false, error: 'not_configured' })
    expect(sender.sent).toEqual([])
  })

  it('hands back why the server refused it', async () => {
    const result = await sendTestEmail(
      { createSender: () => () => Promise.reject(new Error('535 authentication failed')) },
      TEST_EMAIL_SETTINGS,
      'ops@example.com',
    )

    expect(result).toEqual({ ok: false, error: 'send_failed', detail: '535 authentication failed' })
  })
})
