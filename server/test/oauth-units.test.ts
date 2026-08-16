import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { accessTokens, oauthClients } from '../src/db/schema.ts'
import {
  UNUSED_CLIENT_TTL_MS,
  deleteUnusedClients,
  isAllowedRedirectUri,
  registerClient,
} from '../src/oauth/clients.ts'
import {
  createAuthorizationCode,
  redeemAuthorizationCode,
  resolveAccessToken,
  verifyPkce,
} from '../src/oauth/tokens.ts'
import { cleanupTestApps, createTestApp, setupAdmin, type TestApp } from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

describe('isAllowedRedirectUri', () => {
  it.each([
    'https://claude.example.com/callback',
    'https://example.com/cb?next=1',
    'http://localhost:8080/callback',
    'http://127.0.0.1:1/callback',
    'http://[::1]:3000/cb',
  ])('allows %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true)
  })

  it.each([
    // Plain http off loopback would put a code on the wire in the clear.
    'http://example.com/callback',
    'javascript:alert(1)',
    'data:text/html,<script></script>',
    'file:///etc/passwd',
    // A scheme any installed app can claim is not a place to send a credential.
    'cursor://anysphere.cursor-mcp/oauth/callback',
    // A fragment is forbidden on a redirect URI and would be dropped anyway.
    'https://example.com/cb#fragment',
    'not a url',
  ])('refuses %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false)
  })
})

describe('verifyPkce', () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  it('accepts the verifier the challenge was derived from', () => {
    expect(verifyPkce(challenge, verifier)).toBe(true)
  })

  it('refuses a different verifier', () => {
    expect(verifyPkce(challenge, randomBytes(32).toString('base64url'))).toBe(false)
  })

  it('refuses a verifier used as its own challenge', () => {
    // What `plain` would have allowed. OAuth 2.1 removed it, and so has this.
    expect(verifyPkce(verifier, verifier)).toBe(false)
  })

  it.each([
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(129)],
  ])('refuses a verifier that is %s', (_label, candidate) => {
    const derived = createHash('sha256').update(candidate).digest('base64url')
    expect(verifyPkce(derived, candidate)).toBe(false)
  })
})

function client(testApp: TestApp, redirectUri = 'https://example.com/cb'): string {
  const result = registerClient(testApp.db, { redirect_uris: [redirectUri] })
  if (!result.ok) throw new Error(`registration failed: ${result.error}`)
  return result.value.client_id
}

describe('authorization codes', () => {
  it('is good for exactly one redemption', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const clientId = client(testApp)
    const code = createAuthorizationCode(testApp.db, {
      clientId,
      userId: 1,
      redirectUri: 'https://example.com/cb',
      codeChallenge: 'challenge',
      resource: null,
    })

    expect(redeemAuthorizationCode(testApp.db, code)?.clientId).toBe(clientId)
    expect(redeemAuthorizationCode(testApp.db, code)).toBeUndefined()
  })

  it('refuses one that has expired, and spends it anyway', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const issued = new Date(Date.now() - 60 * 60 * 1000)
    const code = createAuthorizationCode(
      testApp.db,
      {
        clientId: client(testApp),
        userId: 1,
        redirectUri: 'https://example.com/cb',
        codeChallenge: 'challenge',
        resource: null,
      },
      issued,
    )

    expect(redeemAuthorizationCode(testApp.db, code)).toBeUndefined()
  })
})

describe('access tokens', () => {
  it('ignores a credential that is not one of its own', async () => {
    const testApp = createTestApp()
    // An API key reaches this lookup too, and must not cost a query.
    expect(resolveAccessToken(testApp.db, 'philo_someapikey')).toBeUndefined()
  })

  it('drops a row that has expired rather than leaving it to accumulate', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const clientId = client(testApp)
    const token = 'philo_at_expired'
    testApp.db
      .insert(accessTokens)
      .values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        clientId,
        userId: 1,
        resource: null,
        scope: 'mcp',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      })
      .run()

    expect(resolveAccessToken(testApp.db, token)).toBeUndefined()
    expect(testApp.db.select().from(accessTokens).all()).toHaveLength(0)
  })
})

describe('deleteUnusedClients', () => {
  it('sweeps a stale registration that never finished a flow', () => {
    const testApp = createTestApp()
    const old = new Date(Date.now() - UNUSED_CLIENT_TTL_MS - 1000)
    registerClient(testApp.db, { redirect_uris: ['https://example.com/cb'] }, old)

    deleteUnusedClients(testApp.db)

    expect(testApp.db.select().from(oauthClients).all()).toHaveLength(0)
  })

  it('leaves a fresh registration alone', () => {
    const testApp = createTestApp()
    registerClient(testApp.db, { redirect_uris: ['https://example.com/cb'] })

    deleteUnusedClients(testApp.db)

    expect(testApp.db.select().from(oauthClients).all()).toHaveLength(1)
  })

  it('leaves an old registration that holds a token', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const old = new Date(Date.now() - UNUSED_CLIENT_TTL_MS - 1000)
    const result = registerClient(testApp.db, { redirect_uris: ['https://example.com/cb'] }, old)
    if (!result.ok) throw new Error('registration failed')
    testApp.db
      .insert(accessTokens)
      .values({
        tokenHash: 'hash',
        clientId: result.value.client_id,
        userId: 1,
        resource: null,
        scope: 'mcp',
        createdAt: old,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .run()

    deleteUnusedClients(testApp.db)

    // A working connector must never be swept out from under the operator.
    expect(testApp.db.select().from(oauthClients).all()).toHaveLength(1)
  })
})
