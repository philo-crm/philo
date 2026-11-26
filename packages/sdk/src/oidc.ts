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
  /** RFC 9207: the provider promises `iss` on every authorization response. */
  authorization_response_iss_parameter_supported?: boolean | undefined
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
  /**
   * RFC 8707 resource indicators: the APIs the access token is for. One
   * `resource` parameter is sent per value, here and at the token endpoint.
   */
  resource?: readonly string[] | undefined
  /** OIDC Core `prompt`, such as `none` for a silent request. Not sent when unset. */
  prompt?: string | undefined
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
  /** The resource indicators asked for, sent again with the code exchange. */
  resource: string[]
  /** The issuer the request went to, which an RFC 9207 `iss` on the response must name. */
  issuer: string
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
  const resource = [...(options.resource ?? [])]
  for (const value of resource) url.searchParams.append('resource', value)
  if (options.prompt !== undefined) url.searchParams.set('prompt', options.prompt)
  return {
    url: url.toString(),
    state,
    nonce,
    codeVerifier,
    redirectUri: options.redirectUri,
    resource,
    issuer: options.metadata.issuer,
  }
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
  resource: readonly string[] | undefined,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<TokenSet> {
  const body = new URLSearchParams(params)
  for (const value of resource ?? []) body.append('resource', value)
  const res = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  let answer: TokenResponse = {}
  try {
    answer = (await res.json()) as TokenResponse
  } catch {
    // Falls through to the error below with no code from the server.
  }
  if (!res.ok || typeof answer.access_token !== 'string') {
    const code = typeof answer.error === 'string' ? answer.error : 'token_request_failed'
    const description = typeof answer.error_description === 'string' ? answer.error_description : undefined
    throw new OidcError(code, description)
  }
  const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : 3600
  return {
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
    idToken: typeof answer.id_token === 'string' ? answer.id_token : undefined,
    scope: typeof answer.scope === 'string' ? answer.scope : undefined,
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
 * RFC 9207 mix-up defence: the response must come from the issuer the request
 * went to. An absent `iss` is accepted unless discovery promised one, because
 * many providers do not send it yet.
 */
function checkResponseIssuer(options: CallbackOptions, params: URLSearchParams): void {
  const expected = options.metadata.issuer
  // Stored before an upgrade that added the field, a pending request has no issuer.
  const requested = (options.pending as Partial<PendingAuthorization>).issuer ?? expected
  const iss = params.get('iss')
  const promised = options.metadata.authorization_response_iss_parameter_supported === true
  if (requested !== expected || (iss === null ? promised : iss !== expected)) {
    throw new OidcError('issuer_mismatch', 'The sign-in response did not come from the identity provider this client asked.')
  }
}

/**
 * Completes the flow on the redirect back: checks `state` and `iss`, surfaces
 * an IdP error, exchanges the code, and checks the nonce when an id_token came
 * back.
 */
export async function exchangeCode(options: CallbackOptions): Promise<TokenSet> {
  const params = new URL(options.callbackUrl).searchParams
  if (params.get('state') !== options.pending.state) {
    throw new OidcError('state_mismatch', 'The sign-in response does not match the request this client made.')
  }
  // Before the error, too: an error response from the wrong provider is not ours to report.
  checkResponseIssuer(options, params)
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
    options.pending.resource,
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
  /**
   * The sign-in's resource indicators. RFC 8707 §2.2 allows them on a refresh,
   * and a provider that picks the audience from them needs them again here.
   */
  resource?: readonly string[] | undefined
  fetch?: FetchLike | undefined
  now?: (() => number) | undefined
}): Promise<TokenSet> {
  return tokenRequest(
    options.metadata,
    { grant_type: 'refresh_token', client_id: options.clientId, refresh_token: options.refreshToken },
    options.resource,
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

/** Where a session keeps its refresh token between page loads. */
export interface RefreshTokenStore {
  load(): string | undefined
  save(token: string | undefined): void
}

/** Renew this long before expiry, so a request in flight never carries a dead token. */
const EXPIRY_MARGIN_MS = 30_000

/**
 * Holds one signed-in client's tokens: the access token in memory, the
 * refresh token in `store`. `accessToken()` is shaped to plug straight into
 * `PhiloClient`'s `accessToken` option.
 *
 * Concurrent callers share one refresh, which matters with rotation — two
 * refreshes racing with the same token would spend it twice and sign the
 * person out.
 */
export class TokenSession {
  readonly #metadata: OidcMetadata
  readonly #clientId: string
  readonly #store: RefreshTokenStore
  readonly #resource: readonly string[] | undefined
  readonly #fetch: FetchLike
  readonly #now: () => number
  #tokens: TokenSet | undefined
  #refreshing: Promise<TokenSet | undefined> | undefined

  constructor(options: {
    metadata: OidcMetadata
    clientId: string
    store: RefreshTokenStore
    /** Sent with every refresh — see `refreshTokens`. */
    resource?: readonly string[] | undefined
    fetch?: FetchLike | undefined
    now?: (() => number) | undefined
  }) {
    this.#metadata = options.metadata
    this.#clientId = options.clientId
    this.#store = options.store
    this.#resource = options.resource
    this.#fetch = options.fetch ?? defaultFetch
    this.#now = options.now ?? Date.now
  }

  /** True when there is anything to sign in with, without spending it. */
  get hasCredentials(): boolean {
    return this.#tokens !== undefined || this.#store.load() !== undefined
  }

  set(tokens: TokenSet): void {
    this.#tokens = tokens
    if (tokens.refreshToken !== undefined) this.#store.save(tokens.refreshToken)
  }

  accessToken = async (): Promise<string | undefined> => {
    const tokens = this.#tokens
    if (tokens !== undefined && tokens.expiresAt - EXPIRY_MARGIN_MS > this.#now()) return tokens.accessToken
    const refreshed = await this.#refresh()
    return refreshed?.accessToken
  }

  /** Revokes the refresh token at the IdP and forgets everything locally. */
  async signOut(): Promise<void> {
    const token = this.#tokens?.refreshToken ?? this.#store.load()
    this.clear()
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

  #refresh(): Promise<TokenSet | undefined> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  async #doRefresh(): Promise<TokenSet | undefined> {
    const refreshToken = this.#tokens?.refreshToken ?? this.#store.load()
    if (refreshToken === undefined) return undefined
    try {
      const tokens = await refreshTokens({
        metadata: this.#metadata,
        clientId: this.#clientId,
        refreshToken,
        resource: this.#resource,
        fetch: this.#fetch,
        now: this.#now,
      })
      // An IdP that does not rotate answers without a new refresh token; the
      // old one is still the one to keep.
      this.set({ ...tokens, refreshToken: tokens.refreshToken ?? refreshToken })
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
