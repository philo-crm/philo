import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readEmailSettings } from '../src/email/settings.ts'
import type { OutgoingEmail } from '../src/email/transport.ts'
import {
  cleanupTestApps,
  configureEmail,
  createTestApp,
  setupAdmin,
  TEST_ORIGIN,
  type TestApp,
} from './support/app.ts'

const EMAIL_PATH = '/api/v1/settings/email'
const TEST_PATH = '/api/v1/settings/email/test'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface EmailSettingsResponse {
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUsername: string
  smtpPasswordSet: boolean
  fromName: string
  fromAddress: string
  replyTo: string
  businessName: string
}

function authed(method: string, body: unknown, cookie: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

async function readSettings(testApp: TestApp, cookie: string): Promise<EmailSettingsResponse> {
  const res = await testApp.app.request(EMAIL_PATH, { headers: { cookie } })
  if (res.status !== 200) throw new Error(`GET settings failed: ${res.status}`)
  const body = (await res.json()) as { settings: EmailSettingsResponse }
  return body.settings
}

describe('GET /api/v1/settings/email', () => {
  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(EMAIL_PATH)
    expect(res.status).toBe(401)
  })

  it('answers with defaults on a fresh instance', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    expect(await readSettings(testApp, cookie)).toEqual({
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: '',
      smtpPasswordSet: false,
      fromName: '',
      fromAddress: '',
      replyTo: '',
      businessName: '',
    })
  })

  it('never hands back the stored password', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(EMAIL_PATH, { headers: { cookie } })
    const raw = await res.text()

    expect(raw).not.toContain('secret-token')
    expect((JSON.parse(raw) as { settings: EmailSettingsResponse }).settings.smtpPasswordSet).toBe(true)
  })
})

describe('PATCH /api/v1/settings/email', () => {
  it('stores what it was given and answers with the result', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      EMAIL_PATH,
      authed(
        'PATCH',
        {
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpSecure: true,
          smtpUsername: 'apikey',
          smtpPassword: 'secret-token',
          fromName: 'Example Co',
          fromAddress: 'No-Reply@Example.com',
          replyTo: 'hello@example.com',
          businessName: 'Example Co',
        },
        cookie,
      ),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: EmailSettingsResponse }
    expect(body.settings.smtpPort).toBe(465)
    expect(body.settings.smtpSecure).toBe(true)
    expect(body.settings.fromAddress).toBe('no-reply@example.com')
    expect(body.settings.smtpPasswordSet).toBe(true)
    expect(JSON.stringify(body)).not.toContain('secret-token')
    expect(readEmailSettings(testApp.db).smtpPassword).toBe('secret-token')
  })

  it('keeps the stored password when the patch does not mention it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(
      EMAIL_PATH,
      authed('PATCH', { smtpHost: 'smtp2.example.com' }, cookie),
    )

    expect(res.status).toBe(200)
    const stored = readEmailSettings(testApp.db)
    expect(stored.smtpHost).toBe('smtp2.example.com')
    expect(stored.smtpPassword).toBe('secret-token')
    expect(stored.fromAddress).toBe('no-reply@example.com')
  })

  it('clears the password when the patch sends an empty one', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    await testApp.app.request(EMAIL_PATH, authed('PATCH', { smtpPassword: '' }, cookie))

    expect(readEmailSettings(testApp.db).smtpPassword).toBe('')
    expect((await readSettings(testApp, cookie)).smtpPasswordSet).toBe(false)
  })

  it('names the field it refused, and stores nothing', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      EMAIL_PATH,
      authed('PATCH', { smtpHost: 'smtp.example.com', fromAddress: 'nope' }, cookie),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_from_address' })
    expect(readEmailSettings(testApp.db).smtpHost).toBe('')
  })

  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      EMAIL_PATH,
      authed('PATCH', { smtpHost: 'smtp.example.com' }, ''),
    )
    expect(res.status).toBe(401)
  })
})

function withSender(sent: OutgoingEmail[], fail?: string) {
  return createTestApp({
    createEmailSender: () => async (email) => {
      if (fail !== undefined) throw new Error(fail)
      sent.push(email)
      return { accepted: email.to }
    },
  })
}

describe('POST /api/v1/settings/email/test', () => {
  it('sends with the stored settings', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(TEST_PATH, authed('POST', { to: 'ops@example.com' }, cookie))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, to: 'ops@example.com' })
    expect(sent[0]?.to).toEqual(['ops@example.com'])
    expect(sent[0]?.subject).toBe('Philo test email')
  })

  it('refuses an address that is not one', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(TEST_PATH, authed('POST', { to: 'nope' }, cookie))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_email' })
    expect(sent).toEqual([])
  })

  it('says so when SMTP has not been set up', async () => {
    const sent: OutgoingEmail[] = []
    const testApp = withSender(sent)
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(TEST_PATH, authed('POST', { to: 'ops@example.com' }, cookie))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_configured' })
    expect(sent).toEqual([])
  })

  it('passes the SMTP server’s complaint back to the operator', async () => {
    const testApp = withSender([], '535 authentication failed')
    const cookie = await setupAdmin(testApp)
    configureEmail(testApp)

    const res = await testApp.app.request(TEST_PATH, authed('POST', { to: 'ops@example.com' }, cookie))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'send_failed', detail: '535 authentication failed' })
  })

  it('refuses a caller without a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(TEST_PATH, authed('POST', { to: 'ops@example.com' }, ''))
    expect(res.status).toBe(401)
  })
})
