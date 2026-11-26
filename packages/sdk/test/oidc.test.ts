import { describe, expect, it, vi } from 'vitest'
import {
  OidcError,
  TokenSession,
  createAuthorizationRequest,
  discover,
  exchangeCode,
  pkceChallenge,
  refreshTokens,
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

  it('holds the sign-in id_token, and keeps it through a refresh that brings none', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }))
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore(), fetch, now: () => 0 })
    expect(session.idToken).toBeUndefined()
    session.set({ accessToken: 'at', refreshToken: 'rt', idToken: 'the-id-token', scope: undefined, expiresAt: 1 })
    expect(session.idToken).toBe('the-id-token')
    expect(await session.accessToken()).toBe('at2')
    expect(session.idToken).toBe('the-id-token')
    session.clear()
    expect(session.idToken).toBeUndefined()
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

describe('resource indicators and prompt (RFC 8707)', () => {
  const resource = ['https://api.example.com', 'https://other.example.com/api']

  it('sends one resource parameter per value, and prompt when asked', async () => {
    const pending = await createAuthorizationRequest({
      metadata,
      clientId: 'c',
      redirectUri: 'https://a/cb',
      scope: 'openid offline_access',
      resource,
      prompt: 'none',
    })
    const url = new URL(pending.url)
    expect(url.searchParams.getAll('resource')).toEqual(resource)
    expect(url.searchParams.get('prompt')).toBe('none')
    expect(url.searchParams.get('scope')).toBe('openid offline_access')
    expect(pending.resource).toEqual(resource)
    expect(pending.issuer).toBe(metadata.issuer)
  })

  it('sends id_token_hint when given one, and not otherwise', async () => {
    const hinted = await createAuthorizationRequest({
      metadata,
      clientId: 'c',
      redirectUri: 'https://a/cb',
      scope: 'openid',
      idTokenHint: 'the-id-token',
    })
    expect(new URL(hinted.url).searchParams.get('id_token_hint')).toBe('the-id-token')
    const plain = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    expect(new URL(plain.url).searchParams.has('id_token_hint')).toBe(false)
  })

  it('sends neither when none is asked for', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const url = new URL(pending.url)
    expect(url.searchParams.has('resource')).toBe(false)
    expect(url.searchParams.has('prompt')).toBe(false)
    expect(pending.resource).toEqual([])
  })

  it('sends the same resource values with the code exchange', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid', resource })
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ access_token: 'at' }))
    await exchangeCode({ metadata, clientId: 'c', pending, callbackUrl: `https://a/cb?code=x&state=${pending.state}`, fetch })
    const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.getAll('resource')).toEqual(resource)
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('sends them on refresh too', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ access_token: 'at' }))
    await refreshTokens({ metadata, clientId: 'c', refreshToken: 'rt', resource, fetch })
    const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.getAll('resource')).toEqual(resource)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt')
  })

  it('carries them through a TokenSession refresh, and leaves the body alone without them', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ access_token: 'at' }))
    await new TokenSession({ metadata, clientId: 'c', store: memoryStore('rt'), resource, fetch }).accessToken()
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).getAll('resource')).toEqual(resource)

    await new TokenSession({ metadata, clientId: 'c', store: memoryStore('rt'), fetch }).accessToken()
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toBe('grant_type=refresh_token&client_id=c&refresh_token=rt')
  })
})

describe('authorization response issuer (RFC 9207)', () => {
  async function callback(iss: string | undefined, meta: OidcMetadata = metadata) {
    const pending = await createAuthorizationRequest({ metadata: meta, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const fetch = vi.fn(async () => json({ access_token: 'at' }))
    const query = new URLSearchParams({ code: 'x', state: pending.state })
    if (iss !== undefined) query.set('iss', iss)
    const result = exchangeCode({ metadata: meta, clientId: 'c', pending, callbackUrl: `https://a/cb?${query}`, fetch })
    return { result, fetch }
  }

  it('accepts an iss that names the issuer', async () => {
    const { result } = await callback(metadata.issuer)
    await expect(result).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('refuses an iss that names another issuer, before any exchange', async () => {
    const { result, fetch } = await callback('https://attacker.example.com')
    await expect(result).rejects.toMatchObject({ code: 'issuer_mismatch' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts a response without iss from a provider that does not promise one', async () => {
    const { result } = await callback(undefined)
    await expect(result).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('requires iss from a provider whose discovery promises it', async () => {
    const promising = { ...metadata, authorization_response_iss_parameter_supported: true }
    const missing = await callback(undefined, promising)
    await expect(missing.result).rejects.toMatchObject({ code: 'issuer_mismatch' })
    expect(missing.fetch).not.toHaveBeenCalled()
    await expect((await callback(metadata.issuer, promising)).result).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('checks an error response too, so a mixed-up provider cannot pose as ours', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const failure = exchangeCode({
      metadata,
      clientId: 'c',
      pending,
      callbackUrl: `https://a/cb?error=access_denied&state=${pending.state}&iss=${encodeURIComponent('https://attacker.example.com')}`,
    })
    await expect(failure).rejects.toMatchObject({ code: 'issuer_mismatch' })
  })

  it('refuses a pending request made for a different issuer than the metadata it is finished against', async () => {
    const pending = await createAuthorizationRequest({ metadata, clientId: 'c', redirectUri: 'https://a/cb', scope: 'openid' })
    const other = { ...metadata, issuer: 'https://other.example.com' }
    const failure = exchangeCode({
      metadata: other,
      clientId: 'c',
      pending,
      callbackUrl: `https://a/cb?code=x&state=${pending.state}`,
      fetch: async () => json({ access_token: 'at' }),
    })
    await expect(failure).rejects.toMatchObject({ code: 'issuer_mismatch' })
  })
})
