import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import {
  createFirstUser,
  hasAnyUser,
  normalizeEmail,
  validatePassword,
  verifyCredentials,
} from '../auth/credentials.ts'
import { bearerToken } from '../auth/middleware.ts'
import { hashPassword } from '../auth/password.ts'
import type { AuthGuards } from '../auth/routes.ts'
import { delay } from '../auth/rate-limit.ts'
import type { SessionUser } from '../auth/session.ts'
import { clientKey } from '../client-key.ts'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { getClient, registerClient, clientSecretMatches, type RegisteredClient } from './clients.ts'
import { renderAuthorizeError, renderConsentPage, type ConsentPage, type ConsentRequest } from './consent.ts'
import { FIRST_PARTY_CLIENT_ID } from './first-party.ts'
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  AUTHORIZATION_SERVER_METADATA_PATH,
  OPENID_CONFIGURATION_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
} from './metadata.ts'
import { ID_TOKEN_ALG, type SigningKey } from './signing-key.ts'
import {
  createAuthorizationCode,
  grantedScope,
  hasScope,
  issueTokens,
  redeemAuthorizationCode,
  redeemRefreshToken,
  resolveAccessToken,
  revokeToken,
  verifyPkce,
  ACCESS_TOKEN_TTL_MS,
  OPENID_SCOPE,
  type GrantSubject,
  type IssuedTokens,
} from './tokens.ts'

/**
 * Ceiling on an OAuth request body. A registration document is the largest
 * thing that crosses it, and every endpoint here is reachable without a
 * session, so something has to bound what an anonymous caller can buffer.
 */
export const MAX_OAUTH_BODY_BYTES = 16 * 1024

/** RFC 7636 §4.1 — the only shape a challenge we issued a code for can have. */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/

/** Long enough for any real `state`, short enough to bound the redirect we build. */
const MAX_STATE_LENGTH = 2048

/** Same bound for the values the form carries back and the code row stores. */
const MAX_NONCE_LENGTH = 512
const MAX_SCOPE_LENGTH = 512

/** Bounds an optional display name typed into the setup dialog. */
const MAX_NAME_LENGTH = 200

export interface OAuthDeps {
  db: Db
  /** Externally reachable origin. The issuer, and what every advertised URL is built from. */
  publicBaseUrl: string
  trustProxy: boolean
  guards: AuthGuards
  /** Signs id_tokens; published at `/oauth/jwks`. */
  signingKey: SigningKey
  /** The MCP app's URL — a resource a token may name besides this server. */
  mcpUrl: string
}

