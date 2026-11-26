import type { FetchLike } from './http.ts'

/**
 * OIDC authorization code + PKCE for public clients (RFC 6749, 7636, 7009,
 * OIDC Core). Written against discovery rather than Philo's own paths, so the
 * same code signs a person in whether the issuer is Philo's built-in IdP or an
 * external one — ADR-0006.
 *
 * What this deliberately does not do: verify the `id_token` signature. A
 * public client receives it directly from the token endpoint over TLS, which
 * OIDC Core §3.1.3.7 accepts in place of validation; the API, not the client,
 * is what decides whether a token is any good.
 */

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string | undefined
  userinfo_endpoint?: string | undefined
  end_session_endpoint?: string | undefined
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | undefined
  idToken: string | undefined
  scope: string | undefined
  /** Epoch milliseconds. */
  expiresAt: number
}

/** A token endpoint refusal, carrying the RFC 6749 §5.2 error code. */
export class OidcError extends Error {
  readonly code: string

  constructor(code: string, description?: string) {
    super(description === undefined ? code : `${code}: ${description}`)
    this.name = 'OidcError'
    this.code = code
  }
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** 32 random bytes, base64url — 43 characters, the RFC 7636 minimum verifier length. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export async function discover(issuer: string, fetchImpl: FetchLike = defaultFetch): Promise<OidcMetadata> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new OidcError('discovery_failed', `${url} answered ${res.status}`)
  const metadata = (await res.json()) as Partial<OidcMetadata>
  if (typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string') {
    throw new OidcError('discovery_failed', `${url} names no authorization or token endpoint`)
  }
  return metadata as OidcMetadata
}

export interface AuthorizationRequestOptions {
  metadata: OidcMetadata
  clientId: string
  redirectUri: string
  scope: string
}

/**
 * Everything the callback has to check against. Store it (session storage is
 * the usual place) before navigating to `url`, and hand it to `exchangeCode`.
 */
export interface PendingAuthorization {
  url: string
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
}

export async function createAuthorizationRequest(
  options: AuthorizationRequestOptions,
): Promise<PendingAuthorization> {
  const state = randomToken()
  const nonce = randomToken()
  const codeVerifier = randomToken()
  const url = new URL(options.metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', options.scope)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', await pkceChallenge(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return { url: url.toString(), state, nonce, codeVerifier, redirectUri: options.redirectUri }
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  scope?: unknown
  expires_in?: unknown
  error?: unknown
  error_description?: unknown
}

async function tokenRequest(
  metadata: OidcMetadata,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<TokenSet> {
  const res = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  })
  let body: TokenResponse = {}
  try {
    body = (await res.json()) as TokenResponse
  } catch {
    // Falls through to the error below with no code from the server.
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : 'token_request_failed'
    const description = typeof body.error_description === 'string' ? body.error_description : undefined
    throw new OidcError(code, description)
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    expiresAt: now() + expiresIn * 1000,
  }
}

export interface CallbackOptions {
  metadata: OidcMetadata
  clientId: string
  pending: PendingAuthorization
  /** The full URL the IdP redirected back to. */
  callbackUrl: string
  fetch?: FetchLike | undefined
  now?: (() => number) | undefined
}

/** Reads a nonce out of an id_token payload without verifying it — see the module note. */
function idTokenNonce(idToken: string): string | undefined {
  const [, payload] = idToken.split('.')
  if (payload === undefined) return undefined
  try {
    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'))
    const claims = JSON.parse(json) as { nonce?: unknown }
    return typeof claims.nonce === 'string' ? claims.nonce : undefined
  } catch {
    return undefined
  }
}

/**
 * Completes the flow on the redirect back: checks `state`, surfaces an IdP
 * error, exchanges the code, and checks the nonce when an id_token came back.
 */
export async function exchangeCode(options: CallbackOptions): Promise<TokenSet> {
  const params = new URL(options.callbackUrl).searchParams
  if (params.get('state') !== options.pending.state) {
    throw new OidcError('state_mismatch', 'The sign-in response does not match the request this client made.')
  }
  const error = params.get('error')
  if (error !== null) throw new OidcError(error, params.get('error_description') ?? undefined)
  const code = params.get('code')
  if (code === null) throw new OidcError('invalid_request', 'The sign-in response carried no code.')

  const tokens = await tokenRequest(
    options.metadata,
    {
      grant_type: 'authorization_code',
      client_id: options.clientId,
      code,
      code_verifier: options.pending.codeVerifier,
      redirect_uri: options.pending.redirectUri,
    },
    options.fetch ?? defaultFetch,
    options.now ?? Date.now,
  )
  if (tokens.idToken !== undefined && idTokenNonce(tokens.idToken) !== options.pending.nonce) {
    throw new OidcError('nonce_mismatch', 'The identity token was not issued for this sign-in.')
  }
  return tokens
}

export function refreshTokens(options: {
  metadata: OidcMetadata
  clientId: string
  refreshToken: string
  fetch?: FetchLike | undefined
  now?: (() => number) | undefined
}): Promise<TokenSet> {
  return tokenRequest(
    options.metadata,
    { grant_type: 'refresh_token', client_id: options.clientId, refresh_token: options.refreshToken },
    options.fetch ?? defaultFetch,
    options.now ?? Date.now,
  )
}

/** RFC 7009. Best-effort by nature: a revocation that fails leaves a token to expire. */
export async function revokeToken(options: {
  metadata: OidcMetadata
  clientId: string
  token: string
  fetch?: FetchLike | undefined
}): Promise<void> {
  if (options.metadata.revocation_endpoint === undefined) return
  await (options.fetch ?? defaultFetch)(options.metadata.revocation_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: options.clientId, token: options.token }).toString(),
  })
}

