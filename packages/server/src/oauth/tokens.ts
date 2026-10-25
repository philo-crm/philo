import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { accessTokens, authorizationCodes, refreshTokens } from '../db/schema.ts'
import { FIRST_PARTY_CLIENT_ID } from './first-party.ts'

/**
 * Agent authority: everything an API key reaches. Granted to every dynamically
 * registered client, whatever it asked for — ADR-0006.
 */
export const MCP_SCOPE = 'mcp'

/** Operator authority. Granted only to the first-party client, the PWA. */
export const OPERATOR_SCOPE = 'operator'

/** OIDC: an id_token comes back with the tokens. Honoured when asked for. */
export const OPENID_SCOPE = 'openid'

/**
 * What a client is granted, which RFC 6749 §5.1 lets differ from what it asked
 * for. Authority comes from the client, never the request: a connector that
 * asks for `operator` gets `mcp`, so registering oneself buys nothing more than
 * an API key would.
 */
export function grantedScope(clientId: string, requested: string | undefined): string {
  const asked = new Set((requested ?? '').split(' ').filter((scope) => scope !== ''))
  const authority = clientId === FIRST_PARTY_CLIENT_ID ? OPERATOR_SCOPE : MCP_SCOPE
  return asked.has(OPENID_SCOPE) ? `${OPENID_SCOPE} ${authority}` : authority
}

export function hasScope(scope: string, wanted: string): boolean {
  return scope.split(' ').includes(wanted)
}

/**
 * Long enough to survive a slow redirect back to the client, short enough that
 * a code caught in a proxy log is dead before anyone reads it. Single use
 * regardless: redeeming deletes the row.
 */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000

/** Same window as a browser session — DESIGN.md (Auth and access). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

const TOKEN_BYTES = 32

/** RFC 7636 §4.1. Anything outside this cannot be a verifier we ever accepted. */
const MIN_VERIFIER_LENGTH = 43
const MAX_VERIFIER_LENGTH = 128

const CODE_PREFIX = 'philo_ac_'
const ACCESS_PREFIX = 'philo_at_'
const REFRESH_PREFIX = 'philo_rt_'

/** Same call, and the same reasoning, as `hashApiKey` — see api-keys.ts. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generate(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

export interface GrantSubject {
  clientId: string
  /** The operator who signed in on the consent page. */
  userId: number
  /** RFC 8707 target, when the client named one. */
  resource: string | null
  /** Space-separated, as `grantedScope` built it. */
  scope: string
}

export interface AuthorizationCodeGrant extends GrantSubject {
  redirectUri: string
  codeChallenge: string
  nonce: string | null
}

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  /** Access token lifetime in seconds, for the token response. */
  expiresIn: number
  scope: string
}

export function createAuthorizationCode(
  db: Db,
  grant: AuthorizationCodeGrant,
  now = new Date(),
): string {
  deleteExpiredGrants(db, now)
  const code = generate(CODE_PREFIX)
  db.insert(authorizationCodes)
    .values({
      codeHash: hashToken(code),
      clientId: grant.clientId,
      userId: grant.userId,
      redirectUri: grant.redirectUri,
      codeChallenge: grant.codeChallenge,
      resource: grant.resource,
      scope: grant.scope,
      nonce: grant.nonce,
      createdAt: now,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
    })
    .run()
  return code
}

/**
 * Consumes a code and returns what it granted, or undefined.
 *
 * The row is deleted whether or not it had expired, so a code is good for
 * exactly one attempt — a replay finds nothing, which is what makes an
 * intercepted code worthless once the real client has used it.
 */
export function redeemAuthorizationCode(
  db: Db,
  code: string,
  now = new Date(),
): AuthorizationCodeGrant | undefined {
  const [row] = db
    .delete(authorizationCodes)
    .where(eq(authorizationCodes.codeHash, hashToken(code)))
    .returning()
    .all()
  if (row === undefined) return undefined
  if (row.expiresAt.getTime() <= now.getTime()) return undefined
  return {
    clientId: row.clientId,
    userId: row.userId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    resource: row.resource,
    scope: row.scope,
    nonce: row.nonce,
  }
}

