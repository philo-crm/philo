import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildContext, renderBody, renderSubject, MAX_SUBJECT_LENGTH } from '../src/email/render.ts'
import { retryDelayMs, MAX_SEND_ATTEMPTS } from '../src/email/retry.ts'
import {
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_SMTP_PORT,
  MAX_HOST_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  isEmailConfigured,
  normalizeEmailAddress,
  readEmailSettings,
  validateEmailSettings,
  writeEmailSettings,
  type EmailSettings,
} from '../src/email/settings.ts'
import { cleanupTestApps, createTestApp, TEST_EMAIL_SETTINGS } from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
  vi.restoreAllMocks()
})

const LEAD = {
  id: 42,
  name: 'Dana Rivers',
  email: 'dana@example.com',
  phone: '555-0100',
  source: 'Careers form',
  fields: { years_experience: 7, endorsements: ['Hazmat'] },
}

function context(overrides: Partial<Parameters<typeof buildContext>[0]> = {}) {
  return buildContext(
    { ...LEAD, ...overrides },
    { businessName: 'Example Co', fromName: 'Example Co Mail', publicBaseUrl: 'https://crm.example.com' },
  )
}

describe('buildContext', () => {
  it('exposes the variables DESIGN.md lists', () => {
    const built = context()
    expect(built.lead.name).toBe('Dana Rivers')
    expect(built.lead.fields['years_experience']).toBe(7)
    expect(built.business.name).toBe('Example Co')
    expect(built.lead_url).toBe('https://crm.example.com/leads/42')
  })

  it('falls back to the sender name when no business name is set', () => {
    const built = buildContext(LEAD, {
      businessName: '',
      fromName: 'Example Co Mail',
      publicBaseUrl: 'https://crm.example.com',
    })
    expect(built.business.name).toBe('Example Co Mail')
  })

  it('does not double the slash when the base url has a trailing one', () => {
    const built = buildContext(LEAD, {
      businessName: 'Example Co',
      fromName: '',
      publicBaseUrl: 'https://crm.example.com/',
    })
    expect(built.lead_url).toBe('https://crm.example.com/leads/42')
  })
})

describe('renderBody', () => {
  it('substitutes lead, business and url variables', () => {
    const html = renderBody('<p>{{lead.name}} · {{business.name}} · {{lead_url}}</p>', context())
    expect(html).toBe('<p>Dana Rivers · Example Co · https://crm.example.com/leads/42</p>')
  })

  it('reads nested field values', () => {
    expect(renderBody('{{lead.fields.years_experience}}', context())).toBe('7')
  })

  it('renders a missing contact field and an absent variable as nothing', () => {
    const built = context({ name: null, phone: null })
    expect(renderBody('[{{lead.name}}][{{lead.phone}}][{{lead.fields.nope}}][{{nothing}}]', built)).toBe(
      '[][][][]',
    )
  })

  it('escapes what a stranger typed into the form', () => {
    const built = context({ name: '<script>alert(1)</script>' })
    const html = renderBody('<p>{{lead.name}}</p>', built)
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('returns undefined for a template that does not compile', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(renderBody('{{#if lead.name}}unclosed', context())).toBeUndefined()
  })
})

describe('renderSubject', () => {
  it('leaves entities alone, because a subject is not HTML', () => {
    const built = context({ name: 'Ben & Co' })
    expect(renderSubject('New lead: {{lead.name}}', built)).toBe('New lead: Ben & Co')
  })

  it('truncates a subject a stranger made enormous', () => {
    const built = context({ name: 'D'.repeat(5_000) })
    const subject = renderSubject('New lead: {{lead.name}}', built)

    expect(subject).toHaveLength(MAX_SUBJECT_LENGTH)
    expect(subject?.endsWith('…')).toBe(true)
  })

  it('leaves a subject that already fits exactly alone', () => {
    const built = context({ name: 'D'.repeat(MAX_SUBJECT_LENGTH) })
    expect(renderSubject('{{lead.name}}', built)).toBe('D'.repeat(MAX_SUBJECT_LENGTH))
  })

  it('collapses newlines, so a submitted name cannot write headers', () => {
    const built = context({ name: 'Dana\r\nBcc: attacker@example.com' })
    expect(renderSubject('New lead: {{lead.name}}', built)).toBe(
      'New lead: Dana Bcc: attacker@example.com',
    )
  })
})

describe('retryDelayMs', () => {
  it('doubles per attempt', () => {
    const tuning = { baseDelayMs: 1_000, maxDelayMs: 60_000 }
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, tuning))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ])
  })

  it('stops doubling at the cap', () => {
    const tuning = { baseDelayMs: 1_000, maxDelayMs: 5_000 }
    expect(retryDelayMs(10, tuning)).toBe(5_000)
  })

  it('spans a useful stretch on the production curve', () => {
    const total = Array.from({ length: MAX_SEND_ATTEMPTS - 1 }, (_, index) => retryDelayMs(index + 1))
    // Long enough for greylisting to clear, short enough that an operator is
    // not told about a dead mail server an hour after the lead arrived.
    expect(total.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(10 * 60 * 1000)
    expect(total.reduce((sum, delay) => sum + delay, 0)).toBeLessThan(60 * 60 * 1000)
  })
})