/**
 * OIDC RP-Initiated Logout 1.0: where to send the browser so the provider ends
 * its own session too, or undefined when discovery names no
 * `end_session_endpoint` — the provider then has no session to end, or none it
 * lets a client end. With no ID token to hint with, the provider usually asks
 * the person to confirm.
 */
export function endSessionUrl(options: {
  metadata: OidcMetadata
  clientId: string
  idToken: string | undefined
  postLogoutRedirectUri: string
  state: string
}): string | undefined {
  const endpoint = options.metadata.end_session_endpoint
  if (endpoint === undefined) return undefined
  const url = new URL(endpoint)
  if (options.idToken !== undefined) url.searchParams.set('id_token_hint', options.idToken)
  // Allowed beside the hint (§2), and some providers want it to accept the return address.
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('post_logout_redirect_uri', options.postLogoutRedirectUri)
  url.searchParams.set('state', options.state)
  return url.toString()
}

/** Where a session keeps its refresh token between page loads. */
export interface RefreshTokenStore {
  load(): string | undefined
  save(token: string | undefined): void
}

/**
 * Runs `fn` while no other holder of `name` runs, across every tab sharing the
 * refresh token store — the shape of the Web Locks API's `navigator.locks.request`.
 */
export type RefreshLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>

/** Renew this long before expiry, so a request in flight never carries a dead token. */
const EXPIRY_MARGIN_MS = 30_000

/**
 * Holds one signed-in client's tokens: the access token in memory, the
 * refresh token in `store`. `accessToken()` is shaped to plug straight into
 * `PhiloClient`'s `accessToken` option.
 *
 * Concurrent callers share one refresh, which matters with rotation — two
 * refreshes racing with the same token would spend it twice and sign the
 * person out. Sessions in other tabs that share the store need `lock` as
 * well: with it, a refresh re-reads the store first and spends the token the
 * last tab stored, never one already spent, and a sign-out waits its turn and
 * revokes that same token.
 *
 * The store is the shared truth. Once it has held a token, finding it empty
 * means another tab signed out, and this session follows rather than bringing
 * the grant back from its copy in memory. Only storage that never kept a token
 * (blocked, or Safari private mode) leaves memory as the source.
 */
export class TokenSession {
  readonly #metadata: OidcMetadata
  readonly #clientId: string
  readonly #store: RefreshTokenStore
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #lock: RefreshLock | undefined
  #tokens: TokenSet | undefined
  #refreshing: Promise<TokenSet | undefined> | undefined
  /** The store has held a token this session could read: empty from now on means signed out. */
  #storeHeld = false
  /** The refresh token this session last spent, to spot a store whose save failed. */
  #presented: string | undefined

  constructor(options: {
    metadata: OidcMetadata
    clientId: string
    store: RefreshTokenStore
    fetch?: FetchLike | undefined
    now?: (() => number) | undefined
    lock?: RefreshLock | undefined
  }) {
    this.#metadata = options.metadata
    this.#clientId = options.clientId
    this.#store = options.store
    this.#fetch = options.fetch ?? defaultFetch
    this.#now = options.now ?? Date.now
    this.#lock = options.lock
  }

