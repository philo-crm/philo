import { describe, expect, it, vi } from 'vitest'
import {
  OidcError,
  TokenSession,
  createAuthorizationRequest,
  discover,
  exchangeCode,
  pkceChallenge,
  type OidcMetadata,
  type RefreshTokenStore,
} from '../src/index.ts'

const metadata: OidcMetadata = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  revocation_endpoint: 'https://idp.example.com/revoke',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('=', '')
}

function unsignedIdToken(claims: Record<string, unknown>): string {
  return `${encode({ alg: 'none' })}.${encode(claims)}.`
}

function memoryStore(initial?: string): RefreshTokenStore & { value: string | undefined } {
  const store = {
    value: initial,
    load: () => store.value,
    save: (token: string | undefined) => {
      store.value = token
    },
  }
  return store
}

describe('pkceChallenge', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})

describe('discover', () => {
  it('reads the openid-configuration under the issuer', async () => {
    const fetch = vi.fn(async () => json(metadata))
    expect(await discover('https://idp.example.com/', fetch)).toEqual(metadata)
    expect(fetch).toHaveBeenCalledWith('https://idp.example.com/.well-known/openid-configuration', expect.anything())
  })

  it('refuses a document without endpoints', async () => {
    await expect(discover('https://idp.example.com', async () => json({ issuer: 'x' }))).rejects.toThrow(OidcError)
  })
})

describe('authorization code flow', () => {
  it('builds a PKCE request and exchanges the code it gets back', async () => {
    const pending = await createAuthorizationRequest({
      metadata,
      clientId: 'philo-web',
      redirectUri: 'https://app.example.com/auth/callback',
      scope: 'openid operator',
    })
    const url = new URL(pending.url)
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint)
    expect(url.searchParams.get('code_challenge')).toBe(await pkceChallenge(pending.codeVerifier))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(url.searchParams.get('nonce')).toBe(pending.nonce)

    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: unsignedIdToken({ nonce: pending.nonce }),
        expires_in: 60,
        scope: 'openid operator',
      }),
    )
    const tokens = await exchangeCode({
      metadata,
      clientId: 'philo-web',
      pending,
      callbackUrl: `https://app.example.com/auth/callback?code=c0de&state=${pending.state}`,
      fetch,
      now: () => 1_000,
    })
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: 61_000 })
    const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'philo-web',
      code: 'c0de',
      code_verifier: pending.codeVerifier,
      redirect_uri: 'https://app.example.com/auth/callback',
    })
  })

  it('refuses a callback whose state is not ours, before any exchange', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const fetch = vi.fn()
    const failure = exchangeCode({ metadata, clientId: 'c', pending, callbackUrl: 'https://a/cb?code=x&state=forged', fetch })
    await expect(failure).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('surfaces the error the IdP redirected with', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const failure = exchangeCode({
      metadata,
      clientId: 'c',
      pending,
      callbackUrl: `https://a/cb?error=access_denied&state=${pending.state}`,
    })
    await expect(failure).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('refuses an id_token minted for a different sign-in', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const failure = exchangeCode({
      metadata,
      clientId: 'c',
      pending,
      callbackUrl: `https://a/cb?code=x&state=${pending.state}`,
      fetch: async () => json({ access_token: 'at', id_token: unsignedIdToken({ nonce: 'other' }) }),
    })
    await expect(failure).rejects.toMatchObject({ code: 'nonce_mismatch' })
  })
})

describe('TokenSession', () => {
  it('serves a live access token without touching the network', async () => {
    const fetch = vi.fn()
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore(), fetch, now: () => 0 })
    session.set({ accessToken: 'at', refreshToken: 'rt', idToken: undefined, scope: undefined, expiresAt: 60_000 })
    expect(await session.accessToken()).toBe('at')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shares one refresh between concurrent callers and stores the rotated token', async () => {
    const store = memoryStore('rt1')
    const fetch = vi.fn(async () => json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }))
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch })
    const [a, b] = await Promise.all([session.accessToken(), session.accessToken()])
    expect([a, b]).toEqual(['at2', 'at2'])
    expect(fetch).toHaveBeenCalledOnce()
    expect(store.value).toBe('rt2')
  })

  it('drops a refresh token the IdP refuses', async () => {
    const store = memoryStore('dead')
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch: async () => json({ error: 'invalid_grant' }, 400) })
    expect(await session.accessToken()).toBeUndefined()
    expect(store.value).toBeUndefined()
    expect(session.hasCredentials).toBe(false)
  })

  it('keeps the refresh token through a network failure', async () => {
    const store = memoryStore('rt')
    const session = new TokenSession({
      metadata,
      clientId: 'c',
      store,
      fetch: async () => {
        throw new TypeError('offline')
      },
    })
    await expect(session.accessToken()).rejects.toThrow('offline')
    expect(store.value).toBe('rt')
  })

  it('revokes the refresh token on sign-out', async () => {
    const store = memoryStore('rt')
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch })
    await session.signOut()
    expect(store.value).toBeUndefined()
    expect(fetch.mock.calls[0]?.[0]).toBe(metadata.revocation_endpoint)
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe('client_id=c&token=rt')
  })
})
