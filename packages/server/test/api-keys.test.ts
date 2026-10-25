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
import { apiKeys, leads, users } from '../src/db/schema.ts'
import { readEmailSettings } from '../src/email/settings.ts'
import {
  cleanupTestApps,
  configureEmail,
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

function asOperator(authorization: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization } }
}

/** Creates a key through the API, as the settings screen does, and hands back its secret. */
async function mintKey(
  testApp: TestApp,
  authorization: string,
  name = 'Claude Code',
): Promise<{ id: number; secret: string }> {
  const res = await testApp.app.request(KEYS_BASE, asOperator(authorization, jsonPost({ name })))
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

/** The account a key belongs to — every key has one now (ADR-0007). */
function owner(testApp: TestApp, email = 'owner@example.com'): number {
  const [row] = testApp.db
    .insert(users)
    .values({ email, passwordHash: 'unused', name: null })
    .returning({ id: users.id })
    .all()
  if (row === undefined) throw new Error('no user inserted')
  return row.id
}

describe('api key storage', () => {
  it('stores a hash and a prefix, never the secret', () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, owner(testApp), 'Cron job')

    const [row] = testApp.db.select().from(apiKeys).all()
    expect(row?.keyHash).toBe(hashApiKey(key))
    expect(JSON.stringify(row)).not.toContain(key.slice(API_KEY_PREFIX.length))
  })

  it('resolves a live key and refuses anything else', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    const { key, record } = createApiKey(testApp.db, userId, 'Cron job')

    expect(resolveApiKey(testApp.db, key)).toEqual({ id: record.id, name: 'Cron job', userId })
    expect(resolveApiKey(testApp.db, generateApiKey())).toBeUndefined()
    // No prefix: rejected before it can even be looked up.
    expect(resolveApiKey(testApp.db, 'not-a-philo-key')).toBeUndefined()
    expect(resolveApiKey(testApp.db, '')).toBeUndefined()
  })

  it('stamps last use, then leaves it alone until the resolution has passed', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    const { key, record } = createApiKey(testApp.db, userId, 'Cron job')
    const start = new Date('2026-08-01T10:00:00.000Z')

    expect(listApiKeys(testApp.db, userId)[0]?.lastUsedAt).toBeNull()

    resolveApiKey(testApp.db, key, start)
    expect(listApiKeys(testApp.db, userId)[0]?.lastUsedAt).toEqual(start)

    const soon = new Date(start.getTime() + API_KEY_LAST_USED_RESOLUTION_MS - 1)
    resolveApiKey(testApp.db, key, soon)
    expect(listApiKeys(testApp.db, userId)[0]?.lastUsedAt).toEqual(start)

    const later = new Date(start.getTime() + API_KEY_LAST_USED_RESOLUTION_MS)
    resolveApiKey(testApp.db, key, later)
    expect(listApiKeys(testApp.db, userId)[0]?.lastUsedAt).toEqual(later)

    expect(record.lastUsedAt).toBeNull()
  })

  it('revokes once, and says so when there is nothing left to revoke', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    const { key, record } = createApiKey(testApp.db, userId, 'Cron job')

    expect(revokeApiKey(testApp.db, userId, record.id)).toBe(true)
    expect(revokeApiKey(testApp.db, userId, record.id)).toBe(false)
    expect(resolveApiKey(testApp.db, key)).toBeUndefined()
  })

  it('lists newest first', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    createApiKey(testApp.db, userId, 'First')
    createApiKey(testApp.db, userId, 'Second')

    expect(listApiKeys(testApp.db, userId).map((row) => row.name)).toEqual(['Second', 'First'])
  })

  it('keeps each user to their own keys', () => {
    const testApp = createTestApp()
    const mine = owner(testApp)
    const theirs = owner(testApp, 'someone@example.com')
    const { record } = createApiKey(testApp.db, theirs, 'Theirs')

    expect(listApiKeys(testApp.db, mine)).toEqual([])
    expect(revokeApiKey(testApp.db, mine, record.id)).toBe(false)
    expect(listApiKeys(testApp.db, theirs)).toHaveLength(1)
  })

  it('resolves a key nobody owns to nobody', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    const { key, record } = createApiKey(testApp.db, userId, 'Orphan')
    testApp.db.update(apiKeys).set({ userId: null }).where(eq(apiKeys.id, record.id)).run()

    expect(resolveApiKey(testApp.db, key)).toBeUndefined()
  })

  it('goes with its user', () => {
    const testApp = createTestApp()
    const userId = owner(testApp)
    const { key } = createApiKey(testApp.db, userId, 'Cron job')
    testApp.db.delete(users).where(eq(users.id, userId)).run()

    expect(resolveApiKey(testApp.db, key)).toBeUndefined()
    expect(testApp.db.select().from(apiKeys).all()).toHaveLength(0)
  })
})