  /**
   * The newest ID token this session holds, kept through a refresh of its own
   * grant that sends none, and dropped when it adopts a grant another tab
   * stored. Read it before `signOut()`, which forgets it — it is what an
   * end-session request hints with (`endSessionUrl`).
   */
  get idToken(): string | undefined {
    return this.#tokens?.idToken
  }

  /** True when there is anything to sign in with, without spending it. */
  get hasCredentials(): boolean {
    return this.#tokens !== undefined || this.#load() !== undefined
  }

  set(tokens: TokenSet): void {
    this.#tokens = tokens
    if (tokens.refreshToken === undefined) return
    this.#store.save(tokens.refreshToken)
    this.#load()
  }

  accessToken = async (): Promise<string | undefined> => {
    const tokens = this.#tokens
    if (tokens !== undefined && this.#isFresh(tokens)) return tokens.accessToken
    const refreshed = await this.#refresh()
    return refreshed?.accessToken
  }

  /** Revokes the refresh token at the IdP and forgets everything locally. */
  async signOut(): Promise<void> {
    // Under the lock, so a refresh in another tab cannot store a new token
    // after this clears it; and from the store first, since that is the live
    // token and the copy in memory may already be spent.
    const token = await this.#withLock(() => {
      const live = this.#refreshTokenToSpend()
      this.clear()
      return Promise.resolve(live)
    })
    if (token === undefined) return
    try {
      await revokeToken({ metadata: this.#metadata, clientId: this.#clientId, token, fetch: this.#fetch })
    } catch {
      // Already forgotten here; the grant expires on its own.
    }
  }

  clear(): void {
    this.#tokens = undefined
    this.#store.save(undefined)
  }

  #isFresh(tokens: TokenSet): boolean {
    return tokens.expiresAt - EXPIRY_MARGIN_MS > this.#now()
  }

  #refresh(): Promise<TokenSet | undefined> {
    this.#refreshing ??= this.#lockedRefresh().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  #lockedRefresh(): Promise<TokenSet | undefined> {
    return this.#withLock(() => {
      // Tokens set while waiting (a sign-in finishing) need no refresh.
      const held = this.#tokens
      if (held !== undefined && this.#isFresh(held)) return Promise.resolve(held)
      return this.#doRefresh(this.#refreshTokenToSpend())
    })
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = this.#lock
    if (lock === undefined) return fn()
    let started = false
    const inLock = () => {
      started = true
      return fn()
    }
    try {
      return await lock(`philo.oidc-refresh:${this.#clientId}`, inLock)
    } catch (error) {
      // A lock that cannot be taken costs only the cross-tab guarantee; one
      // that ran `fn` has its own answer, which must not run twice.
      if (started) throw error
      return inLock()
    }
  }

  #load(): string | undefined {
    const token = this.#store.load()
    if (token !== undefined) this.#storeHeld = true
    return token
  }

  /**
   * The store comes first: another tab may have rotated the token since this
   * one last read it, and the copy in memory is then already spent. An empty
   * store that once held a token means another tab signed out, so memory is
   * dropped, not spent. A stored token this session already spent means its
   * own save failed, and memory holds the newer one.
   */
  #refreshTokenToSpend(): string | undefined {
    const memory = this.#tokens?.refreshToken
    const stored = this.#load()
    if (stored === undefined) {
      if (!this.#storeHeld) return memory
      this.#tokens = undefined
      return undefined
    }
    if (stored === this.#presented && memory !== undefined) return memory
    return stored
  }

  async #doRefresh(refreshToken: string | undefined): Promise<TokenSet | undefined> {
    if (refreshToken === undefined) return undefined
    try {
      const tokens = await refreshTokens({
        metadata: this.#metadata,
        clientId: this.#clientId,
        refreshToken,
        fetch: this.#fetch,
        now: this.#now,
      })
      // An IdP that does not rotate answers without a new refresh token, and
      // most send no new ID token; the old one names the same subject (OIDC
      // Core §12.2) only if this session's own grant was spent. A token
      // another tab stored may be someone else's sign-in, so its hint goes.
      const ownGrant = refreshToken === this.#tokens?.refreshToken
      this.#presented = refreshToken
      this.set({
        ...tokens,
        refreshToken: tokens.refreshToken ?? refreshToken,
        idToken: tokens.idToken ?? (ownGrant ? this.#tokens?.idToken : undefined),
      })
      return this.#tokens
    } catch (error) {
      // A refusal means the grant is gone: drop it, so the caller sees a
      // signed-out client rather than retrying a dead token forever. A network
      // failure keeps it for the next attempt.
      if (error instanceof OidcError) this.clear()
      else throw error
      return undefined
    }
  }
}
