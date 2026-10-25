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
}

/**
 * Keys come from the provider's discovery document, fetched on first use
 * rather than at boot: an IdP that is briefly unreachable when Philo starts
 * should cost the requests made while it is down, not the whole process.
 */
export function createExternalIdp(config: ExternalIdpConfig): ExternalIdp {
  let keySet: Promise<JWTVerifyGetKey> | undefined
  const discover = async (): Promise<JWTVerifyGetKey> => {
    const res = await fetch(`${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OIDC discovery for ${config.issuer} answered ${res.status}`)
    const { jwks_uri: jwksUri } = (await res.json()) as { jwks_uri?: unknown }
    if (typeof jwksUri !== 'string') throw new Error(`OIDC discovery for ${config.issuer} names no jwks_uri`)
    return createRemoteJWKSet(new URL(jwksUri))
  }
  return {
    ...config,
    keys: async (header, token) => {
      keySet ??= discover().catch((error: unknown) => {
        // A failed discovery must be retried by the next request, not cached.
        keySet = undefined
        throw error
      })
      return (await keySet)(header, token)
    },
  }
}

export type ExternalPrincipal =
  | { kind: 'operator'; user: SessionUser }
  | { kind: 'agent'; clientId: string }

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
  // is refused rather than let in at the lowest level of authority.
  const clientId = clientOf(claims)
  if (clientId === undefined) return undefined
  if (clientId !== idp.clientId) {
    return idp.agentClientIds.includes(clientId) ? { kind: 'agent', clientId } : undefined
  }

  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined
  const user = await findOrProvisionOperator(db, `${idp.issuer} ${claims.sub}`, claims)
  return user === undefined ? undefined : { kind: 'operator', user }
}

const USER_COLUMNS = { id: users.id, email: users.email, name: users.name }

/** Positive proof only: a provider that says nothing about the address has not vouched for it. */
function verifiedEmail(claims: JWTPayload): string | undefined {
  if (claims['email_verified'] !== true) return undefined
  return normalizeEmail(claims['email'])
}

/**
 * The operator an external token names. Bound to the IdP's stable subject —
 * an email address can be changed at the IdP, `iss`+`sub` cannot — and the
 * email is consulted only to make that binding, never to match afterwards:
 *
 * - **Known subject:** that account.
 * - **No account yet:** the first operator token with a verified email creates
 *   one — the external equivalent of first-boot setup, bounded the same way:
 *   only someone the operator's IdP issues a token to, for the operator's own
 *   client, gets here.
 * - **An account never bound** (an instance that used the built-in IdP until
 *   now): a verified email matching it binds it, once.
 *
 * Anything else — a second person, an address already bound to another
 * subject — is refused.
 */
async function findOrProvisionOperator(
  db: Db,
  subject: string,
  claims: JWTPayload,
): Promise<SessionUser | undefined> {
  const [bound] = db.select(USER_COLUMNS).from(users).where(eq(users.externalSubject, subject)).all()
  if (bound !== undefined) return bound

  const email = verifiedEmail(claims)
  if (email === undefined) return undefined

  if (db.select({ id: users.id }).from(users).limit(1).all().length > 0) {
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
  const rawName = claims['name']
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
