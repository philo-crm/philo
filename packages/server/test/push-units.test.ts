import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LeadRecord } from '../src/leads/service.ts'
import { loadOrCreateVapidKeys, vapidSubject, VAPID_KEYS_FILENAME } from '../src/push/keys.ts'
import { buildLeadNotification } from '../src/push/service.ts'
import { validateSubscription } from '../src/push/subscriptions.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-vapid-'))
  tempDirs.push(dir)
  return dir
}

describe('loadOrCreateVapidKeys', () => {
  it('generates a pair on first boot and reports having done so', () => {
    const result = loadOrCreateVapidKeys(dataDir())
    expect(result.generated).toBe(true)
    expect(result.keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns the same pair on every later boot', () => {
    const dir = dataDir()
    const first = loadOrCreateVapidKeys(dir)
    const second = loadOrCreateVapidKeys(dir)
    expect(second.generated).toBe(false)
    expect(second.keys).toEqual(first.keys)
  })

  it('writes the file readable only by its owner', () => {
    const dir = dataDir()
    loadOrCreateVapidKeys(dir)
    const mode = statSync(join(dir, VAPID_KEYS_FILENAME)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  // A process killed mid-write leaves a file that parses to nothing usable.
  // Regenerating costs a re-subscribe; refusing to boot costs the whole instance.
  it.each([
    ['empty', ''],
    ['malformed', '{not json'],
    ['missing the private key', '{"publicKey":"abc"}'],
    ['holding a non-string key', '{"publicKey":"abc","privateKey":123}'],
  ])('replaces a %s key file', (_label, contents) => {
    const dir = dataDir()
    writeFileSync(join(dir, VAPID_KEYS_FILENAME), contents)

    const result = loadOrCreateVapidKeys(dir)

    expect(result.generated).toBe(true)
    expect(result.keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    // And the replacement is what a later boot reads back.
    expect(loadOrCreateVapidKeys(dir)).toEqual({ keys: result.keys, generated: false })
  })

  it('repairs the permissions on a file left behind with loose ones', () => {
    const dir = dataDir()
    const path = join(dir, VAPID_KEYS_FILENAME)
    writeFileSync(path, '', { mode: 0o644 })
    chmodSync(path, 0o644)

    loadOrCreateVapidKeys(dir)

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('stores the pair as readable JSON, so an operator can back it up', () => {
    const dir = dataDir()
    const { keys } = loadOrCreateVapidKeys(dir)
    const parsed = JSON.parse(readFileSync(join(dir, VAPID_KEYS_FILENAME), 'utf8')) as unknown
    expect(parsed).toEqual(keys)
  })
})

describe('vapidSubject', () => {
  it('uses the deployment URL, so no operator address reaches a push service', () => {
    expect(vapidSubject('https://crm.example.com', 'admin@example.com')).toBe('https://crm.example.com')
  })

  // web-push refuses anything that is not https: or mailto:, and the default
  // base URL is http://localhost — the one place the fallback is reached.
  it('falls back to the operator address when the base URL is not https', () => {
    expect(vapidSubject('http://localhost:3000', 'admin@example.com')).toBe('mailto:admin@example.com')
  })

  it('has no answer for a plain-http instance with no accounts yet', () => {
    expect(vapidSubject('http://localhost:3000', undefined)).toBeUndefined()
    expect(vapidSubject('http://localhost:3000', '')).toBeUndefined()
  })
})

describe('validateSubscription', () => {
  const ENDPOINT = 'https://push.example.com/subscription/abc123'
  const KEYS = { p256dh: 'BNc-key', auth: 'auth-secret' }

  it('accepts the nested shape a browser serializes', () => {
    const result = validateSubscription({ endpoint: ENDPOINT, keys: KEYS })
    expect(result).toEqual({ ok: true, value: { endpoint: ENDPOINT, ...KEYS } })
  })

  it('accepts the flat shape too', () => {
    const result = validateSubscription({ endpoint: ENDPOINT, ...KEYS })
    expect(result).toEqual({ ok: true, value: { endpoint: ENDPOINT, ...KEYS } })
  })

  // The endpoint is a URL this server makes outbound requests to, so a stored
  // http:// or file:// one would point the process wherever a caller liked.
  it.each([
    ['http', 'http://push.example.com/abc'],
    ['file', 'file:///etc/passwd'],
    ['not a URL at all', 'push.example.com/abc'],
    ['empty', ''],
  ])('refuses a %s endpoint', (_label, endpoint) => {
    expect(validateSubscription({ endpoint, keys: KEYS })).toEqual({
      ok: false,
      error: 'invalid_subscription',
    })
  })

  it('refuses an endpoint longer than any push service issues', () => {
    const endpoint = `https://push.example.com/${'a'.repeat(2_000)}`
    expect(validateSubscription({ endpoint, keys: KEYS }).ok).toBe(false)
  })

  // A key stored with characters the encoding does not have is one that fails
  // at send time, on the channel nothing reports.
  it.each([
    ['a missing p256dh', { auth: 'auth-secret' }],
    ['a missing auth', { p256dh: 'BNc-key' }],
    ['an empty key', { p256dh: '', auth: 'auth-secret' }],
    ['a non-string key', { p256dh: 42, auth: 'auth-secret' }],
    ['plain base64 padding', { p256dh: 'BNc+key/==', auth: 'auth-secret' }],
  ])('refuses %s', (_label, keys) => {
    expect(validateSubscription({ endpoint: ENDPOINT, keys })).toEqual({
      ok: false,
      error: 'invalid_subscription',
    })
  })

  it('refuses a key longer than the cap', () => {
    const keys = { p256dh: 'a'.repeat(201), auth: 'auth-secret' }
    expect(validateSubscription({ endpoint: ENDPOINT, keys }).ok).toBe(false)
  })
})

describe('buildLeadNotification', () => {
  const LEAD: LeadRecord = {
    id: 42,
    name: 'Dana Rivers',
    email: 'dana@example.com',
    phone: '555-0100',
    source: 'Careers form',
    formId: 1,
    stageId: 1,
    stageName: 'New',
    isSpam: false,
    fields: {},
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  }

  function build(overrides: Partial<typeof LEAD> = {}, baseUrl = 'https://crm.example.com') {
    return buildLeadNotification({ ...LEAD, ...overrides }, baseUrl)
  }

  it('carries the declarative version tag Safari renders without a service worker', () => {
    expect(build().web_push).toBe(8030)
  })

  it('names the lead and lists the contact details', () => {
    expect(build().notification).toMatchObject({
      title: 'New lead: Dana Rivers',
      body: 'dana@example.com · 555-0100 · Careers form',
      navigate: 'https://crm.example.com/leads/42',
      tag: 'philo-lead-42',
    })
  })

  it('still says something for a lead with no name', () => {
    expect(build({ name: null }).notification.title).toBe('New lead')
    expect(build({ name: '   ' }).notification.title).toBe('New lead')
  })

  it('says where to look when there is no contact detail at all', () => {
    expect(build({ email: null, phone: null, source: null }).notification.body).toBe(
      'Open Philo to see the details.',
    )
  })

  it('skips the details that are missing rather than leaving gaps', () => {
    expect(build({ phone: null, source: null }).notification.body).toBe('dana@example.com')
  })

  // A push has a size budget, and nothing on a lock screen reads this far.
  it('clamps text a submitter made enormous', () => {
    const { title, body } = build({ name: 'D'.repeat(500), email: 'e'.repeat(500) }).notification
    expect(title).toHaveLength(200)
    expect(title.endsWith('…')).toBe(true)
    expect(body).toHaveLength(200)
  })

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(build({}, 'https://crm.example.com/').notification.navigate).toBe(
      'https://crm.example.com/leads/42',
    )
  })
})
