import type { Context, MiddlewareHandler } from 'hono'
import type { Db } from '../db/index.ts'
import { FIRST_PARTY_CLIENT_ID } from '../oauth/first-party.ts'
import { resolveAccessToken } from '../oauth/tokens.ts'
import { resolveApiKey } from './api-keys.ts'
import { verifyExternalToken, type ExternalIdp, type ExternalRefusal } from './external-idp.ts'
import { ROLES_ON_ACCOUNTS, userWithAccess, type AccessPolicy } from './access.ts'
import type { Role, SessionUser } from './session.ts'

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
  /** Where roles are decided — ADR-0012. Unset: on the account. */
  access?: AccessPolicy | undefined
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
  /**
   * What this credential may do — ADR-0012. Its user's role, read on every
   * request, so a change reaches every credential the account holds at once.
   */
  role: Role
  actor: `user:${number}` | `api_key:${number}` | `oauth:${string}`
}

export interface AuthEnv {
  Variables: {
    principal: Principal | undefined
    /** Why a token that verified was still refused, when it was — answered 403 by `requireAuth`. */
    refusal: ExternalRefusal['refused'] | undefined
  }
}

/** The credential from an `Authorization` header, if it is a bearer one. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  // The scheme is case-insensitive per RFC 7235; the credential is not.
  const match = /^bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
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
  const resolved = await resolveCredential(deps, token)
  return resolved === undefined || 'refused' in resolved ? undefined : resolved
}

/** As `resolvePrincipal`, keeping the reason an external token was refused with 403. */
async function resolveCredential(deps: AuthDeps, token: string): Promise<Principal | ExternalRefusal | undefined> {
  const key = resolveApiKey(deps.db, token)
  if (key !== undefined) return withUser(deps, key.userId, `api_key:${key.id}`)

  const grant = resolveAccessToken(deps.db, token)
  if (grant !== undefined) {
    // The PWA's grant is the person themself; any other client acts for them.
    const actor = grant.clientId === FIRST_PARTY_CLIENT_ID ? (`user:${grant.userId}` as const) : (`oauth:${grant.clientId}` as const)
    return withUser(deps, grant.userId, actor)
  }

  if (deps.externalIdp === undefined) return undefined
  const external = await verifyExternalToken(deps.db, deps.externalIdp, token)
  if (external === undefined || 'refused' in external) return external
  return {
    user: external.user,
    role: external.user.role,
    actor: external.clientId === deps.externalIdp.clientId ? `user:${external.user.id}` : `oauth:${external.clientId}`,
  }
}

function withUser(deps: AuthDeps, userId: number, actor: Principal['actor']): Principal | undefined {
  const user = userWithAccess(deps.db, userId, deps.access ?? ROLES_ON_ACCOUNTS)
  return user === undefined ? undefined : { user, role: user.role, actor }
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
    const resolved = token === undefined ? undefined : await resolveCredential(deps, token)
    if (resolved !== undefined && 'refused' in resolved) {
      c.set('principal', undefined)
      c.set('refusal', resolved.refused)
    } else {
      c.set('principal', resolved)
      c.set('refusal', undefined)
    }
    return next()
  }
}

/** RFC 6750 §3. `error` only when a credential was presented and refused. */
function unauthorized(c: Context) {
  const presented = c.req.header('authorization') !== undefined
  c.header('WWW-Authenticate', presented ? 'Bearer realm="philo", error="invalid_token"' : 'Bearer realm="philo"')
  return c.json({ error: 'unauthorized' }, 401)
}

/** RFC 6750 §3.1: the token is fine, it lacks `scope` — which a client can go and ask for. */
function insufficientScope(c: Context, scope: string): void {
  c.header('WWW-Authenticate', `Bearer realm="philo", error="insufficient_scope", scope="${scope}"`)
}

/**
 * Deny-by-default guard for the API. Any credential acting for a user passes.
 * An external token that verified but was refused — ADR-0012 — is a 403, not
 * a 401, which would only send its client round the same authorization again.
 */
export function createRequireAuth(externalIdp: ExternalIdp | undefined): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (c.get('principal') !== undefined) return next()
    const refusal = c.get('refusal')
    if (refusal === 'insufficient_scope' && externalIdp?.roles !== undefined) {
      insufficientScope(c, externalIdp.roles.userScope)
      return c.json({ error: 'insufficient_scope' }, 403)
    }
    if (refusal === 'account_disabled') return c.json({ error: 'account_disabled' }, 403)
    return unauthorized(c)
  }
}

/** `createRequireAuth` for the built-in IdP, where every refusal is a 401. */
export const requireAuth: MiddlewareHandler<AuthEnv> = createRequireAuth(undefined)

/**
 * Admin-only: configuration and people — ADR-0012. Behind `requireAuth`, so a
 * principal is always there; a user's credential is refused with 403, which
 * tells a client the token is fine and the person is not allowed. With the
 * role scopes set, the challenge names the admin scope, so an agent whose
 * token lacks it can ask for it.
 */
export function createRequireAdmin(externalIdp: ExternalIdp | undefined): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const principal = c.get('principal')
    if (principal === undefined) return unauthorized(c)
    if (principal.role === 'admin') return next()
    if (externalIdp?.roles !== undefined) insufficientScope(c, externalIdp.roles.adminScope)
    return c.json({ error: 'admin_required' }, 403)
  }
}

/** `createRequireAdmin` for the built-in IdP. */
export const requireAdmin: MiddlewareHandler<AuthEnv> = createRequireAdmin(undefined)

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
export function actorOf(c: Context<AuthEnv>): Principal['actor'] {
  const principal = c.get('principal')
  if (principal === undefined) throw new Error('actorOf() requires requireAuth() on the route')
  return principal.actor
}

/** What the credential may do — the principal's role, which an external token's scopes may cap below its user's. */
export function principalRole(c: Context<AuthEnv>): Role {
  const principal = c.get('principal')
  if (principal === undefined) throw new Error('principalRole() requires requireAuth() on the route')
  return principal.role
}