/** A form or query value, when it is a string rather than an uploaded file. */
function field(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function oauthError(c: Context, status: 400 | 401 | 429 | 503, error: string, description: string) {
  if (status === 401) c.header('WWW-Authenticate', 'Basic realm="philo"')
  return c.json({ error, error_description: description }, status)
}

/**
 * Sends an error back to the client instead of showing it to the operator.
 * Only reachable once the redirect URI is known to be one the client registered
 * — see `renderAuthorizeError` for why that order matters.
 */
function redirectWithError(
  c: Context,
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string,
) {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (state !== undefined) url.searchParams.set('state', state)
  return c.redirect(url.toString(), 302)
}

type AuthorizeCheck =
  | { kind: 'refuse'; message: string }
  | { kind: 'redirect'; redirectUri: string; state: string | undefined; error: string; description: string }
  | { kind: 'ok'; client: RegisteredClient; request: ConsentRequest }

/**
 * Validates an authorization request, in the order OAuth requires: everything
 * that decides *where* a response may be sent comes first, because an error in
 * `client_id` or `redirect_uri` must never be redirected anywhere.
 *
 * Run identically for the `GET` that renders the page and the `POST` that acts
 * on it, so a form field edited in the browser buys nothing.
 */
function checkAuthorizeRequest(deps: OAuthDeps, params: Record<string, unknown>): AuthorizeCheck {
  const clientId = field(params, 'client_id')
  if (clientId === undefined) return { kind: 'refuse', message: 'The request did not name a client.' }

  const client = getClient(deps.db, clientId)
  if (client === undefined) {
    return { kind: 'refuse', message: 'This application is not registered with Philo.' }
  }

  const requested = field(params, 'redirect_uri')
  let redirectUri: string
  if (requested === undefined) {
    // Permitted only when there is no ambiguity about what it would have been.
    const [only] = client.redirectUris
    if (only === undefined || client.redirectUris.length !== 1) {
      return { kind: 'refuse', message: 'The request did not say where to send the response.' }
    }
    redirectUri = only
  } else {
    if (!client.redirectUris.some((registered) => redirectUriMatches(requested, registered))) {
      return { kind: 'refuse', message: 'This application asked to be sent somewhere it did not register.' }
    }
    redirectUri = requested
  }

  const state = field(params, 'state')
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: 'redirect',
    redirectUri,
    state,
    error,
    description,
  })

  const scope = field(params, 'scope')
  const nonce = field(params, 'nonce')
  if (
    (state !== undefined && state.length > MAX_STATE_LENGTH) ||
    (scope !== undefined && scope.length > MAX_SCOPE_LENGTH) ||
    (nonce !== undefined && nonce.length > MAX_NONCE_LENGTH)
  ) {
    return { kind: 'refuse', message: 'The request was too large to process.' }
  }
  if (field(params, 'response_type') !== 'code') {
    return fail('unsupported_response_type', 'Only the authorization code flow is supported.')
  }

  const codeChallenge = field(params, 'code_challenge')
  if (codeChallenge === undefined || !CODE_CHALLENGE_RE.test(codeChallenge)) {
    return fail('invalid_request', 'A PKCE code_challenge is required.')
  }
  if (field(params, 'code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'code_challenge_method must be S256.')
  }

  const resource = field(params, 'resource')
  if (resource !== undefined && !resourceMatches(deps, resource)) {
    return fail('invalid_target', 'This authorization server issues tokens for this Philo instance only.')
  }

  return {
    kind: 'ok',
    client,
    request: { clientId, redirectUri, codeChallenge, state, resource, scope, nonce },
  }
}

/**
 * RFC 8707: a token is for this instance — the API, or the MCP app that
 * forwards it to the API. Clients differ on whether the identifier includes a
 * path, so the bare base URL and the API prefix name the instance too.
 */
function resourceMatches(deps: Pick<OAuthDeps, 'publicBaseUrl' | 'mcpUrl'>, resource: string): boolean {
  let normalized: string
  try {
    const url = new URL(resource)
    url.hash = ''
    normalized = url.toString().replace(/\/$/, '')
  } catch {
    return false
  }
  return [deps.publicBaseUrl, `${deps.publicBaseUrl}/api/v1`, deps.mcpUrl].includes(normalized)
}

/**
 * Which dialog an authorization request gets. The PWA's own sign-in has no
 * third party to approve, and on an instance with no account yet it is where
 * that account is made — ADR-0006. A third-party client on an empty instance
 * sees the consent page, whose sign-in cannot succeed until setup is done.
 */
function dialogMode(db: Db, clientId: string): ConsentPage['mode'] {
  if (clientId !== FIRST_PARTY_CLIENT_ID) return 'consent'
  return hasAnyUser(db) ? 'signin' : 'setup'
}

/**
 * The built-in IdP: an OAuth 2.1 authorization server with the OIDC layer on
 * top — DESIGN.md (Auth and access), ADR-0006. Every client signs in here: the
 * PWA as the operator, connector clients as agents. Its tokens are bearer
 * credentials for the API, and an external IdP can stand in for all of it.
 */
