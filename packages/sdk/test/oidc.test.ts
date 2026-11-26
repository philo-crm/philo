import { describe, expect, it, vi } from 'vitest'
import {
  OidcError,
  TokenSession,
  createAuthorizationRequest,
  discover,
  endSessionUrl,
  exchangeCode,
  pkceChallenge,
  type OidcMetadata,
  type RefreshLock,
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

describe('TokenSession id token', () => {
  it('exposes the newest id token, keeping it through a refresh that sends none', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }))
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore(), fetch, now: () => 0 })
    expect(session.idToken).toBeUndefined()
    session.set({ accessToken: 'at1', refreshToken: 'rt1', idToken: 'id1', scope: undefined, expiresAt: 0 })
    expect(session.idToken).toBe('id1')
    await session.accessToken()
    expect(session.idToken).toBe('id1')
  })

  it('takes the id token a refresh renews', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'at2', refresh_token: 'rt2', id_token: 'id2', expires_in: 3600 }))
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore(), fetch, now: () => 0 })
    session.set({ accessToken: 'at1', refreshToken: 'rt1', idToken: 'id1', scope: undefined, expiresAt: 0 })
    await session.accessToken()
    expect(session.idToken).toBe('id2')
  })

  it('drops the id token when it refreshes with a token another tab stored', async () => {
    // Another tab signed out and back in, perhaps as someone else: the stored
    // grant is not the one this id token came with, so it must not hint.
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ access_token: 'at2', refresh_token: 'rt3', expires_in: 3600 }),
    )
    const store = memoryStore()
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch, now: () => 0 })
    session.set({ accessToken: 'at1', refreshToken: 'rt1', idToken: 'id1', scope: undefined, expiresAt: 0 })
    store.value = 'rt2'
    await session.accessToken()
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain('refresh_token=rt2')
    expect(session.idToken).toBeUndefined()
  })

  it('takes the id token a refresh of an adopted grant returns', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'at2', refresh_token: 'rt3', id_token: 'id2', expires_in: 3600 }))
    const store = memoryStore()
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch, now: () => 0 })
    session.set({ accessToken: 'at1', refreshToken: 'rt1', idToken: 'id1', scope: undefined, expiresAt: 0 })
    store.value = 'rt2'
    await session.accessToken()
    expect(session.idToken).toBe('id2')
  })

  it('keeps the id token when saving the rotated token failed and memory is spent', async () => {
    const stuck: RefreshTokenStore & { value: string | undefined } = { value: 'rt1', load: () => 'rt1', save: () => {} }
    const idp = rotatingIdp('rt1')
    let now = 0
    const session = new TokenSession({ metadata, clientId: 'c', store: stuck, fetch: idp.fetch, lock: memoryLock(), now: () => now })
    session.set({ accessToken: 'at1', refreshToken: 'rt1', idToken: 'id1', scope: undefined, expiresAt: 0 })
    await session.accessToken()
    now = 4_000_000_000
    await session.accessToken()
    expect(idp.presented).toEqual(['rt1', 'rt2'])
    expect(session.idToken).toBe('id1')
    // Still failing: the store keeps rt1, spent two refreshes ago, and memory's grant is still this session's own.
    now = 8_000_000_000
    await session.accessToken()
    expect(idp.presented).toEqual(['rt1', 'rt2', 'rt3'])
    expect(session.idToken).toBe('id1')
  })

  it('forgets the id token on sign-out', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore(), fetch })
    session.set({ accessToken: 'at', refreshToken: 'rt', idToken: 'id', scope: undefined, expiresAt: 0 })
    await session.signOut()
    expect(session.idToken).toBeUndefined()
  })
})

