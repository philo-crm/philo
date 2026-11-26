import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { ExternalIdpConfig } from '../config.ts'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { normalizeEmail } from './credentials.ts'
import { hashPassword } from './password.ts'
import type { SessionUser } from './session.ts'

/**
 * An OIDC provider that replaces the built-in IdP — ADR-0006. Philo becomes a
 * plain resource server: it never sees a password, and accepts the provider's
 * JWT access tokens, checked against the provider's published keys.
 */
export interface ExternalIdp extends ExternalIdpConfig {
  keys: JWTVerifyGetKey
  /**
   * The provider's userinfo endpoint, from the same discovery document as the
   * keys, or undefined when it names none. Asked only to bind a subject whose
   * access token carries no verified email.
   */
  userinfoEndpoint: () => Promise<string | undefined>
}

interface Discovery {
  keys: JWTVerifyGetKey
  userinfoEndpoint: string | undefined
}

/** An absolute URL, or nothing: a malformed endpoint is no endpoint. */
function endpointOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).href
  } catch {
    return undefined
  }
}

/**
 * Keys come from the provider's discovery document, fetched on first use
 * rather than at boot: an IdP that is briefly unreachable when Philo starts
 * should cost the requests made while it is down, not the whole process.
 */
export function createExternalIdp(config: ExternalIdpConfig): ExternalIdp {
  let discovered: Promise<Discovery> | undefined
  const discover = async (): Promise<Discovery> => {
    const res = await fetch(`${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OIDC discovery for ${config.issuer} answered ${res.status}`)
    const document = (await res.json()) as { jwks_uri?: unknown; userinfo_endpoint?: unknown }
    if (typeof document.jwks_uri !== 'string') throw new Error(`OIDC discovery for ${config.issuer} names no jwks_uri`)
    return {
      keys: createRemoteJWKSet(new URL(document.jwks_uri)),
      userinfoEndpoint: endpointOf(document.userinfo_endpoint),
    }
  }
  const discovery = (): Promise<Discovery> =>
    (discovered ??= discover().catch((error: unknown) => {
      // A failed discovery must be retried by the next request, not cached.
      discovered = undefined
      throw error
    }))
  return {
    ...config,
    keys: async (header, token) => (await discovery()).keys(header, token),
    userinfoEndpoint: async () => (await discovery()).userinfoEndpoint,
  }
}

/** The user an external token acts for, and the client that holds it. */
export interface ExternalPrincipal {
  user: SessionUser
  clientId: string
}

/** A compact JWS has three dot-separated parts; anything else is not ours to check. */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3
}

/** OIDC Core names the client `azp`; RFC 9068 access tokens call it `client_id`. */
function clientOf(claims: JWTPayload): string | undefined {
  const value = claims['azp'] ?? claims['client_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The principal behind an external access token, or undefined for a token
 * that does not verify. Network failures reaching the IdP propagate — a 401
 * would tell a client to discard a token that may be perfectly good.
 */
export async function verifyExternalToken(
  db: Db,
  idp: ExternalIdp,
  token: string,
): Promise<ExternalPrincipal | undefined> {
  if (!looksLikeJwt(token)) return undefined
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(token, idp.keys, {
      issuer: idp.issuer,
      ...(idp.audience === undefined ? {} : { audience: idp.audience }),
    }))
  } catch (error) {
    if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) return undefined
    throw error
  }

  // An id_token sent where an access token belongs proves identity, not
  // authorisation. Providers that mark the difference do so with `typ`; for
  // the rest, PHILO_OIDC_AUDIENCE is what keeps the two apart.
  if (claims['typ'] === 'ID') return undefined

  // Fail closed on the client. An IdP issues tokens to every application
  // registered with it, and a valid signature says only that one of them was
  // issued this — so a token that names no client, or a client nobody listed,
  // is refused rather than let in to act for anyone.
  const clientId = clientOf(claims)
  if (clientId === undefined) return undefined
  if (clientId !== idp.clientId && !idp.agentClientIds.includes(clientId)) return undefined

  // The PWA and a listed agent alike act for the user the token names —
  // ADR-0007 — so both are resolved the same way, by the bound subject.
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined
  const sub = claims.sub
  const user = await findOrProvisionUser(db, `${idp.issuer} ${sub}`, claims, () => fetchUserinfo(idp, token, sub))
  return user === undefined ? undefined : { user, clientId }
}

/** A slow provider costs one request this long, not a hung one. */
export const USERINFO_TIMEOUT_MS = 10_000
/** A profile is a few hundred bytes; anything this large is not one. */
export const MAX_USERINFO_BYTES = 16 * 1024

