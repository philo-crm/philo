import { createAuthorizationRequest, exchangeCode, OidcError, type PendingAuthorization } from '@philo/sdk'
import { CALLBACK_PATH, type Auth } from './auth.ts'

/**
 * Silent authorization for a second audience: an access token for some API
 * other than Philo's, from the same external IdP the PWA signs in with, without
 * a page of its own.
 *
 * The request goes out in a hidden frame with the PWA's own client id and its
 * one redirect URI, so the operator registers nothing new. When the IdP
 * answers without showing a page, the frame lands on `/auth/callback`, which
 * `main.tsx` notices is framed and posts back here instead of booting the app
 * (`postFramedCallback`). The code is exchanged through the SDK's
 * `exchangeCode`, so state, RFC 9207 `iss` and nonce are checked exactly as
 * for the sign-in itself.
 *
 * The token is for the person signed in to the PWA, or it is not handed out.
 * A silent request answers for whoever holds the IdP session *now*, which on a
 * shared machine may be someone else since the PWA signed in; state, nonce and
 * `iss` bind the answer to the request, not to the person. So the request asks
 * for `openid` as well, carries the sign-in's id_token as `id_token_hint` when
 * one is held (a hint the IdP may ignore, so it is not the guarantee), and the
 * answer is compared before anything is cached: the subject of its id_token,
 * or of its access token when that is a JWT, must equal the session's, taken
 * from the sign-in's id_token or else from the session's access token when
 * that is a JWT. Claims are read without verifying signatures, as the SDK does
 * for the nonce: both tokens come straight from the token endpoint over TLS.
 * A mismatch, or no subject on either side, answers `null` and counts as a
 * refusal until the next sign-in. With an IdP that issues opaque access tokens
 * and the id_token gone after a reload, that means `null` until the person
 * signs in again; the alternative would be a token for someone unknown.
 *
 * The session's person is worked out afresh on every call, after its access
 * token is refreshed: a refresh that adopts a grant another tab stored drops
 * the sign-in's id_token (TokenSession's own-grant rule), since that grant may
 * be someone else's, and the person is then whoever the new access token
 * names. Cached tokens and refusals are kept per person, so a token fetched
 * for one is never handed to another.
 * `prompt` is still only what the caller asked for: `id_token_hint` makes
 * `prompt=none` safer, but does not imply it.
 *
 * Tokens live in memory only. A refresh token the IdP returns is dropped: the
 * one in `localStorage` is the sign-in's, and a second would widen what a
 * script reading storage could take.
 *
 * It needs the IdP's session cookie inside a frame, so it works only when the
 * IdP and the PWA are same-site or the browser allows third-party cookies.
 * Everything else answers `null`, never a throw: the PWA works without it.
 */

export interface ExtraTokenRequest {
  /** RFC 8707 resource indicator: the API the token is for. */
  resource: string
  scope: string
  /** OIDC `prompt`. Not sent when unset; some IdPs answer a hidden request only with `none`, others only without. */
  prompt?: string | undefined
}

/** The message a framed `/auth/callback` posts to its parent. */
export const SILENT_CALLBACK_MESSAGE = 'philo:silent-callback'

/** How long the IdP has to answer. Longer means it wanted to show a page, which a hidden frame never will. */
export const EXTRA_TOKEN_TIMEOUT_MS = 10_000

/** Renew this long before expiry, as the sign-in's own session does. */
const EXPIRY_MARGIN_MS = 30_000

interface Cached {
  accessToken: string
  expiresAt: number
}

interface State {
  auth: Auth
  cache: Map<string, Cached>
  inFlight: Map<string, Promise<string | null>>
  /** Keys the IdP refused this sign-in; asked again only after the next one. */
  refused: Set<string>
  /** Aborted when the sign-in ends, which ends every request it started. */
  ended: AbortController
}

let state: State | undefined

/**
 * Points the module at the signed-in session, or at none. Each call is a fresh
 * start: the cache and the refusals go, and requests in flight answer `null`.
 */
