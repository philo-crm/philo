import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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

  const clientId = clientOf(claims) ?? 'external'
  if (clientId !== idp.clientId) return { kind: 'agent', clientId }

  // An id_token sent where an access token belongs proves identity, not
  // authorisation. Providers that mark the difference do so with `typ`; for
  // the rest, PHILO_OIDC_AUDIENCE is what keeps the two apart.
  if (claims['typ'] === 'ID') return undefined
  if (claims['email_verified'] === false) return undefined
  const email = normalizeEmail(claims['email'])
  if (email === undefined) return undefined
  const user = await findOrProvisionOperator(db, email, claims['name'])
  return user === undefined ? undefined : { kind: 'operator', user }
}

/**
 * The account an operator token names, by email. On an instance with no
 * account yet, the first valid operator token creates one — the external
 * equivalent of first-boot setup, and bounded the same way: only someone the
 * operator's IdP issues a token to, for the operator's own client, gets here.
 */
async function findOrProvisionOperator(db: Db, email: string, rawName: unknown): Promise<SessionUser | undefined> {
  const byEmail = () =>
    db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.email, email)).all()
  const [existing] = byEmail()
  if (existing !== undefined) return existing
  if (db.select({ id: users.id }).from(users).limit(1).all().length > 0) return undefined

  // A password nobody knows: the built-in sign-in is switched off in this mode,
  // and if it is ever switched back on the operator resets rather than inherits.
  const passwordHash = await hashPassword(`external-idp:${randomUUID()}`)
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim().slice(0, 200) : null
  return db.transaction((tx) => {
    if (tx.select({ id: users.id }).from(users).limit(1).all().length > 0) return byEmail()[0]
    const [created] = tx
      .insert(users)
      .values({ email, passwordHash, name })
      .returning({ id: users.id, email: users.email, name: users.name })
      .all()
    return created
  })
}