export function issueTokens(db: Db, subject: GrantSubject, now = new Date()): IssuedTokens {
  deleteExpiredGrants(db, now)
  const accessToken = generate(ACCESS_PREFIX)
  const refreshToken = generate(REFRESH_PREFIX)
  const values = {
    clientId: subject.clientId,
    userId: subject.userId,
    resource: subject.resource,
    scope: subject.scope,
    createdAt: now,
  }
  db.insert(accessTokens)
    .values({
      ...values,
      tokenHash: hashToken(accessToken),
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    })
    .run()
  db.insert(refreshTokens)
    .values({
      ...values,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    })
    .run()
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: subject.scope }
}

/**
 * Consumes a refresh token held by `clientId`. Rotation, not reuse: the
 * presented token is spent and `issueTokens` mints its replacement.
 *
 * The client is part of the delete rather than checked afterwards. Deleting
 * first and comparing after would let anyone holding a token they cannot use
 * destroy it anyway — register a client of their own, present the token, and
 * the grant is gone before the mismatch is noticed. Nothing is bought by it
 * either: unlike an authorization code, where burning on failure is what stops
 * a PKCE verifier being guessed, a refresh token has no second secret to guess.
 *
 * What rotation does and does not buy, stated plainly because it is easy to
 * over-credit: whichever holder refreshes first keeps the grant and the other
 * is locked out, so a leak is bounded only if the real client refreshes before
 * the thief does. Detecting the reuse and revoking the whole family is the
 * upgrade, and it is deliberately not here — see ADR-0005.
 */
export function redeemRefreshToken(
  db: Db,
  token: string,
  clientId: string,
  now = new Date(),
): GrantSubject | undefined {
  if (!token.startsWith(REFRESH_PREFIX)) return undefined
  const [row] = db
    .delete(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hashToken(token)), eq(refreshTokens.clientId, clientId)))
    .returning()
    .all()
  if (row === undefined) return undefined
  if (row.expiresAt.getTime() <= now.getTime()) return undefined
  return { clientId: row.clientId, userId: row.userId, resource: row.resource, scope: row.scope }
}

export interface AccessTokenPrincipal {
  clientId: string
  userId: number
  scope: string
  resource: string | null
  expiresAt: Date
}

/** The grant behind a presented access token, or undefined. */
export function resolveAccessToken(db: Db, token: string, now = new Date()): AccessTokenPrincipal | undefined {
  // Cheap reject before touching the database: the bearer header is
  // attacker-controlled, and an API key reaches this function too.
  if (!token.startsWith(ACCESS_PREFIX)) return undefined

  const [row] = db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, hashToken(token)))
    .limit(1)
    .all()
  if (row === undefined) return undefined
  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(accessTokens).where(eq(accessTokens.tokenHash, row.tokenHash)).run()
    return undefined
  }
  return {
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
    resource: row.resource,
    expiresAt: row.expiresAt,
  }
}

/**
 * RFC 7009. Either kind of token, held by `clientId`; one the client does not
 * hold is ignored rather than refused, as §2.2 requires, so revocation cannot
 * be used to probe which tokens exist.
 */
export function revokeToken(db: Db, token: string, clientId: string): void {
  const tokenHash = hashToken(token)
  if (token.startsWith(REFRESH_PREFIX)) {
    db.delete(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.clientId, clientId)))
      .run()
  } else if (token.startsWith(ACCESS_PREFIX)) {
    db.delete(accessTokens)
      .where(and(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.clientId, clientId)))
      .run()
  }
}

/**
 * PKCE S256 (RFC 7636 §4.6). `plain` is not accepted anywhere in this server —
 * OAuth 2.1 removed it, and a challenge equal to its verifier protects nothing
 * against the interception this exists to stop.
 */
export function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  if (codeVerifier.length < MIN_VERIFIER_LENGTH || codeVerifier.length > MAX_VERIFIER_LENGTH) return false
  const expected = Buffer.from(codeChallenge)
  const actual = Buffer.from(createHash('sha256').update(codeVerifier).digest('base64url'))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Grants are minted rarely and the expiry indexes make this cheap, so issuing
 * one is a natural place to keep dead rows from accumulating forever.
 */
export function deleteExpiredGrants(db: Db, now = new Date()): void {
  db.delete(authorizationCodes).where(lt(authorizationCodes.expiresAt, now)).run()
  db.delete(accessTokens).where(lt(accessTokens.expiresAt, now)).run()
  db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now)).run()
}