describe('endSessionUrl', () => {
  const withEndSession: OidcMetadata = { ...metadata, end_session_endpoint: 'https://idp.example.com/logout?tenant=a' }
  const base = {
    metadata: withEndSession,
    clientId: 'c',
    postLogoutRedirectUri: 'https://app.example.com/',
    state: 'st',
  }

  it('sends the id token as a hint, with the return address and state', () => {
    const url = new URL(endSessionUrl({ ...base, idToken: 'id.token.x' }) ?? '')
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example.com/logout')
    // The endpoint's own query survives.
    expect(url.searchParams.get('tenant')).toBe('a')
    expect(url.searchParams.get('id_token_hint')).toBe('id.token.x')
    // RP-Initiated Logout §2 lets both travel; the provider checks they agree.
    expect(url.searchParams.get('client_id')).toBe('c')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('names the client instead when there is no id token to hint with', () => {
    const url = new URL(endSessionUrl({ ...base, idToken: undefined }) ?? '')
    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect(url.searchParams.get('client_id')).toBe('c')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('answers undefined when the provider names no end-session endpoint', () => {
    expect(endSessionUrl({ ...base, metadata, idToken: 'id' })).toBeUndefined()
  })
})

/** A one-at-a-time lock, standing in for the Web Locks API that tabs share. */
function memoryLock(): RefreshLock & { names: string[] } {
  let tail: Promise<unknown> = Promise.resolve()
  const names: string[] = []
  const lock = (<T>(name: string, fn: () => Promise<T>): Promise<T> => {
    names.push(name)
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run
  }) as RefreshLock & { names: string[] }
  lock.names = names
  return lock
}

/** An IdP with OAuth 2.1 reuse detection: presenting a spent refresh token revokes the whole grant. */
function rotatingIdp(first: string) {
  let current: string | undefined = first
  let issued = 1
  const presented: string[] = []
  const revoked: string[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body))
    if (url === metadata.revocation_endpoint) {
      // Like the built-in IdP: revoking deletes only the token presented.
      const token = body.get('token') ?? ''
      revoked.push(token)
      if (token === current) current = undefined
      return new Response(null, { status: 200 })
    }
    const token = body.get('refresh_token') ?? ''
    presented.push(token)
    if (token !== current) {
      current = undefined
      return json({ error: 'invalid_grant' }, 400)
    }
    issued += 1
    current = `rt${issued}`
    return json({ access_token: `at${issued}`, refresh_token: current, expires_in: 3600 })
  })
  return { fetch, presented, revokedTokens: revoked, revoked: () => current === undefined }
}

/** A lock that refuses outright, as `navigator.locks` does in some sandboxed frames. */
const brokenLock: RefreshLock = async () => {
  throw new DOMException('denied', 'SecurityError')
}

describe('TokenSession across tabs', () => {
  it('spends each refresh token once when sessions share a store and a lock', async () => {
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const lock = memoryLock()
    const tabA = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock })
    const tabB = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock })
    const [a, b] = await Promise.all([tabA.accessToken(), tabB.accessToken()])
    // Each tab holds its access token in memory, so each needs one rotation of
    // its own — but the second one rotates the token the first one stored.
    expect(idp.presented).toEqual(['rt1', 'rt2'])
    expect(idp.revoked()).toBe(false)
    expect([a, b]).toEqual(['at2', 'at3'])
    expect(store.value).toBe('rt3')
    expect(lock.names).toEqual(['philo.oidc-refresh:c', 'philo.oidc-refresh:c'])
    // Both stay signed in: the next refresh in either tab spends the live token.
    tabA.set({ accessToken: 'stale', refreshToken: undefined, idToken: undefined, scope: undefined, expiresAt: 0 })
    expect(await tabA.accessToken()).toBe('at4')
    expect(idp.revoked()).toBe(false)
  })

  it('prefers the stored refresh token over a copy another tab has already spent', async () => {
    const store = memoryStore()
    const idp = rotatingIdp('rt1')
    const lock = memoryLock()
    const tab = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock })
    tab.set({ accessToken: 'old', refreshToken: 'rt1', idToken: undefined, scope: undefined, expiresAt: 0 })
    const other = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock })
    expect(await other.accessToken()).toBe('at2')
    expect(await tab.accessToken()).toBe('at3')
    expect(idp.presented).toEqual(['rt1', 'rt2'])
    expect(idp.revoked()).toBe(false)
  })

  it('skips the refresh when a fresh access token arrived while waiting for the lock', async () => {
    const queue: Array<() => void> = []
    const lock: RefreshLock = (_name, fn) => new Promise<void>((resolve) => queue.push(resolve)).then(fn)
    const fetch = vi.fn()
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore('rt1'), fetch, lock, now: () => 0 })
    const pending = session.accessToken()
    session.set({ accessToken: 'fresh', refreshToken: 'rt9', idToken: undefined, scope: undefined, expiresAt: 60_000 })
    queue.shift()?.()
    expect(await pending).toBe('fresh')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes without a lock when the lock itself fails', async () => {
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock: brokenLock })
    expect(await session.accessToken()).toBe('at2')
    expect(store.value).toBe('rt2')
  })

  it('does not run the refresh twice when it fails inside the lock', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('offline')
    })
    const session = new TokenSession({ metadata, clientId: 'c', store: memoryStore('rt1'), fetch, lock: memoryLock() })
    await expect(session.accessToken()).rejects.toThrow('offline')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps a sign-out in one tab when another tab holds a live refresh token', async () => {
    let now = 0
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const lock = memoryLock()
    const options = { metadata, clientId: 'c', store, fetch: idp.fetch, lock, now: () => now }
    const tabA = new TokenSession(options)
    const tabB = new TokenSession(options)
    await tabA.accessToken()
    await tabB.accessToken()
    // A holds rt2 in memory, already spent; B and the store hold the live rt3.
    await tabA.signOut()
    expect(idp.revokedTokens).toEqual(['rt3'])
    expect(store.value).toBeUndefined()
    now = 4_000_000_000
    expect(await tabB.accessToken()).toBeUndefined()
    expect(tabB.hasCredentials).toBe(false)
    expect(idp.presented).toEqual(['rt1', 'rt2'])
    expect(store.value).toBeUndefined()
  })

  it('does not bring a signed-out session back from memory even when the IdP cannot revoke', async () => {
    let now = 0
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const { revocation_endpoint: _, ...noRevoke } = metadata
    const options = { metadata: noRevoke, clientId: 'c', store, fetch: idp.fetch, lock: memoryLock(), now: () => now }
    const tabA = new TokenSession(options)
    const tabB = new TokenSession(options)
    await tabA.accessToken()
    await tabB.accessToken()
    await tabA.signOut()
    now = 4_000_000_000
    expect(await tabB.accessToken()).toBeUndefined()
    expect(idp.presented).toEqual(['rt1', 'rt2'])
    expect(store.value).toBeUndefined()
  })

  it('signs out after a refresh in flight in another tab, revoking the token it stores', async () => {
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const opened: Array<() => void> = []
    const gate = new Promise<void>((resolve) => opened.push(resolve))
    const slowFetch = async (url: string, init?: RequestInit) => {
      if (url === metadata.token_endpoint) await gate
      return idp.fetch(url, init)
    }
    const lock = memoryLock()
    const tabA = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock })
    const tabB = new TokenSession({ metadata, clientId: 'c', store, fetch: slowFetch, lock })
    const refreshing = tabB.accessToken()
    const signingOut = tabA.signOut()
    for (const open of opened) open()
    expect(await refreshing).toBe('at2')
    await signingOut
    expect(idp.revokedTokens).toEqual(['rt2'])
    expect(idp.revoked()).toBe(true)
    expect(store.value).toBeUndefined()
  })

  it('signs out without the lock when the lock itself fails', async () => {
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const session = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch, lock: brokenLock })
    await session.signOut()
    expect(idp.revokedTokens).toEqual(['rt1'])
    expect(store.value).toBeUndefined()
  })

  it('refreshes from memory when storage never keeps the token', async () => {
    const blocked: RefreshTokenStore = { load: () => undefined, save: () => {} }
    const idp = rotatingIdp('rt1')
    let now = 0
    const session = new TokenSession({ metadata, clientId: 'c', store: blocked, fetch: idp.fetch, lock: memoryLock(), now: () => now })
    session.set({ accessToken: 'old', refreshToken: 'rt1', idToken: undefined, scope: undefined, expiresAt: 0 })
    expect(await session.accessToken()).toBe('at2')
    now = 4_000_000_000
    expect(await session.accessToken()).toBe('at3')
    expect(idp.presented).toEqual(['rt1', 'rt2'])
  })

  it('spends the token in memory when saving the new one failed', async () => {
    // A full localStorage: setItem throws and the old value stays readable.
    const stuck: RefreshTokenStore = { load: () => 'rt1', save: () => {} }
    let now = 0
    const idp = rotatingIdp('rt1')
    const session = new TokenSession({ metadata, clientId: 'c', store: stuck, fetch: idp.fetch, lock: memoryLock(), now: () => now })
    expect(await session.accessToken()).toBe('at2')
    now = 4_000_000_000
    expect(await session.accessToken()).toBe('at3')
    // Still failing: the store keeps rt1, which this session spent two refreshes ago.
    now = 8_000_000_000
    expect(await session.accessToken()).toBe('at4')
    expect(idp.presented).toEqual(['rt1', 'rt2', 'rt3'])
    expect(idp.revoked()).toBe(false)
  })

  it('retries with the stored token after a network failure, not a copy already spent', async () => {
    let now = 0
    let offline = false
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const flakyFetch = async (url: string, init?: RequestInit) => {
      if (offline) throw new TypeError('Failed to fetch')
      return idp.fetch(url, init)
    }
    const options = { metadata, clientId: 'c', store, fetch: flakyFetch, lock: memoryLock(), now: () => now }
    const tabA = new TokenSession(options)
    const tabB = new TokenSession(options)
    await tabB.accessToken()
    await tabA.accessToken()
    // B holds rt2 in memory, already spent; A and the store hold the live rt3.
    now = 4_000_000_000
    offline = true
    await expect(tabB.accessToken()).rejects.toThrow('Failed to fetch')
    offline = false
    expect(await tabB.accessToken()).toBe('at4')
    expect(idp.presented).toEqual(['rt1', 'rt2', 'rt3'])
    expect(idp.revoked()).toBe(false)
    expect(store.value).toBe('rt4')
  })

  it('without a lock, two sessions still race on one token, as before', async () => {
    const store = memoryStore('rt1')
    const idp = rotatingIdp('rt1')
    const tabA = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch })
    const tabB = new TokenSession({ metadata, clientId: 'c', store, fetch: idp.fetch })
    await Promise.all([tabA.accessToken(), tabB.accessToken()])
    expect(idp.presented).toEqual(['rt1', 'rt1'])
  })
})