export function createOAuthRoutes(deps: OAuthDeps): Hono {
  const routes = new Hono()

  // Codes, tokens and the consent form are all credentials in flight.
  routes.use('/*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  routes.use(
    '/*',
    bodyLimit({
      maxSize: MAX_OAUTH_BODY_BYTES,
      onError: (c) => oauthError(c, 400, 'invalid_request', 'Request body too large.'),
    }),
  )

  // Called by clients running in a browser as well as on a server — the PWA
  // among them, from its own origin — and none reads a cookie, so opening them
  // to any origin adds no authority. The dialog is deliberately not in here: it
  // is a form, and `csrf()` below is what guards it.
  for (const path of ['/register', '/token', '/revoke', '/userinfo', '/jwks']) routes.use(path, cors())

  routes.post('/register', async (c) => {
    // Unauthenticated by construction (RFC 7591), so the only bound on how fast
    // a stranger can fill this table is here and in `MAX_REGISTERED_CLIENTS`.
    const key = `oauth_register:${clientKey(c, deps.trustProxy)}`
    deps.guards.throttle.recordAttempt(key)
    await delay(deps.guards.throttle.delayFor(key), c.req.raw.signal)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'Expected a JSON registration document.')
    }

    const result = registerClient(deps.db, body)
    if (!result.ok) {
      if (result.error === 'too_many_clients') {
        return oauthError(
          c,
          503,
          'temporarily_unavailable',
          'This instance is holding as many client registrations as it will.',
        )
      }
      const description =
        result.error === 'invalid_redirect_uri'
          ? 'Every redirect_uri must be https, or http on loopback.'
          : 'The registration document is not one this server accepts.'
      return oauthError(
        c,
        400,
        result.error === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata',
        description,
      )
    }
    return c.json(result.value, 201)
  })

  // The form below posts back to this same path. `csrf()` is defence in depth
  // rather than the load-bearing part: the POST carries the operator's password,
  // which a cross-site page cannot supply, and that is what lets one request
  // both authenticate and consent.
  //
  // The origin is named rather than left to the default. Without it hono
  // compares against the request URL's origin, which @hono/node-server derives
  // from the socket — so behind the TLS-terminating proxy DESIGN.md deploys
  // against, the server would compute `http://host` while the browser sends
  // `https://host`, and approval would rest entirely on `Sec-Fetch-Site`.
  routes.use('/authorize', csrf({ origin: new URL(deps.publicBaseUrl).origin }))

  routes.get('/authorize', async (c) => {
    const check = checkAuthorizeRequest(deps, c.req.query())
    if (check.kind === 'refuse') return c.html(renderAuthorizeError(check.message), 400)
    if (check.kind === 'redirect') {
      return redirectWithError(c, check.redirectUri, check.state, check.error, check.description)
    }
    return c.html(
      renderConsentPage({
        ...check.request,
        mode: dialogMode(deps.db, check.request.clientId),
        clientName: check.client.clientName,
        clientUri: check.client.clientUri,
      }),
    )
  })

  routes.post('/authorize', async (c) => {
    const body = await c.req.parseBody()
    const check = checkAuthorizeRequest(deps, body)
    if (check.kind === 'refuse') return c.html(renderAuthorizeError(check.message), 400)
    if (check.kind === 'redirect') {
      return redirectWithError(c, check.redirectUri, check.state, check.error, check.description)
    }
    const { request } = check
    const mode = dialogMode(deps.db, request.clientId)

    if (field(body, 'deny') !== undefined) {
      return redirectWithError(
        c,
        request.redirectUri,
        request.state,
        'access_denied',
        'The operator declined the request.',
      )
    }

    const email = normalizeEmail(field(body, 'email'))
    const password = validatePassword(field(body, 'password'))
    const { throttle, hashGate } = deps.guards

    const refuse = (message: string, status: 400 | 401 | 409 | 429) =>
      c.html(
        renderConsentPage({
          ...request,
          mode: dialogMode(deps.db, request.clientId),
          clientName: check.client.clientName,
          clientUri: check.client.clientUri,
          error: message,
          email: email ?? undefined,
        }),
        status,
      )
    const approve = (account: SessionUser) => {
      const code = createAuthorizationCode(deps.db, {
        clientId: request.clientId,
        userId: account.id,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource ?? null,
        scope: grantedScope(request.clientId, request.scope),
        nonce: request.nonce ?? null,
      })
      const url = new URL(request.redirectUri)
      url.searchParams.set('code', code)
      if (request.state !== undefined) url.searchParams.set('state', request.state)
      return c.redirect(url.toString(), 302)
    }

    if (field(body, 'setup') !== undefined) {
      // Decided by the server's state, not the form: a setup POST to an
      // instance that has an account is refused, whatever the page said.
      if (mode !== 'setup') return refuse('This instance already has an account. Sign in instead.', 409)

      // Every attempt counts while the window is open, not only failures —
      // there is no account to lock anyone out of, and the first success
      // closes the window for good.
      const setupKey = `setup:${clientKey(c, deps.trustProxy)}`
      throttle.recordAttempt(setupKey)
      await delay(throttle.delayFor(setupKey), c.req.raw.signal)

      if (email === undefined) return refuse('Enter a valid email address.', 400)
      if (password === undefined) return refuse('Choose a longer password.', 400)
      if (!hashGate.tryAcquire()) {
        c.header('Retry-After', '1')
        return refuse('Philo is busy. Try again.', 429)
      }
      let passwordHash: string
      try {
        passwordHash = await hashPassword(password)
      } finally {
        hashGate.release()
      }
      const rawName = field(body, 'name')?.trim()
      const name = rawName === undefined || rawName === '' ? null : rawName.slice(0, MAX_NAME_LENGTH)
      const created = createFirstUser(deps.db, { email, passwordHash, name })
      if (created === undefined) return refuse('This instance already has an account. Sign in instead.', 409)
      return approve(created)
    }

    // Both keys matter, and both are the same buckets the login route uses: the
    // address bounds credential stuffing against the one account, the caller
    // bounds someone working through many.
    const ipKey = `ip:${clientKey(c, deps.trustProxy)}`
    throttle.recordAttempt(ipKey)
    const emailKey = email === undefined ? undefined : `email:${email}`
    if (emailKey !== undefined) throttle.recordAttempt(emailKey)
    const wait = Math.max(
      throttle.delayFor(ipKey),
      emailKey === undefined ? 0 : throttle.delayFor(emailKey),
    )
    await delay(wait, c.req.raw.signal)

    if (email === undefined || password === undefined) {
      return refuse('That email or password is not right.', 401)
    }
    if (c.req.raw.signal.aborted) return refuse('That email or password is not right.', 401)
    if (!hashGate.tryAcquire()) {
      c.header('Retry-After', '1')
      return refuse('Philo is busy checking other sign-ins. Try again.', 429)
    }

    let account: SessionUser | undefined
    try {
      account = await verifyCredentials(deps.db, email, password)
    } finally {
      hashGate.release()
    }
    if (account === undefined) return refuse('That email or password is not right.', 401)

    throttle.reset(ipKey)
    if (emailKey !== undefined) throttle.reset(emailKey)
    return approve(account)
  })

  routes.post('/token', async (c) => {
    const body = await c.req.parseBody()
    const client = authenticateClient(deps.db, c, body)
    if (client === undefined) {
      return oauthError(c, 401, 'invalid_client', 'Client authentication failed.')
    }

    const grantType = field(body, 'grant_type')
    if (grantType === 'authorization_code') return exchangeCode(deps, c, client, body)
    if (grantType === 'refresh_token') return exchangeRefreshToken(deps, c, client, body)
    return oauthError(c, 400, 'unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.')
  })

  // RFC 7009. How the PWA's sign-out actually ends the grant rather than just
  // forgetting it locally.
  routes.post('/revoke', async (c) => {
    const body = await c.req.parseBody()
    const client = authenticateClient(deps.db, c, body)
    if (client === undefined) {
      return oauthError(c, 401, 'invalid_client', 'Client authentication failed.')
    }
    const token = field(body, 'token')
    if (token === undefined) return oauthError(c, 400, 'invalid_request', 'token is required.')
    revokeToken(deps.db, token, client.clientId)
    return c.body(null, 200)
  })

  // OIDC Core §5.3. Only for a token granted `openid`: identity is what the
  // client asked to learn, and a token that never asked has no business here.
  routes.on(['GET', 'POST'], '/userinfo', (c) => {
    const token = bearerToken(c.req.header('authorization'))
    const grant = token === undefined ? undefined : resolveAccessToken(deps.db, token)
    if (grant === undefined || !hasScope(grant.scope, OPENID_SCOPE)) {
      c.header('WWW-Authenticate', 'Bearer realm="philo", error="invalid_token"')
      return c.json({ error: 'invalid_token' }, 401)
    }
    const user = userClaims(deps.db, grant.userId)
    if (user === undefined) return c.json({ error: 'invalid_token' }, 401)
    return c.json(user)
  })

  routes.get('/jwks', (c) => c.json({ keys: [deps.signingKey.publicJwk] }))

  return routes
}