describe('api key management', () => {
  it('hands the secret back exactly once', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)

    const res = await testApp.app.request(KEYS_BASE, asOperator(authorization, jsonPost({ name: 'Cron job' })))
    expect(res.status).toBe(201)
    const created = (await res.json()) as { key: Record<string, unknown>; secret: string }
    expect(created.secret.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(created.key['keyPrefix']).toBe(apiKeyDisplayPrefix(created.secret))
    expect(created.key['lastUsedAt']).toBeNull()

    const list = await testApp.app.request(KEYS_BASE, asOperator(authorization))
    const body = (await list.json()) as { keys: Record<string, unknown>[] }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]?.['name']).toBe('Cron job')
    // The one property of the whole scheme: it is not readable again.
    expect(JSON.stringify(body)).not.toContain(created.secret)
  })

  it('trims the name and refuses one that says nothing', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)

    const named = await testApp.app.request(KEYS_BASE, asOperator(authorization, jsonPost({ name: '  Cron  ' })))
    expect(((await named.json()) as { key: { name: string } }).key.name).toBe('Cron')

    for (const name of ['', '   ', 'x'.repeat(MAX_API_KEY_NAME_LENGTH + 1), 42]) {
      const res = await testApp.app.request(KEYS_BASE, asOperator(authorization, jsonPost({ name })))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_name' })
    }
  })

  it('refuses an id that is not one', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)

    for (const id of ['abc', '0', '-1', '1.5']) {
      const res = await testApp.app.request(
        `${KEYS_BASE}/${id}`,
        asOperator(authorization, { ...jsonPost({}), method: 'DELETE' }),
      )
      expect(res.status).toBe(400)
    }
  })

  it('answers 404 for a key that is already gone', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { id } = await mintKey(testApp, authorization)

    const revoke = () =>
      testApp.app.request(`${KEYS_BASE}/${id}`, asOperator(authorization, { ...jsonPost({}), method: 'DELETE' }))

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
    const authorization = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, authorization)

    const authenticated = await testApp.app.request('/api/v1/leads', bearer(secret))
    expect(authenticated.status).toBe(200)

    const revoked = await testApp.app.request(
      `${KEYS_BASE}/${id}`,
      asOperator(authorization, { ...jsonPost({}), method: 'DELETE' }),
    )
    expect(revoked.status).toBe(200)

    const after = await testApp.app.request('/api/v1/leads', bearer(secret))
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ error: 'unauthorized' })
  })

  it('records the key on the timeline, not a user', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, authorization)
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

  it('accepts a state change from a caller with no browser behind it', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)
    const leadId = await submitLead(testApp)

    // No `Origin`, which is what curl, cron and an agent actually send.
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

  it('records last use, so a stale key is visible as one', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)

    await testApp.app.request('/api/v1/leads', bearer(secret))

    const list = await testApp.app.request(KEYS_BASE, asOperator(authorization))
    const body = (await list.json()) as { keys: { lastUsedAt: string | null }[] }
    expect(body.keys[0]?.lastUsedAt).not.toBeNull()
  })

  it('reaches everything its user can — ADR-0007', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)
    configureEmail(testApp)

    const everything: [string, RequestInit, number][] = [
      ['/api/v1/auth/session', {}, 200],
      [KEYS_BASE, {}, 200],
      [KEYS_BASE, jsonPost({ name: 'Another key' }), 201],
      ['/api/v1/push/key', {}, 200],
      ['/api/v1/settings/email', {}, 200],
    ]
    for (const [path, init, status] of everything) {
      const res = await testApp.app.request(path, bearer(secret, init))
      expect([path, res.status]).toEqual([path, status])
    }
  })

  it('changes the mail server as its user can, and still cannot read the password back', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)
    configureEmail(testApp)

    const res = await testApp.app.request(
      '/api/v1/settings/email',
      bearer(secret, { ...jsonPost({ smtpHost: 'smtp2.example.com' }), method: 'PATCH' }),
    )
    expect(res.status).toBe(200)
    expect(readEmailSettings(testApp.db).smtpHost).toBe('smtp2.example.com')
    expect(JSON.stringify(await res.json())).not.toContain('secret-token')
  })

  it('mints a key for the same user, and names itself on the timeline, not the person', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { id, secret } = await mintKey(testApp, authorization)

    const minted = await testApp.app.request(KEYS_BASE, bearer(secret, jsonPost({ name: 'Made by an agent' })))
    const { secret: second } = (await minted.json()) as { secret: string }
    const principal = await testApp.app.request('/api/v1/auth/principal', bearer(second))
    expect(await principal.json()).toMatchObject({ user: { id: 1 } })

    const leadId = await submitLead(testApp)
    const noted = await testApp.app.request(`/api/v1/leads/${leadId}/notes`, bearer(secret, jsonPost({ note: 'Screened.' })))
    const body = (await noted.json()) as { lead: { events: { type: string; actor: string }[] } }
    expect(body.lead.events.findLast((event) => event.type === 'note_added')?.actor).toBe(`api_key:${id}`)
  })

  it('leaves leads, the funnel and the email templates open to a key', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)

    // Templates are the deliberate exception on the settings surface: DESIGN.md
    // (MCP surface) puts designing the emails in an agent's hands. Note what
    // that implies and is meant to — a key can author what goes out under the
    // business's name. The settings screen says so where a key is created.
    for (const path of ['/api/v1/leads', '/api/v1/stages', '/api/v1/settings/email/templates']) {
      const res = await testApp.app.request(path, bearer(secret))
      expect([path, res.status]).toEqual([path, 200])
    }

    const edited = await testApp.app.request(
      '/api/v1/settings/email/templates/new_lead_ack',
      bearer(secret, { ...jsonPost({ subject: 'Thanks, {{lead.name}}' }), method: 'PATCH' }),
    )
    expect(edited.status).toBe(200)
  })

  it('does not authenticate the public intake endpoint into something more', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const { secret } = await mintKey(testApp, authorization)

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
