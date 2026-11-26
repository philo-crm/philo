import { TokenSession, type OidcMetadata } from '@philo/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth } from '../src/auth.ts'
import {
  configureExtraTokens,
  EXTRA_TOKEN_TIMEOUT_MS,
  getExtraToken,
  postFramedCallback,
  SILENT_CALLBACK_MESSAGE,
} from '../src/extra-token.ts'

const ISSUER = 'https://id.example.com'
const RESOURCE = 'https://feed.example.com'
const SCOPE = 'feed:read'

const metadata: OidcMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
}

interface TokenCall {
  body: URLSearchParams
}

/** An unsigned JWT: the client reads claims without verifying, as it may for tokens straight from the token endpoint. */
function jwt(claims: Record<string, unknown>): string {
  return `${jwtPart({ alg: 'none' })}.${jwtPart(claims)}.`
}

function jwtPart(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The person signed in to the PWA. */
const ALICE = 'alice-subject'

/** The n-th access token the default endpoint issues: a JWT for ALICE. */
function extra(n: number): string {
  return jwt({ sub: ALICE, jti: `extra-${n}` })
}

/** The nonce of the request the last answered frame carried, for an endpoint that mints an id_token. */
let lastNonce: string | undefined

/** A token endpoint that hands out numbered access tokens, and a refresh token that must never be kept. */
function installTokenEndpoint(answer?: (call: TokenCall) => Response | Promise<Response>) {
  const calls: TokenCall[] = []
  let issued = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(metadata.token_endpoint)
      const call = { body: new URLSearchParams(String(init?.body)) }
      calls.push(call)
      if (answer !== undefined) return answer(call)
      issued += 1
      return Response.json({
        access_token: extra(issued),
        refresh_token: `extra-refresh-${issued}`,
        token_type: 'Bearer',
        expires_in: 300,
      })
    }),
  )
  return calls
}

function makeAuth(
  overrides: { issuer?: string; signedIn?: boolean; accessToken?: string; idToken?: string } = {},
): Auth {
  const issuer = overrides.issuer ?? ISSUER
  const md = { ...metadata, issuer }
  const saved: (string | undefined)[] = []
  const session = new TokenSession({
    metadata: md,
    clientId: 'philo-pwa',
    store: { load: () => 'main-refresh', save: (token) => void saved.push(token) },
  })
  if (overrides.signedIn !== false) {
    session.set({
      accessToken: overrides.accessToken ?? jwt({ sub: ALICE }),
      refreshToken: undefined,
      idToken: overrides.idToken,
      scope: undefined,
      expiresAt: Date.now() + 3_600_000,
    })
  }
  const auth: Auth & { saved: typeof saved } = {
    config: { issuer, clientId: 'philo-pwa', scope: 'openid email', resource: [] },
    metadata: md,
    session,
    saved,
  }
  if (overrides.signedIn === false) {
    Object.defineProperty(session, 'hasCredentials', { get: () => false })
  }
  return auth
}

/** The hidden frames the module has put in the page. */
function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe')]
}

async function nextFrame(): Promise<HTMLIFrameElement> {
  await vi.waitFor(() => expect(frames().length).toBeGreaterThan(0))
  return frames().at(-1)!
}

/** What the IdP would redirect the frame to, posted the way the framed callback posts it. */
function callbackFor(frame: HTMLIFrameElement, params: Record<string, string>): string {
  const request = new URL(frame.src)
  lastNonce = request.searchParams.get('nonce') ?? undefined
  const url = new URL(request.searchParams.get('redirect_uri')!)
  url.searchParams.set('state', request.searchParams.get('state')!)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

function post(
  frame: HTMLIFrameElement,
  url: string,
  options: { origin?: string; source?: Window | null; type?: string } = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: options.type ?? SILENT_CALLBACK_MESSAGE, url },
      origin: options.origin ?? window.location.origin,
      source: options.source === undefined ? frame.contentWindow : options.source,
    }),
  )
}

async function answerNext(params: Record<string, string> = { code: 'the-code' }): Promise<HTMLIFrameElement> {
  const frame = await nextFrame()
  post(frame, callbackFor(frame, params))
  return frame
}

beforeEach(() => {
  configureExtraTokens(makeAuth())
})