function userClaims(db: Db, userId: number): { sub: string; email: string; name?: string } | undefined {
  const [user] = db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).all()
  if (user === undefined) return undefined
  return { sub: String(userId), email: user.email, ...(user.name === null ? {} : { name: user.name }) }
}

/** OIDC Core §2. Signed, never encrypted: it travels only in a TLS response to its own client. */
async function idToken(deps: OAuthDeps, subject: GrantSubject, nonce: string | null): Promise<string | undefined> {
  const claims = userClaims(deps.db, subject.userId)
  if (claims === undefined) return undefined
  const { sub, ...rest } = claims
  const jwt = new SignJWT({ ...rest, ...(nonce === null ? {} : { nonce }) })
    .setProtectedHeader({ alg: ID_TOKEN_ALG, kid: deps.signingKey.kid, typ: 'JWT' })
    .setIssuer(deps.publicBaseUrl)
    .setSubject(sub)
    .setAudience(subject.clientId)
    .setIssuedAt()
    .setExpirationTime(`${Math.floor(ACCESS_TOKEN_TTL_MS / 1000)}s`)
  return jwt.sign(deps.signingKey.privateKey)
}

async function exchangeCode(
  deps: OAuthDeps,
  c: Context,
  client: RegisteredClient,
  body: Record<string, unknown>,
) {
  const code = field(body, 'code')
  const verifier = field(body, 'code_verifier')
  if (code === undefined || verifier === undefined) {
    return oauthError(c, 400, 'invalid_request', 'code and code_verifier are both required.')
  }

  // Redeeming consumes the code whether or not the rest of this succeeds, so a
  // failed exchange cannot be retried with a different verifier.
  const grant = redeemAuthorizationCode(deps.db, code)
  if (grant === undefined || grant.clientId !== client.clientId) {
    return oauthError(c, 400, 'invalid_grant', 'That authorization code is not valid.')
  }

  const redirectUri = field(body, 'redirect_uri')
  if (redirectUri !== undefined && redirectUri !== grant.redirectUri) {
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.')
  }
  if (!verifyPkce(grant.codeChallenge, verifier)) {
    return oauthError(c, 400, 'invalid_grant', 'The PKCE code_verifier does not match.')
  }

  const resource = field(body, 'resource')
  if (resource !== undefined && !resourceMatches(deps, resource)) {
    return oauthError(c, 400, 'invalid_target', 'That resource is not one this server issues tokens for.')
  }

  const subject: GrantSubject = {
    clientId: grant.clientId,
    userId: grant.userId,
    resource: grant.resource,
    scope: grant.scope,
  }
  const tokens = issueTokens(deps.db, subject)
  const id = hasScope(grant.scope, OPENID_SCOPE) ? await idToken(deps, subject, grant.nonce) : undefined
  return tokenResponse(c, tokens, id)
}