export function configureExtraTokens(auth: Auth | undefined): void {
  state?.ended.abort()
  state =
    auth === undefined
      ? undefined
      : { auth, cache: new Map(), inFlight: new Map(), refused: new Set(), ended: new AbortController() }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * The built-in IdP is Philo's own server, and it has only Philo's own
 * resource to give out. Its issuer is the server's public URL: the API's
 * origin, which is this page's unless the PWA was built to talk to another.
 */
function isBuiltInIdp(auth: Auth): boolean {
  const api = import.meta.env.VITE_PHILO_API_URL || window.location.origin
  return sameOrigin(auth.config.issuer, api) || sameOrigin(auth.config.issuer, window.location.origin)
}

export function getExtraToken(request: ExtraTokenRequest): Promise<string | null> {
  const current = state
  if (current === undefined || isBuiltInIdp(current.auth) || !current.auth.session.hasCredentials) {
    return Promise.resolve(null)
  }
  return lookup(current, request)
}

interface Person {
  subject: string
  /** The sign-in's id_token, to hint with, when the session still holds one. */
  idToken: string | undefined
}

/**
 * Who the session is for right now, or undefined when that is unknown or the
 * session could not be refreshed. The refresh comes first, and the id_token is
 * read after it: one read before could belong to a grant the refresh replaced.
 */
async function signedInPerson(auth: Auth): Promise<Person | undefined> {
  let accessToken: string | undefined
  try {
    accessToken = await auth.session.accessToken()
  } catch {
    return undefined // A network failure refreshing the session; ask again later.
  }
  const idToken = auth.session.idToken
  const subject = jwtSubject(idToken) ?? jwtSubject(accessToken)
  return subject === undefined ? undefined : { subject, idToken }
}

async function lookup(current: State, request: ExtraTokenRequest): Promise<string | null> {
  // With no person to compare an answer with, no answer could be handed out.
  const person = await signedInPerson(current.auth)
  if (person === undefined || current.ended.signal.aborted) return null
  // `prompt` too: an IdP that refuses one prompt may answer another, and a
  // host's refusal must not stand for Philo's own callers (ADR-0013).
  const key = JSON.stringify([person.subject, request.resource, request.scope, request.prompt ?? null])
  const cached = current.cache.get(key)
  if (cached !== undefined && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return Promise.resolve(cached.accessToken)
  }
  if (current.refused.has(key)) return Promise.resolve(null)
  let pending = current.inFlight.get(key)
  if (pending === undefined) {
    pending = ask(current, key, request, person).finally(() => current.inFlight.delete(key))
    current.inFlight.set(key, pending)
  }
  return pending
}

/**
 * The `sub` claim of a JWT, read without verifying it (see the module note),
 * or undefined for anything that is not a JWT with a string `sub`.
 */
export function jwtSubject(token: string | undefined): string | undefined {
  const parts = token?.split('.')
  if (parts?.length !== 3 || parts[1] === undefined) return undefined
  try {
    const claims: unknown = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')))
    const sub = typeof claims === 'object' && claims !== null ? (claims as { sub?: unknown }).sub : undefined
    return typeof sub === 'string' && sub !== '' ? sub : undefined
  } catch {
    return undefined
  }
}

/** The caller's scope with `openid` added if missing, so the answer carries an id_token naming its subject. */
function withOpenid(scope: string): string {
  const values = scope.split(' ').filter((value) => value !== '')
  return values.includes('openid') ? scope : ['openid', ...values].join(' ')
}

async function ask(current: State, key: string, request: ExtraTokenRequest, person: Person): Promise<string | null> {
  const { auth } = current
  let authorization: PendingAuthorization
  try {
    authorization = await createAuthorizationRequest({
      metadata: auth.metadata,
      clientId: auth.config.clientId,
      redirectUri: `${window.location.origin}${CALLBACK_PATH}`,
      scope: withOpenid(request.scope),
      resource: [request.resource],
      prompt: request.prompt,
      idTokenHint: person.idToken,
    })
  } catch {
    return null
  }
  if (current.ended.signal.aborted) return null

  const callbackUrl = await callbackInFrame(authorization.url, current.ended.signal)
  if (callbackUrl === undefined) {
    // Timed out: the IdP wanted to show a page, and it will want to again.
    if (!current.ended.signal.aborted) current.refused.add(key)
    return null
  }
  try {
    const tokens = await exchangeCode({
      metadata: auth.metadata,
      clientId: auth.config.clientId,
      pending: authorization,
      callbackUrl,
    })
    if (current.ended.signal.aborted) return null
    // Before the cache: a token for someone else, or someone unknown, is a refusal.
    if ((jwtSubject(tokens.idToken) ?? jwtSubject(tokens.accessToken)) !== person.subject) {
      current.refused.add(key)
      return null
    }
    // tokens.refreshToken is deliberately not kept anywhere.
    current.cache.set(key, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
    return tokens.accessToken
  } catch (error) {
    // An answer from the IdP (or a response that failed its checks) stands
    // until the next sign-in; a dropped connection may be asked again.
    if (error instanceof OidcError && !current.ended.signal.aborted) current.refused.add(key)
    return null
  }
}

/**
 * Loads `url` in a hidden frame and resolves with the callback URL the frame
 * posts back, or undefined on a timeout or once `signal` aborts. Only a
 * message from this page's own origin, sent by this frame, counts.
 */
function callbackInFrame(url: string, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.title = 'Sign-in check'

    function finish(result: string | undefined): void {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      signal.removeEventListener('abort', onAbort)
      frame.remove()
      resolve(result)
    }
    function onMessage(event: MessageEvent): void {
      if (event.origin !== window.location.origin) return
      if (event.source === null || event.source !== frame.contentWindow) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null) return
      const { type, url: posted } = data as { type?: unknown; url?: unknown }
      if (type !== SILENT_CALLBACK_MESSAGE || typeof posted !== 'string') return
      finish(posted)
    }
    function onAbort(): void {
      finish(undefined)
    }

    const timer = window.setTimeout(() => finish(undefined), EXTRA_TOKEN_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    signal.addEventListener('abort', onAbort)
    frame.src = url
    document.body.append(frame)
  })
}

/** The parts of `window` the framed callback needs, so a test can hand it stand-ins. */
export interface FrameContext {
  self: unknown
  parent: { postMessage(message: unknown, targetOrigin: string): void }
  location: { href: string; origin: string; pathname: string }
}

/**
 * Run first thing on every load. In a frame at `/auth/callback` — the hidden
 * request above, coming back — it posts the URL to the parent, only ever to
 * this page's own origin, and answers true: the page must stop there, before
 * React mounts and the full-page callback logic tries to spend the code.
 */
export function postFramedCallback(context: FrameContext = window): boolean {
  if (context.parent === context.self || context.location.pathname !== CALLBACK_PATH) return false
  context.parent.postMessage({ type: SILENT_CALLBACK_MESSAGE, url: context.location.href }, context.location.origin)
  return true
}