afterEach(() => {
  configureExtraTokens(undefined)
  vi.useRealTimers()
  for (const frame of frames()) frame.remove()
})

describe('getExtraToken', () => {
  it('asks the IdP in a hidden frame with the PWA’s own client and callback, and exchanges the code', async () => {
    const calls = installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const frame = await answerNext()

    expect(await token).toBe(extra(1))
    const request = new URL(frame.src)
    expect(`${request.origin}${request.pathname}`).toBe(metadata.authorization_endpoint)
    expect(request.searchParams.get('client_id')).toBe('philo-pwa')
    expect(request.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/auth/callback`)
    // openid on top, so the IdP says whose token it is.
    expect(request.searchParams.get('scope')).toBe(`openid ${SCOPE}`)
    expect(request.searchParams.getAll('resource')).toEqual([RESOURCE])
    expect(request.searchParams.has('prompt')).toBe(false)
    expect(frame.hidden).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.get('grant_type')).toBe('authorization_code')
    expect(calls[0]!.body.get('code')).toBe('the-code')
    expect(calls[0]!.body.getAll('resource')).toEqual([RESOURCE])
    // The frame is gone once it has answered.
    expect(frames()).toHaveLength(0)
  })

  it('sends the prompt the caller asks for', async () => {
    installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE, prompt: 'none' })
    const frame = await answerNext()
    expect(await token).toBe(extra(1))
    expect(new URL(frame.src).searchParams.get('prompt')).toBe('none')
  })

  it('answers null for a response whose state it did not send', async () => {
    const calls = installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const frame = await nextFrame()
    const url = new URL(callbackFor(frame, { code: 'the-code' }))
    url.searchParams.set('state', 'someone-elses')
    post(frame, url.toString())

    expect(await token).toBeNull()
    expect(calls).toHaveLength(0)
    expect(frames()).toHaveLength(0)
  })

  it('answers null when the response names another issuer', async () => {
    const calls = installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext({ code: 'the-code', iss: 'https://elsewhere.example.com' })
    expect(await token).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('ignores a message from another origin, or from a window that is not its frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const frame = await nextFrame()
    const url = callbackFor(frame, { code: 'the-code' })
    post(frame, url, { origin: 'https://evil.example.com' })
    post(frame, url, { source: window })
    post(frame, url, { type: 'something-else' })
    await Promise.resolve()
    expect(calls).toHaveLength(0)
    expect(frames()).toHaveLength(1)

    // The real answer still lands.
    post(frame, url)
    expect(await token).toBe(extra(1))
  })

  it('gives up with null when the IdP never answers, and removes the frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await nextFrame()
    await vi.advanceTimersByTimeAsync(EXTRA_TOKEN_TIMEOUT_MS)
    expect(await token).toBeNull()
    expect(frames()).toHaveLength(0)
  })

  it('answers null for an OAuth error, and does not ask again until the next sign-in', async () => {
    installTokenEndpoint()
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext({ error: 'login_required' })
    expect(await first).toBeNull()

    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(frames()).toHaveLength(0)

    // Another audience is a separate question.
    const other = getExtraToken({ resource: 'https://other.example.com', scope: SCOPE })
    await answerNext()
    expect(await other).toBe(extra(1))

    // A new sign-in clears the refusal.
    configureExtraTokens(makeAuth())
    const again = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await again).toBe(extra(2))
  })

  it('reuses the token until 30 s before it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    installTokenEndpoint()
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBe(extra(1))

    // expires_in is 300 s: still good at 269 s.
    vi.setSystemTime(Date.now() + 269_000)
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBe(extra(1))
    expect(frames()).toHaveLength(0)

    vi.setSystemTime(Date.now() + 2_000)
    const renewed = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await renewed).toBe(extra(2))
  })

  it('caches per resource and scope', async () => {
    installTokenEndpoint()
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBe(extra(1))
    const wider = getExtraToken({ resource: RESOURCE, scope: `${SCOPE} feed:write` })
    await answerNext()
    expect(await wider).toBe(extra(2))
  })

  it('shares one request between concurrent callers', async () => {
    const calls = installTokenEndpoint()
    const a = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const b = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await nextFrame()
    expect(frames()).toHaveLength(1)
    await answerNext()
    expect(await a).toBe(extra(1))
    expect(await b).toBe(extra(1))
    expect(calls).toHaveLength(1)
  })

  it('never stores the refresh token the IdP returns', async () => {
    installTokenEndpoint()
    const auth = makeAuth() as Auth & { saved: (string | undefined)[] }
    configureExtraTokens(auth)
    window.localStorage.clear()
    window.sessionStorage.clear()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await token).toBe(extra(1))

    expect(auth.saved).toEqual([])
    const stored = [
      ...Object.values({ ...window.localStorage }),
      ...Object.values({ ...window.sessionStorage }),
    ].join('\n')
    expect(stored).not.toContain('extra-refresh')
    expect(stored).not.toContain(extra(1))
  })

  it('answers null when the token endpoint cannot be reached, without throwing', async () => {
    installTokenEndpoint(() => {
      throw new TypeError('Failed to fetch')
    })
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await token).toBeNull()
  })

  it('answers null with the built-in IdP, which has only Philo’s own resource', async () => {
    configureExtraTokens(makeAuth({ issuer: window.location.origin }))
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(frames()).toHaveLength(0)
  })

  it('answers null before sign-in, or when nobody is signed in', async () => {
    configureExtraTokens(undefined)
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    configureExtraTokens(makeAuth({ signedIn: false }))
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(frames()).toHaveLength(0)
  })

  it('drops the cache on sign-out, and a request in flight then lands nowhere', async () => {
    installTokenEndpoint()
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBe(extra(1))

    const inFlight = getExtraToken({ resource: RESOURCE, scope: SCOPE + ' x' })
    const frame = await nextFrame()
    configureExtraTokens(undefined)
    post(frame, callbackFor(frame, { code: 'the-code' }))
    expect(await inFlight).toBeNull()
    expect(frames()).toHaveLength(0)

    configureExtraTokens(makeAuth())
    const fresh = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await fresh).not.toBe(extra(1))
  })
})

describe('getExtraToken binds the token to the signed-in person', () => {
  /** An endpoint answering with an opaque access token and an id_token for `subject`. */
  function installIdTokenEndpoint(subject: string) {
    return installTokenEndpoint(() =>
      Response.json({ access_token: 'opaque-extra', id_token: jwt({ sub: subject, nonce: lastNonce }), expires_in: 300 }),
    )
  }

  it('hands the token over when the IdP answers for the same person, and hints who that is', async () => {
    const idToken = jwt({ sub: ALICE, nonce: 'sign-in-nonce' })
    configureExtraTokens(makeAuth({ accessToken: 'opaque-main', idToken }))
    installIdTokenEndpoint(ALICE)
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const frame = await answerNext()
    expect(await token).toBe('opaque-extra')
    const request = new URL(frame.src)
    expect(request.searchParams.get('id_token_hint')).toBe(idToken)
    // The hint does not imply prompt=none; that stays the caller's choice.
    expect(request.searchParams.has('prompt')).toBe(false)
  })

  it('does not add openid twice', async () => {
    installTokenEndpoint()
    const token = getExtraToken({ resource: RESOURCE, scope: `${SCOPE} openid` })
    const frame = await answerNext()
    expect(await token).toBe(extra(1))
    expect(new URL(frame.src).searchParams.get('scope')).toBe(`${SCOPE} openid`)
  })

  it('answers null when the IdP answers for someone else, and neither caches nor asks again', async () => {
    configureExtraTokens(makeAuth({ idToken: jwt({ sub: ALICE }) }))
    const calls = installIdTokenEndpoint('bob-subject')
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBeNull()

    // Had the token been cached before the check, this would hand it out.
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(frames()).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('compares the access tokens’ subjects when there is no id_token', async () => {
    const calls = installTokenEndpoint(() =>
      Response.json({ access_token: jwt({ sub: 'bob-subject' }), expires_in: 300 }),
    )
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBeNull()
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('answers null when the extra answer says nothing of whose it is', async () => {
    const calls = installTokenEndpoint(() => Response.json({ access_token: 'opaque-extra', expires_in: 300 }))
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBeNull()
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('does not ask at all when the session’s own person is unknown', async () => {
    configureExtraTokens(makeAuth({ accessToken: 'opaque-main' }))
    const calls = installTokenEndpoint()
    expect(await getExtraToken({ resource: RESOURCE, scope: SCOPE })).toBeNull()
    expect(frames()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('prefers the sign-in id_token’s subject over the session access token’s', async () => {
    // A JWT access token that names someone else does not outvote the id_token.
    configureExtraTokens(makeAuth({ accessToken: jwt({ sub: 'client-or-other' }), idToken: jwt({ sub: ALICE }) }))
    installIdTokenEndpoint(ALICE)
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await token).toBe('opaque-extra')
  })
})

describe('getExtraToken after a refresh adopts another tab’s grant', () => {
  const BOB = 'bob-subject'

  /**
   * A session signed in as ALICE, with her id_token, whose shared store
   * another tab then fills with its own sign-in; `expire` makes the next
   * access-token read refresh, which spends that other grant (BOB's).
   */
  function sharedTabAuth(): { auth: Auth; expire: () => void } {
    let stored: string | undefined
    let clock = Date.now()
    const session = new TokenSession({
      metadata,
      clientId: 'philo-pwa',
      store: { load: () => stored, save: (token) => void (stored = token) },
      now: () => clock,
    })
    session.set({
      accessToken: jwt({ sub: ALICE }),
      refreshToken: 'alice-refresh',
      idToken: jwt({ sub: ALICE }),
      scope: undefined,
      expiresAt: clock + 3_600_000,
    })
    const auth: Auth = {
      config: { issuer: ISSUER, clientId: 'philo-pwa', scope: 'openid email', resource: [] },
      metadata,
      session,
    }
    return {
      auth,
      expire: () => {
        stored = 'bob-refresh'
        clock += 3_600_000
      },
    }
  }

  /** Refreshes answer as BOB with no id_token; every extra answer is ALICE's. */
  function installEndpoint() {
    return installTokenEndpoint((call) =>
      call.body.get('grant_type') === 'refresh_token'
        ? Response.json({ access_token: jwt({ sub: BOB }), refresh_token: 'bob-refresh-2', expires_in: 3600 })
        : Response.json({ access_token: 'opaque-extra', id_token: jwt({ sub: ALICE, nonce: lastNonce }), expires_in: 300 }),
    )
  }

  it('neither hints with nor matches the old id_token once the session is someone else’s', async () => {
    const { auth, expire } = sharedTabAuth()
    configureExtraTokens(auth)
    const calls = installEndpoint()
    expire()
    const token = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    const frame = await answerNext()
    // ALICE's answer is not BOB's, and BOB's session holds no id_token of ALICE's to hint with.
    expect(await token).toBeNull()
    expect(auth.session.idToken).toBeUndefined()
    expect(new URL(frame.src).searchParams.has('id_token_hint')).toBe(false)
    expect(calls.map((call) => call.body.get('grant_type'))).toEqual(['refresh_token', 'authorization_code'])
  })

  it('does not hand out a token cached for the person signed in before', async () => {
    const { auth, expire } = sharedTabAuth()
    configureExtraTokens(auth)
    installEndpoint()
    const first = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await first).toBe('opaque-extra')

    expire()
    const second = getExtraToken({ resource: RESOURCE, scope: SCOPE })
    await answerNext()
    expect(await second).toBeNull()
  })
})

function fakeParent() {
  return { postMessage: vi.fn() }
}

describe('postFramedCallback', () => {
  const callback = `${window.location.origin}/auth/callback?code=c&state=s`

  it('posts the callback URL to a same-origin parent and says the page should stop', () => {
    const parent = fakeParent()
    const handled = postFramedCallback({ self: {}, parent, location: new URL(callback) })
    expect(handled).toBe(true)
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: SILENT_CALLBACK_MESSAGE, url: callback },
      window.location.origin,
    )
  })

  it('leaves a top-level callback, or any other framed page, alone', () => {
    const top = { postMessage: vi.fn() }
    expect(postFramedCallback({ self: top, parent: top, location: new URL(callback) })).toBe(false)
    const parent = fakeParent()
    expect(postFramedCallback({ self: {}, parent, location: new URL(`${window.location.origin}/leads`) })).toBe(false)
    expect(top.postMessage).not.toHaveBeenCalled()
    expect(parent.postMessage).not.toHaveBeenCalled()
  })
})