function exchangeRefreshToken(
  deps: OAuthDeps,
  c: Context,
  client: RegisteredClient,
  body: Record<string, unknown>,
) {
  const presented = field(body, 'refresh_token')
  if (presented === undefined) {
    return oauthError(c, 400, 'invalid_request', 'refresh_token is required.')
  }

  // Every refusal comes before the redemption, so a rejected refresh leaves the
  // grant intact. `exchangeCode` is deliberately the opposite way round: there,
  // burning the code on failure is what stops the PKCE verifier being guessed,
  // and a refresh token has no second secret to guess. The mistake this avoids
  // is not hypothetical — a client that keeps sending the resource identifier
  // from before `PHILO_PUBLIC_BASE_URL` was corrected would otherwise destroy
  // its own grant on the first refresh, and need the whole consent flow again.
  const resource = field(body, 'resource')
  if (resource !== undefined && !resourceMatches(deps, resource)) {
    return oauthError(c, 400, 'invalid_target', 'That resource is not one this server issues tokens for.')
  }

  // The client is part of the lookup, so presenting someone else's token spends
  // nothing — see `redeemRefreshToken`.
  const subject = redeemRefreshToken(deps.db, presented, client.clientId)
  if (subject === undefined) {
    return oauthError(c, 400, 'invalid_grant', 'That refresh token is not valid.')
  }
  return tokenResponse(c, issueTokens(deps.db, subject))
}

