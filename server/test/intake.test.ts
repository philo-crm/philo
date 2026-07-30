import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leadEvents, leads, stages } from '../src/db/schema.ts'
import { HONEYPOT_FIELD } from '../src/intake/payload.ts'
import { MAX_INTAKE_BODY_BYTES } from '../src/intake/routes.ts'
import {
  cleanupTestApps,
  createIntakeForm,
  createTestApp,
  defaultFormKey,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

const SITE_ORIGIN = 'https://careers.example.com'

function intakeUrl(formKey: string): string {
  return `/api/intake/${formKey}`
}

function jsonSubmission(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

function formSubmission(body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  }
}

async function submit(testApp: TestApp, formKey: string, body: unknown): Promise<Response> {
  return testApp.app.request(intakeUrl(formKey), jsonSubmission(body))
}

function allLeads(testApp: TestApp) {
  return testApp.db.select().from(leads).all()
}

describe('POST /api/intake/{form_key}', () => {
  it('creates a lead from a JSON submission', async () => {
    const testApp = createTestApp()
    const res = await submit(testApp, defaultFormKey(testApp), {
      name: 'Dana Rivers',
      email: 'Dana@Example.com',
      phone: '555-0100',
      years_experience: 7,
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(allLeads(testApp)).toMatchObject([
      {
        name: 'Dana Rivers',
        email: 'dana@example.com',
        phone: '555-0100',
        isSpam: false,
        fields: JSON.stringify({ years_experience: 7 }),
      },
    ])
  })

  it('creates a lead from a plain HTML form post', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      intakeUrl(defaultFormKey(testApp)),
      formSubmission('first_name=Dana&last_name=Rivers&phone=555-0100&endorsements=hazmat'),
    )

    expect(res.status).toBe(201)
    expect(allLeads(testApp)).toMatchObject([
      { name: 'Dana Rivers', email: null, phone: '555-0100', fields: JSON.stringify({ endorsements: 'hazmat' }) },
    ])
  })

  it('stores a field named __proto__ rather than dropping it', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(intakeUrl(defaultFormKey(testApp)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"dana@example.com","__proto__":{"admin":true}}',
    })

    expect(res.status).toBe(201)
    expect(allLeads(testApp)).toMatchObject([{ fields: '{"__proto__":{"admin":true}}' }])
  })

  it('files the lead against the form and its first stage', async () => {
    const testApp = createTestApp()
    await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })

    const [first] = testApp.db.select().from(stages).orderBy(stages.position).limit(1).all()
    expect(allLeads(testApp)).toMatchObject([{ source: 'Default', formId: 1, currentStageId: first!.id }])
  })

  it('records a created event naming the form as the actor', async () => {
    const testApp = createTestApp()
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { email: 'dana@example.com' })

    const [lead] = allLeads(testApp)
    const events = testApp.db.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id)).all()
    expect(events).toMatchObject([{ type: 'created', actor: `form:${formKey}` }])
  })

  it('never caches a submission', async () => {
    const testApp = createTestApp()
    const res = await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('rejects a submission with neither email nor phone', async () => {
    const testApp = createTestApp()
    const res = await submit(testApp, defaultFormKey(testApp), { name: 'Dana Rivers' })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'email_or_phone_required' })
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('404s an unknown form key', async () => {
    const testApp = createTestApp()
    const res = await submit(testApp, 'not-a-real-key', { email: 'dana@example.com' })

    expect(res.status).toBe(404)
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('415s a content type no form can send', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(intakeUrl(defaultFormKey(testApp)), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'email=dana@example.com',
    })

    expect(res.status).toBe(415)
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('400s a malformed JSON body', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(intakeUrl(defaultFormKey(testApp)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":',
    })

    expect(res.status).toBe(400)
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('400s a payload nested past what the search index can walk', async () => {
    const testApp = createTestApp()
    let nested: unknown = 'bottom'
    for (let i = 0; i < 12; i += 1) nested = { deeper: nested }
    const res = await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com', nested })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'payload_too_deep' })
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('413s a body over the size cap, with headers the form can read', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission(
        { email: 'dana@example.com', essay: 'x'.repeat(MAX_INTAKE_BODY_BYTES + 1) },
        { origin: SITE_ORIGIN },
      ),
    )

    expect(res.status).toBe(413)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(allLeads(testApp)).toHaveLength(0)
  })

  it('guards the whole subtree, not just the key segment', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(
      `${intakeUrl(formKey)}/anything`,
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )

    // No handler is mounted there, so this 404s — but through the middleware,
    // which is what a route added under the key later would rely on.
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
  })

  it('never lets a cache pin the 404 for a rotated key', async () => {
    const testApp = createTestApp()
    const res = await submit(testApp, 'not-a-real-key', { email: 'dana@example.com' })

    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('503s rather than crashing when no stage is left to file under', async () => {
    const testApp = createTestApp()
    testApp.db.delete(stages).run()
    const res = await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })

    expect(res.status).toBe(503)
    expect(allLeads(testApp)).toHaveLength(0)
  })
})

describe('honeypot', () => {
  it('accepts a filled honeypot as spam, indistinguishably', async () => {
    const testApp = createTestApp()
    const formKey = defaultFormKey(testApp)
    const clean = await submit(testApp, formKey, { email: 'dana@example.com' })
    const trapped = await submit(testApp, formKey, {
      email: 'bot@example.com',
      [HONEYPOT_FIELD]: 'http://spam.example.com',
    })

    expect(trapped.status).toBe(clean.status)
    expect(await trapped.json()).toEqual(await clean.json())
    expect(allLeads(testApp)).toMatchObject([
      { email: 'dana@example.com', isSpam: false },
      { email: 'bot@example.com', isSpam: true },
    ])
  })

  it('does not fire downstream notifications for spam', async () => {
    const onLeadCreated = vi.fn()
    const testApp = createTestApp({ onLeadCreated })
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { email: 'bot@example.com', [HONEYPOT_FIELD]: 'x' })
    expect(onLeadCreated).not.toHaveBeenCalled()

    await submit(testApp, formKey, { email: 'dana@example.com' })
    expect(onLeadCreated).toHaveBeenCalledWith({ id: 2, formId: 1, isSpam: false })
  })

  it('still returns 201 when a downstream notification rejects', async () => {
    const onLeadCreated = vi.fn(() => Promise.reject(new Error('push endpoint is gone')) as unknown as void)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const testApp = createTestApp({ onLeadCreated })
    const res = await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })

    expect(res.status).toBe(201)
    expect(allLeads(testApp)).toHaveLength(1)
    // The rejection is handled a microtask later than the response.
    await Promise.resolve()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('still returns 201 when a downstream notification throws', async () => {
    const onLeadCreated = vi.fn(() => {
      throw new Error('smtp is down')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const testApp = createTestApp({ onLeadCreated })
    const res = await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })

    expect(res.status).toBe(201)
    expect(allLeads(testApp)).toHaveLength(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('idempotency', () => {
  it('answers a repeated submission without creating a second lead', async () => {
    const testApp = createTestApp()
    const formKey = defaultFormKey(testApp)
    const body = { name: 'Dana Rivers', email: 'dana@example.com', years_experience: 7 }

    const first = await submit(testApp, formKey, body)
    const second = await submit(testApp, formKey, body)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(await second.json()).toEqual({ ok: true })
    expect(allLeads(testApp)).toHaveLength(1)
  })

  it('fires downstream notifications only for the first of the pair', async () => {
    const onLeadCreated = vi.fn()
    const testApp = createTestApp({ onLeadCreated })
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { email: 'dana@example.com' })
    await submit(testApp, formKey, { email: 'dana@example.com' })

    expect(onLeadCreated).toHaveBeenCalledTimes(1)
  })

  it('matches across encodings, since the answers are what is compared', async () => {
    const testApp = createTestApp()
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { name: 'Dana Rivers', phone: '555-0100' })
    const second = await testApp.app.request(
      intakeUrl(formKey),
      formSubmission('name=Dana+Rivers&phone=555-0100'),
    )

    expect(second.status).toBe(201)
    expect(allLeads(testApp)).toHaveLength(1)
  })

  it('lets a genuinely different submission through', async () => {
    const testApp = createTestApp()
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { email: 'dana@example.com' })
    await submit(testApp, formKey, { email: 'sam@example.com' })

    expect(allLeads(testApp)).toHaveLength(2)
  })

  it('does not dedupe one form against another', async () => {
    const testApp = createTestApp()
    const other = createIntakeForm(testApp, 'second-form-key', ['*'])
    await submit(testApp, defaultFormKey(testApp), { email: 'dana@example.com' })
    await submit(testApp, other, { email: 'dana@example.com' })

    expect(allLeads(testApp)).toHaveLength(2)
  })

  it('forgets a submission once the window closes', async () => {
    const testApp = createTestApp({ intakeTuning: { dedupeWindowMs: 0 } })
    const formKey = defaultFormKey(testApp)
    await submit(testApp, formKey, { email: 'dana@example.com' })
    await submit(testApp, formKey, { email: 'dana@example.com' })

    expect(allLeads(testApp)).toHaveLength(2)
  })
})

describe('CORS', () => {
  it('echoes an allowed origin', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
    expect(res.headers.get('Vary')).toContain('Origin')
  })

  it('accepts the submission from a disallowed origin but sends no CORS headers', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'dana@example.com' }, { origin: 'https://elsewhere.example.com' }),
    )

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('honours a wildcard by echoing the caller rather than a star', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      intakeUrl(defaultFormKey(testApp)),
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
  })

  it('allows nothing cross-origin for a form with an empty allowlist', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [])
    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('answers a preflight from an allowed origin', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(intakeUrl(formKey), {
      method: 'OPTIONS',
      headers: { origin: SITE_ORIGIN, 'access-control-request-method': 'POST' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type')
  })

  it('withholds the preflight answer from a disallowed origin', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    const res = await testApp.app.request(intakeUrl(formKey), {
      method: 'OPTIONS',
      headers: { origin: 'https://elsewhere.example.com', 'access-control-request-method': 'POST' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull()
  })

  it('404s a preflight for an unknown form key', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(intakeUrl('not-a-real-key'), {
      method: 'OPTIONS',
      headers: { origin: SITE_ORIGIN },
    })

    expect(res.status).toBe(404)
  })

  it('treats an unparseable allowlist as allowing nothing', async () => {
    const testApp = createTestApp()
    const formKey = createIntakeForm(testApp, 'careers-key', [])
    testApp.db.$client
      .prepare('UPDATE intake_forms SET allowed_origins = ? WHERE form_key = ?')
      .run('not json', formKey)
    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('rate limit', () => {
  it('refuses past the burst and says when to come back', async () => {
    const testApp = createTestApp({ intakeTuning: { rateLimit: { capacity: 2, refillPerSecond: 1 } } })
    const formKey = defaultFormKey(testApp)

    expect((await submit(testApp, formKey, { email: 'a@example.com' })).status).toBe(201)
    expect((await submit(testApp, formKey, { email: 'b@example.com' })).status).toBe(201)

    const refused = await submit(testApp, formKey, { email: 'c@example.com' })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('1')
    expect(allLeads(testApp)).toHaveLength(2)
  })

  it('still carries CORS headers, so the form can read the refusal', async () => {
    const testApp = createTestApp({ intakeTuning: { rateLimit: { capacity: 1, refillPerSecond: 1 } } })
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    await testApp.app.request(intakeUrl(formKey), jsonSubmission({ email: 'a@example.com' }, { origin: SITE_ORIGIN }))
    const refused = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'b@example.com' }, { origin: SITE_ORIGIN }),
    )

    expect(refused.status).toBe(429)
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN)
  })

  it('does not charge preflights against the submission budget', async () => {
    const testApp = createTestApp({ intakeTuning: { rateLimit: { capacity: 1, refillPerSecond: 1 } } })
    const formKey = createIntakeForm(testApp, 'careers-key', [SITE_ORIGIN])
    for (let i = 0; i < 5; i += 1) {
      await testApp.app.request(intakeUrl(formKey), { method: 'OPTIONS', headers: { origin: SITE_ORIGIN } })
    }

    const res = await testApp.app.request(
      intakeUrl(formKey),
      jsonSubmission({ email: 'dana@example.com' }, { origin: SITE_ORIGIN }),
    )
    expect(res.status).toBe(201)
  })
})

describe('rate limit behind a reverse proxy', () => {
  function submitAs(testApp: TestApp, formKey: string, forwardedFor: string, email: string) {
    return testApp.app.request(intakeUrl(formKey), jsonSubmission({ email }, { 'x-forwarded-for': forwardedFor }))
  }

  it('gives each forwarded caller its own budget', async () => {
    const testApp = createTestApp({
      trustedProxyHops: 1,
      intakeTuning: { rateLimit: { capacity: 1, refillPerSecond: 1 } },
    })
    const formKey = defaultFormKey(testApp)

    expect((await submitAs(testApp, formKey, '203.0.113.7', 'a@example.com')).status).toBe(201)
    expect((await submitAs(testApp, formKey, '203.0.113.7', 'b@example.com')).status).toBe(429)
    // A different visitor is not paying for the first one's flood.
    expect((await submitAs(testApp, formKey, '203.0.113.9', 'c@example.com')).status).toBe(201)
  })

  it('does not let a spoofed prefix buy a fresh budget', async () => {
    const testApp = createTestApp({
      trustedProxyHops: 1,
      intakeTuning: { rateLimit: { capacity: 1, refillPerSecond: 1 } },
    })
    const formKey = defaultFormKey(testApp)

    expect((await submitAs(testApp, formKey, '203.0.113.7', 'a@example.com')).status).toBe(201)
    const spoofed = await submitAs(testApp, formKey, '198.51.100.1, 203.0.113.7', 'b@example.com')
    expect(spoofed.status).toBe(429)
  })

  it('ignores the header when the operator has not said a proxy is there', async () => {
    const testApp = createTestApp({ intakeTuning: { rateLimit: { capacity: 1, refillPerSecond: 1 } } })
    const formKey = defaultFormKey(testApp)

    expect((await submitAs(testApp, formKey, '203.0.113.7', 'a@example.com')).status).toBe(201)
    expect((await submitAs(testApp, formKey, '203.0.113.9', 'b@example.com')).status).toBe(429)
  })
})

describe('the seeded default form', () => {
  it('exists on a fresh instance with an unguessable key', () => {
    const testApp = createTestApp()
    expect(defaultFormKey(testApp)).toMatch(/^[0-9a-f]{48}$/)
  })

  it('gets a different key on every install', () => {
    expect(defaultFormKey(createTestApp())).not.toBe(defaultFormKey(createTestApp()))
  })
})
