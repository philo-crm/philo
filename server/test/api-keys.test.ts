import { desc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiKeyDisplayPrefix,
  createApiKey,
  generateApiKey,
  hashApiKey,
  listApiKeys,
  resolveApiKey,
  revokeApiKey,
  validateApiKeyName,
  API_KEY_LAST_USED_RESOLUTION_MS,
  API_KEY_PREFIX,
  MAX_API_KEY_NAME_LENGTH,
} from '../src/auth/api-keys.ts'
import { bearerToken } from '../src/auth/middleware.ts'
import { apiKeys, leads } from '../src/db/schema.ts'
import {
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

const KEYS_BASE = '/api/v1/api-keys'

/** A request carrying an API key the way a script or an agent would. */
function bearer(key: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${key}` } }
}

function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie } }
}

/** Creates a key through the API, as the settings screen does, and hands back its secret. */
async function mintKey(
  testApp: TestApp,
  cookie: string,
  name = 'Claude Code',
): Promise<{ id: number; secret: string }> {
  const res = await testApp.app.request(KEYS_BASE, withCookie(cookie, jsonPost({ name })))
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { key: { id: number }; secret: string }
  return { id: body.key.id, secret: body.secret }
}

async function submitLead(testApp: TestApp): Promise<number> {
  const res = await testApp.app.request(
    `/api/intake/${defaultFormKey(testApp)}`,
    jsonPost({ name: 'Sam Rivera', email: 'sam@example.com' }),
  )
  if (!res.ok) throw new Error(`intake failed: ${res.status}`)
  const [lead] = testApp.db.select({ id: leads.id }).from(leads).orderBy(desc(leads.id)).limit(1).all()
  if (lead === undefined) throw new Error('intake stored no lead')
  return lead.id
}

describe('api key values', () => {
  it('mints prefixed, unguessable, distinct secrets', () => {
    const first = generateApiKey()
    const second = generateApiKey()

    expect(first.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(first).not.toBe(second)
    // 32 random bytes as base64url, past the prefix.
    expect(first.length - API_KEY_PREFIX.length).toBe(43)
  })

  it('hashes deterministically, and differently per key', () => {
    const key = generateApiKey()
    expect(hashApiKey(key)).toBe(hashApiKey(key))
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()))
    expect(hashApiKey(key)).not.toContain(key)
  })

  it('keeps only a labelling slice of the secret', () => {
    const key = `${API_KEY_PREFIX}abcdefghijklmnop`
    expect(apiKeyDisplayPrefix(key)).toBe(`${API_KEY_PREFIX}abcdef`)
  })

  it('takes a trimmed name and refuses an empty or oversized one', () => {
    expect(validateApiKeyName('  Cron job  ')).toBe('Cron job')
    expect(validateApiKeyName('')).toBeUndefined()
    expect(validateApiKeyName('   ')).toBeUndefined()
    expect(validateApiKeyName(7)).toBeUndefined()
    expect(validateApiKeyName('x'.repeat(MAX_API_KEY_NAME_LENGTH))).toHaveLength(
      MAX_API_KEY_NAME_LENGTH,
    )
    expect(validateApiKeyName('x'.repeat(MAX_API_KEY_NAME_LENGTH + 1))).toBeUndefined()
  })

  it('reads a bearer credential, scheme case aside, and nothing else', () => {
    expect(bearerToken('Bearer philo_abc')).toBe('philo_abc')
    expect(bearerToken('bearer philo_abc')).toBe('philo_abc')
    expect(bearerToken('  Bearer   philo_abc  ')).toBe('philo_abc')
    expect(bearerToken('Basic philo_abc')).toBeUndefined()
    expect(bearerToken('philo_abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('api key storage', () => {
  it('stores a hash and a prefix, never the secret', () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Cron job')

    const [row] = testApp.db.select().from(apiKeys).all()
    expect(row?.keyHash).toBe(hashApiKey(key))
    expect(JSON.stringify(row)).not.toContain(key.slice(API_KEY_PREFIX.length))
  })

  it('resolves a live key and refuses anything else', () => {
    const testApp = createTestApp()
    const { key, record } = createApiKey(testApp.db, 'Cron job')

    expect(resolveApiKey(testApp.db, key)).toEqual({ id: record.id, name: 'Cron job' })
    expect(resolveApiKey(testApp.db, generateApiKey())).toBeUndefined()
    // No prefix: rejected before it can even be looked up.
    expect(resolveApiKey(testApp.db, 'not-a-philo-key')).toBeUndefined()
    expect(resolveApiKey(testApp.db, '')).toBeUndefined()
  })

  it('stamps last use, then leaves it alone until the resolution has passed', () => {
    const testApp = createTestApp()
    const { key, record } = createApiKey(testApp.db, 'Cron job')
    const start = new Date('2026-08-01T10:00:00.000Z')

    expect(listApiKeys(testApp.db)[0]?.lastUsedAt).toBeNull()

    resolveApiKey(testApp.db, key, start)
    expect(listApiKeys(testApp.db)[0]?.lastUsedAt).toEqual(start)

    const soon = new Date(start.getTime() + API_KEY_LAST_USED_RESOLUTION_MS - 1)
    resolveApiKey(testApp.db, key, soon)
    expect(listApiKeys(testApp.db)[0]?.lastUsedAt).toEqual(start)

    const later = new Date(start.getTime() + API_KEY_LAST_USED_RESOLUTION_MS)
    resolveApiKey(testApp.db, key, later)
    expect(listApiKeys(testApp.db)[0]?.lastUsedAt).toEqual(later)

    expect(record.lastUsedAt).toBeNull()
  })

  it('revokes once, and says so when there is nothing left to revoke', () => {
    const testApp = createTestApp()
    const { key, record } = createApiKey(testApp.db, 'Cron job')

    expect(revokeApiKey(testApp.db, record.id)).toBe(true)
    expect(revokeApiKey(testApp.db, record.id)).toBe(false)
    expect(resolveApiKey(testApp.db, key)).toBeUndefined()
  })

  it('lists newest first', () => {
    const testApp = createTestApp()
    createApiKey(testApp.db, 'First')
    createApiKey(testApp.db, 'Second')

    expect(listApiKeys(testApp.db).map((row) => row.name)).toEqual(['Second', 'First'])
  })
})

describe('api key management', () => {
  it('hands the secret back exactly once', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(KEYS_BASE, withCookie(cookie, jsonPost({ name: 'Cron job' })))
    expect(res.status).toBe(201)
    const created = (await res.json()) as { key: Record<string, unknown>; secret: string }
    expect(created.secret.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(created.key['keyPrefix']).toBe(apiKeyDisplayPrefix(created.secret))
    expect(created.key['lastUsedAt']).toBeNull()

    const list = await testApp.app.request(KEYS_BASE, withCookie(cookie))
    const body = (await list.json()) as { keys: Record<string, unknown>[] }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]?.['name']).toBe('Cron job')
    // The one property of the whole scheme: it is not readable again.
    expect(JSON.stringify(body)).not.toContain(created.secret)
  })

  it('trims the name and refuses one that says nothing', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const named = await testApp.app.request(KEYS_BASE, withCookie(cookie, jsonPost({ name: '  Cron  ' })))
    expect(((await named.json()) as { key: { name: string } }).key.name).toBe('Cron')

    for (const name of ['', '   ', 'x'.repeat(MAX_API_KEY_NAME_LENGTH + 1), 42]) {
      const res = await testApp.app.request(KEYS_BASE, withCookie(cookie, jsonPost({ name })))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_name' })
    }
  })

  it('refuses an id that is not one', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    for (const id of ['abc', '0', '-1', '1.5']) {
      const res = await testApp.app.request(
        `${KEYS_BASE}/${id}`,
        withCookie(cookie, { ...jsonPost({}), method: 'DELETE' }),
      )
      expect(res.status).toBe(400)
    }
  })

  it('answers 404 for a key that is already gone', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { id } = await mintKey(testApp, cookie)

    const revoke = () =>
      testApp.app.request(`${KEYS_BASE}/${id}`, withCookie(cookie, { ...jsonPost({}), method: 'DELETE' }))

    expect((await revoke()).status).toBe(200)
    expect((await revoke()).status).toBe(404)
  })

  it('is closed to anyone not signed in', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)

    const res = await testApp.app.request(KEYS_BASE)
    expect(res.status).toBe(401)
  })
})

describe('bearer authentication', () => {
  it('authenticates a REST call, and stops the moment the key is revoked', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, cookie)

    const authenticated = await testApp.app.request('/api/v1/leads', bearer(secret))
    expect(authenticated.status).toBe(200)

    const revoked = await testApp.app.request(
      `${KEYS_BASE}/${id}`,
      withCookie(cookie, { ...jsonPost({}), method: 'DELETE' }),
    )
    expect(revoked.status).toBe(200)

    const after = await testApp.app.request('/api/v1/leads', bearer(secret))
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ error: 'unauthorized' })
  })

  it('records the key on the timeline, not a user', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, cookie)
    const leadId = await submitLead(testApp)

    const stages = (await (await testApp.app.request('/api/v1/stages', bearer(secret))).json()) as {
      stages: { id: number }[]
    }
    const target = stages.stages[1]?.id
    const moved = await testApp.app.request(
      `/api/v1/leads/${leadId}/stage`,
      bearer(secret, jsonPost({ stageId: target })),
    )
    expect(moved.status).toBe(200)

    const body = (await moved.json()) as { lead: { events: { type: string; actor: string }[] } }
    const event = body.lead.events.findLast((entry) => entry.type === 'stage_changed')
    expect(event?.actor).toBe(`api_key:${id}`)
  })

  it('does not let a cookie riding along upgrade a key to a user', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, cookie)
    const leadId = await submitLead(testApp)

    const noted = await testApp.app.request(
      `/api/v1/leads/${leadId}/notes`,
      withCookie(cookie, bearer(secret, jsonPost({ note: 'Called, left a message.' }))),
    )
    expect(noted.status).toBe(200)

    const body = (await noted.json()) as { lead: { events: { type: string; actor: string }[] } }
    const event = body.lead.events.findLast((entry) => entry.type === 'note_added')
    expect(event?.actor).toBe(`api_key:${id}`)
  })

  it('accepts a state change from a caller with no browser behind it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, cookie)
    const leadId = await submitLead(testApp)

    // No `Origin`, which is what curl, cron and an agent actually send. The
    // CSRF layers on this surface have to let that through or the key is
    // read-only in practice.
    const res = await testApp.app.request(
      `/api/v1/leads/${leadId}/notes`,
      bearer(secret, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'Screened, looks qualified.' }),
      }),
    )
    expect(res.status).toBe(200)
  })

  it('falls back to the cookie when the bearer token is not a live key', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const withSession = await testApp.app.request(
      '/api/v1/leads',
      withCookie(cookie, bearer(generateApiKey())),
    )
    expect(withSession.status).toBe(200)

    const without = await testApp.app.request('/api/v1/leads', bearer(generateApiKey()))
    expect(without.status).toBe(401)
  })

  it('records last use, so a stale key is visible as one', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, cookie)

    await testApp.app.request('/api/v1/leads', bearer(secret))

    const list = await testApp.app.request(KEYS_BASE, withCookie(cookie))
    const body = (await list.json()) as { keys: { lastUsedAt: string | null }[] }
    expect(body.keys[0]?.lastUsedAt).not.toBeNull()
  })

  it('keeps a key out of everything that needs a person behind it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, cookie)

    const sessionOnly: [string, RequestInit][] = [
      ['/api/v1/auth/session', {}],
      [KEYS_BASE, {}],
      [KEYS_BASE, jsonPost({ name: 'Another key' })],
      ['/api/v1/push/key', {}],
      ['/api/v1/push/subscriptions', jsonPost({ endpoint: 'https://push.example.com/x' })],
      ['/api/v1/settings/email/templates/new_lead_ack/test', jsonPost({})],
    ]

    for (const [path, init] of sessionOnly) {
      const res = await testApp.app.request(path, bearer(secret, init))
      expect([path, res.status]).toEqual([path, 403])
      expect(await res.json()).toEqual({ error: 'session_required' })
    }
  })

  it('leaves the rest of the REST surface open to a key', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, cookie)

    for (const path of ['/api/v1/leads', '/api/v1/stages', '/api/v1/settings/email']) {
      const res = await testApp.app.request(path, bearer(secret))
      expect([path, res.status]).toEqual([path, 200])
    }
  })

  it('does not authenticate the public intake endpoint into something more', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, cookie)

    // The revoked-key story only holds if a key is never a way past the guards
    // on a surface that has its own — intake stays what it was.
    const res = await testApp.app.request(
      `/api/intake/${defaultFormKey(testApp)}`,
      bearer(secret, jsonPost({ name: 'Sam Rivera', email: 'sam@example.com' })),
    )
    expect(res.status).toBe(201)

    const rows = testApp.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(secret))).all()
    expect(rows).toHaveLength(1)
  })
})