function tokenResponse(c: Context, tokens: IssuedTokens, signedIdToken?: string | undefined) {
  return c.json({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    // Stated because it is not necessarily what was asked for — see grantedScope.
    scope: tokens.scope,
    ...(signedIdToken === undefined ? {} : { id_token: signedIdToken }),
  })
}

/**
 * RFC 6749 §2.3.1. A client registered with a secret must present it, by
 * `client_secret_basic` or `client_secret_post`; a public client presents only
 * its id, and PKCE is what stands in for the secret it does not have.
 */
function authenticateClient(
  db: Db,
  c: Context,
  body: Record<string, unknown>,
): RegisteredClient | undefined {
  const basic = parseBasicAuth(c.req.header('authorization'))
  const clientId = basic?.clientId ?? field(body, 'client_id')
  if (clientId === undefined) return undefined

  const client = getClient(db, clientId)
  if (client === undefined) return undefined

  if (client.clientSecretHash === null) return client

  const secret = basic?.clientSecret ?? field(body, 'client_secret')
  if (secret === undefined || !clientSecretMatches(client, secret)) return undefined
  return client
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (header === undefined) return undefined
  const match = /^basic\s+(\S+)$/i.exec(header.trim())
  if (match?.[1] === undefined) return undefined
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return undefined
  }
  const separator = decoded.indexOf(':')
  if (separator === -1) return undefined
  // RFC 6749 requires both halves to be form-urlencoded before the base64.
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    }
  } catch {
    return undefined
  }
}

/**
 * Discovery, mounted at `/.well-known`. Public, and read by clients that have
 * no credential yet — which is the whole point of them.
 */
export function createWellKnownRoutes(deps: { publicBaseUrl: string }): Hono {
  const routes = new Hono()
  routes.use('/*', cors())
  const prefix = '/.well-known'
  for (const path of [AUTHORIZATION_SERVER_METADATA_PATH, OPENID_CONFIGURATION_PATH]) {
    routes.get(path.slice(prefix.length), (c) => c.json(authorizationServerMetadata(deps.publicBaseUrl)))
  }
  routes.get(PROTECTED_RESOURCE_METADATA_PATH.slice(prefix.length), (c) =>
    c.json(protectedResourceMetadata(deps.publicBaseUrl, deps.publicBaseUrl)),
  )
  return routes
}