/**
 * The provider's profile of the token's subject, from its userinfo endpoint
 * (OIDC Core §5.3), or undefined for an answer that vouches for nothing. An
 * RFC 9068 access token often carries no profile claims at all; the email
 * that binds the account is then only here.
 *
 * Like key discovery, a provider that cannot be reached — or fails on its own
 * side — throws rather than refuses: a 401 would tell the client to discard a
 * token that may be perfectly good.
 */
async function fetchUserinfo(idp: ExternalIdp, token: string, sub: string): Promise<JWTPayload | undefined> {
  const endpoint = await idp.userinfoEndpoint()
  if (endpoint === undefined) return undefined
  const res = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    // A redirect would carry the token somewhere discovery never named.
    redirect: 'manual',
    signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
  })
  if (res.status >= 500) throw new Error(`OIDC userinfo for ${idp.issuer} answered ${res.status}`)
  if (res.status !== 200) {
    await res.body?.cancel()
    return undefined
  }
  const body = await readCapped(res, MAX_USERINFO_BYTES)
  if (body === undefined) return undefined
  let profile: unknown
  try {
    profile = JSON.parse(body)
  } catch {
    // Includes a signed (application/jwt) answer, which this does not read.
    return undefined
  }
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  // §5.3.2: the answer must be about the subject the token names, or it
  // could be a profile substituted for someone else's.
  const claims = profile as JWTPayload
  return claims.sub === sub ? claims : undefined
}

/** The body as text, or undefined once it passes `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel()
    return undefined
  }
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const USER_COLUMNS = { id: users.id, email: users.email, name: users.name }

/** Positive proof only: a provider that says nothing about the address has not vouched for it. */
function verifiedEmail(claims: JWTPayload): string | undefined {
  if (claims['email_verified'] !== true) return undefined
  return normalizeEmail(claims['email'])
}

/**
 * The user an external token names. Bound to the IdP's stable subject —
 * an email address can be changed at the IdP, `iss`+`sub` cannot — and the
 * email is consulted only to make that binding, never to match afterwards:
 *
 * - **Known subject:** that account.
 * - **No account yet:** the first token with a verified email creates one.
 *   This is the external equivalent of first-boot setup, bounded the same
 *   way: only someone the operator's IdP issues a token to, for one of the
 *   clients configured here, gets here.
 * - **An account never bound** (an instance that used the built-in IdP until
 *   now): a verified email matching it binds it, once.
 *
 * The verified email is the token's own when it carries one, and otherwise
 * the one the provider's userinfo vouches for.
 *
 * Anything else — a second person, an address already bound to another
 * subject — is refused. Userinfo is asked only on the unbound path, so it
 * costs one request per account, once.
 */
async function findOrProvisionUser(
  db: Db,
  subject: string,
  claims: JWTPayload,
  userinfo: () => Promise<JWTPayload | undefined>,
): Promise<SessionUser | undefined> {
  const [bound] = db.select(USER_COLUMNS).from(users).where(eq(users.externalSubject, subject)).all()
  if (bound !== undefined) return bound

  // Nothing left to bind: refuse before asking the provider anything, so a
  // second person's every request is not also a userinfo call.
  const empty = db.select({ id: users.id }).from(users).limit(1).all().length === 0
  if (!empty && db.select({ id: users.id }).from(users).where(isNull(users.externalSubject)).limit(1).all().length === 0) {
    return undefined
  }

  // The token's own email wins when it vouches for one; the name travels
  // with whichever claims supplied the email.
  const profile = verifiedEmail(claims) === undefined ? await userinfo() : claims
  if (profile === undefined) return undefined
  const email = verifiedEmail(profile)
  if (email === undefined) return undefined

  if (!empty) {
    const [unbound] = db
      .update(users)
      .set({ externalSubject: subject })
      .where(and(eq(users.email, email), isNull(users.externalSubject)))
      .returning(USER_COLUMNS)
      .all()
    return unbound
  }

  // A password nobody knows: the built-in sign-in is switched off in this mode,
  // and if it is ever switched back on the operator resets rather than inherits.
  const passwordHash = await hashPassword(`external-idp:${randomUUID()}`)
  const rawName = profile['name']
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim().slice(0, 200) : null
  return db.transaction((tx) => {
    // Lost a race with another first token: whoever won is the operator.
    if (tx.select({ id: users.id }).from(users).limit(1).all().length > 0) return undefined
    const [created] = tx
      .insert(users)
      .values({ email, passwordHash, name, externalSubject: subject })
      .returning(USER_COLUMNS)
      .all()
    return created
  })
}