describe('normalizeEmailAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmailAddress('  Dana@Example.COM ')).toBe('dana@example.com')
  })

  it('rejects the shapes that are certainly mistakes', () => {
    for (const raw of ['', '   ', 'dana', 'dana@example', 'dana example.com', `${'a'.repeat(250)}@example.com`]) {
      expect(normalizeEmailAddress(raw)).toBeUndefined()
    }
  })
})

describe('isEmailConfigured', () => {
  it('needs both a host and a sender address', () => {
    expect(isEmailConfigured(DEFAULT_EMAIL_SETTINGS)).toBe(false)
    expect(isEmailConfigured({ ...DEFAULT_EMAIL_SETTINGS, smtpHost: 'smtp.example.com' })).toBe(false)
    expect(isEmailConfigured({ ...DEFAULT_EMAIL_SETTINGS, fromAddress: 'a@example.com' })).toBe(false)
    expect(isEmailConfigured(TEST_EMAIL_SETTINGS)).toBe(true)
  })
})

function validated(patch: Record<string, unknown>, current: EmailSettings = DEFAULT_EMAIL_SETTINGS) {
  return validateEmailSettings(current, patch)
}

describe('validateEmailSettings', () => {
  it('leaves a key the patch does not name alone', () => {
    const result = validated({ smtpHost: 'smtp.example.com' }, TEST_EMAIL_SETTINGS)
    expect(result.ok && result.value.smtpPassword).toBe(TEST_EMAIL_SETTINGS.smtpPassword)
    expect(result.ok && result.value.smtpHost).toBe('smtp.example.com')
  })

  it('clears a value with an explicit empty string', () => {
    const result = validated({ smtpPassword: '', replyTo: '' }, TEST_EMAIL_SETTINGS)
    expect(result.ok && result.value.smtpPassword).toBe('')
    expect(result.ok && result.value.replyTo).toBe('')
  })

  it('does not trim a password, because spaces in one are legal', () => {
    const result = validated({ smtpPassword: '  spaced  ' })
    expect(result.ok && result.value.smtpPassword).toBe('  spaced  ')
  })

  it('normalizes addresses', () => {
    const result = validated({ fromAddress: ' Sender@Example.COM ', replyTo: 'Hello@Example.com' })
    expect(result.ok && result.value.fromAddress).toBe('sender@example.com')
    expect(result.ok && result.value.replyTo).toBe('hello@example.com')
  })

  it('names the field that was wrong', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ smtpHost: 42 }, 'invalid_smtp_host'],
      [{ smtpHost: 'a'.repeat(MAX_HOST_LENGTH + 1) }, 'invalid_smtp_host'],
      [{ smtpPort: 0 }, 'invalid_smtp_port'],
      [{ smtpPort: 70000 }, 'invalid_smtp_port'],
      [{ smtpPort: '587' }, 'invalid_smtp_port'],
      [{ smtpPort: 587.5 }, 'invalid_smtp_port'],
      [{ smtpSecure: 'true' }, 'invalid_smtp_secure'],
      [{ smtpUsername: null }, 'invalid_smtp_username'],
      [{ smtpPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) }, 'invalid_smtp_password'],
      [{ fromName: 'a'.repeat(MAX_NAME_LENGTH + 1) }, 'invalid_from_name'],
      [{ fromAddress: 'not-an-address' }, 'invalid_from_address'],
      [{ replyTo: 'also-not-one' }, 'invalid_reply_to'],
      [{ businessName: 'a'.repeat(MAX_NAME_LENGTH + 1) }, 'invalid_business_name'],
    ]
    for (const [patch, error] of cases) {
      const result = validated(patch)
      expect(result.ok, JSON.stringify(patch)).toBe(false)
      expect(!result.ok && result.error, JSON.stringify(patch)).toBe(error)
    }
  })
})

describe('readEmailSettings / writeEmailSettings', () => {
  it('defaults every value on a fresh database', () => {
    const testApp = createTestApp()
    expect(readEmailSettings(testApp.db)).toEqual(DEFAULT_EMAIL_SETTINGS)
  })

  it('round-trips a written configuration', () => {
    const testApp = createTestApp()
    writeEmailSettings(testApp.db, TEST_EMAIL_SETTINGS)
    expect(readEmailSettings(testApp.db)).toEqual(TEST_EMAIL_SETTINGS)
  })

  it('overwrites rather than appending on a second write', () => {
    const testApp = createTestApp()
    writeEmailSettings(testApp.db, TEST_EMAIL_SETTINGS)
    writeEmailSettings(testApp.db, { ...TEST_EMAIL_SETTINGS, smtpHost: 'smtp2.example.com' })
    expect(readEmailSettings(testApp.db).smtpHost).toBe('smtp2.example.com')
  })

  it('falls back to the default port rather than refusing a hand-edited row', () => {
    const testApp = createTestApp()
    writeEmailSettings(testApp.db, { ...TEST_EMAIL_SETTINGS, smtpPort: 2525 })
    // Writing through drizzle cannot produce this; a person with sqlite3 can.
    testApp.db.$client.prepare("UPDATE settings SET value = 'nonsense' WHERE key = 'email.smtp_port'").run()
    expect(readEmailSettings(testApp.db).smtpPort).toBe(DEFAULT_SMTP_PORT)
  })
})
