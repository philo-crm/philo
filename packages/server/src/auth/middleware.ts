import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { FIRST_PARTY_CLIENT_ID } from '../oauth/first-party.ts'
import { resolveAccessToken } from '../oauth/tokens.ts'
import { resolveApiKey } from './api-keys.ts'
import { verifyExternalToken, type ExternalIdp } from './external-idp.ts'
import type { SessionUser } from './session.ts'

export interface AuthDeps {
  db: Db
  /**
   * Reverse proxies in front of this process, from the config of the same name.
   * Only the throttles read it — a caller behind a proxy would otherwise share
   * one bucket with everyone else, including an attacker.
   */
  trustProxy: boolean
  /** Set when an external IdP issues the tokens — ADR-0006. */
  externalIdp?: ExternalIdp | undefined
}

/**
 * Who is calling, decided once per request from the bearer token. ADR-0007:
 * every credential acts as a user with exactly that user's authority — the
 * PWA's token, an API key, or a connector's grant alike. `actor` is how the
 * timeline names the credential, so what an agent did on its user's behalf
 * stays distinguishable from what the user did.
 */
export interface Principal {
  user: SessionUser
  actor: `user:${number}` | `api_key:${number}` | `oauth:${string}`
}

export interface AuthEnv {
  Variables: {
    principal: Principal | undefined
  }
}

/** The credential from an `Authorization` header, if it is a bearer one. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  // The scheme is case-insensitive per RFC 7235; the credential is not.
  const match = /^bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
}

function userById(db: Db, id: number): SessionUser | undefined {
  const [user] = db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, id)).all()
  return user
}

/**
 * The principal behind a bearer token, or undefined.
 *
 * An API key is tried first because it is the credential most agents carry.
 * Every Philo-issued credential starts `philo_`, and each resolver rejects the
 * others' prefixes before touching the database. A token that is none of them
 * is offered to the external IdP, when there is one.
 */
export async function resolvePrincipal(deps: AuthDeps, token: string): Promise<Principal | undefined> {
  const key = resolveApiKey(deps.db, token)
  if (key !== undefined) return withUser(deps.db, key.userId, `api_key:${key.id}`)

  const grant = resolveAccessToken(deps.db, token)
  if (grant !== undefined) {
    // The PWA's grant is the person themself; any other client acts for them.
    const actor = grant.clientId === FIRST_PARTY_CLIENT_ID ? (`user:${grant.userId}` as const) : (`oauth:${grant.clientId}` as const)
    return withUser(deps.db, grant.userId, actor)
  }

  if (deps.externalIdp === undefined) return undefined
  const external = await verifyExternalToken(deps.db, deps.externalIdp, token)
  if (external === undefined) return undefined
  return {
    user: external.user,
    actor: external.clientId === deps.externalIdp.clientId ? `user:${external.user.id}` : `oauth:${external.clientId}`,
  }
}

function withUser(db: Db, userId: number, actor: Principal['actor']): Principal | undefined {
  const user = userById(db, userId)
  return user === undefined ? undefined : { user, actor }
}

/**
 * Resolves the bearer token onto the request without rejecting anything:
 * `requireAuth` is the one place a request is refused, so public routes can sit
 * behind this too.
 *
 * There is no cookie, deliberately. With nothing the browser attaches on its
 * own, a cross-site request arrives unauthenticated, which is what lets the API
 * drop its CSRF layers and answer any origin — ADR-0006.
 */
export function bearerMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    c.set('principal', token === undefined ? undefined : await resolvePrincipal(deps, token))
    return next()
  }
}

/** RFC 6750 §3. `error` only when a credential was presented and refused. */
function unauthorized(c: Context) {
  const presented = c.req.header('authorization') !== undefined
  c.header('WWW-Authenticate', presented ? 'Bearer realm="philo", error="invalid_token"' : 'Bearer realm="philo"')
  return c.json({ error: 'unauthorized' }, 401)
}

/** Deny-by-default guard for the API. Any credential acting for a user passes. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('principal') === undefined) return unauthorized(c)
  return next()
}

/**
 * The user the credential acts for. Throws rather than returning undefined so
 * a route that forgets the guard fails loudly in tests instead of quietly
 * serving an anonymous request.
 */
export function currentUser(c: Context<AuthEnv>): SessionUser {
  const principal = c.get('principal')
  if (principal === undefined) throw new Error('currentUser() requires requireAuth() on the route')
  return principal.user
}

/**
 * Who the timeline records. One identity per credential — DESIGN.md (Auth and
 * access) — so a lead moved by an agent is distinguishable from one moved by a
 * person afterwards.
 */
export function actorOf(c: Context<AuthEnv>): string {
  const principal = c.get('principal')
  if (principal === undefined) throw new Error('actorOf() requires requireAuth() on the route')
  return principal.actor
}
