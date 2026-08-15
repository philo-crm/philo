import type { Context, MiddlewareHandler } from 'hono'
import type { CookieOptions } from 'hono/utils/cookie'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Db } from '../db/index.ts'
import { resolveApiKey, type ApiKeyPrincipal } from './api-keys.ts'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, resolveSession, type SessionUser } from './session.ts'

export interface AuthDeps {
  db: Db
  /** HMAC key from the data dir — see session-key.ts. */
  sessionKey: string
  /**
   * Whether to mark the cookie `Secure`. Derived from the public base URL: on a
   * plain-http deployment (or localhost dev) a `Secure` cookie is never sent
   * back, which would present as "login silently does nothing".
   */
  cookieSecure: boolean
  /**
   * Reverse proxies in front of this process, from the config of the same name.
   * Only the login and setup throttles read it — a caller behind a proxy would
   * otherwise share one bucket with everyone else, including an attacker.
   */
  trustProxy: boolean
}

export interface AuthEnv {
  Variables: {
    /** Set by `sessionMiddleware` when the request carries a live session. */
    user: SessionUser | undefined
    /** Set by `apiKeyMiddleware` when the request carries a live `philo_` key. */
    apiKey: ApiKeyPrincipal | undefined
  }
}

function cookieOptions(deps: AuthDeps): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: deps.cookieSecure,
    // Lax, not Strict: DESIGN.md (Email) puts lead links in notification emails,
    // and under Strict a click from an email client arrives logged out. Lax still
    // withholds the cookie from cross-site POSTs, which is the CSRF-relevant half.
    sameSite: 'Lax',
  }
}

export async function writeSessionCookie(c: Context, deps: AuthDeps, token: string): Promise<void> {
  await setSignedCookie(c, SESSION_COOKIE_NAME, token, deps.sessionKey, {
    ...cookieOptions(deps),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(c: Context, deps: AuthDeps): void {
  deleteCookie(c, SESSION_COOKIE_NAME, cookieOptions(deps))
}

/**
 * Reads the signed cookie. `getSignedCookie` yields `false` for a present cookie
 * whose signature does not verify, which is a forgery attempt rather than an
 * absent session — both end up as "no token" here, but only after the signature
 * has been checked.
 */
export async function readSessionCookie(c: Context, sessionKey: string): Promise<string | undefined> {
  const token = await getSignedCookie(c, sessionKey, SESSION_COOKIE_NAME)
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/**
 * Resolves the session cookie onto the request without rejecting anything. Public
 * routes need it too — the setup and login screens ask whether anyone is already
 * signed in.
 */
export function sessionMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // An explicit bearer key already said who the caller is. A cookie that
    // happened to ride along must not quietly upgrade the request to a user
    // identity the caller did not present — the actor on the timeline, and the
    // session-only routes, both turn on that distinction.
    if (c.get('apiKey') !== undefined) return next()

    const token = await readSessionCookie(c, deps.sessionKey)
    if (token === undefined) return next()

    const resolved = resolveSession(deps.db, token)
    if (resolved === undefined) {
      // Expired or revoked: drop the cookie so the browser stops sending it.
      clearSessionCookie(c, deps)
      return next()
    }

    c.set('user', resolved.user)
    // The row's expiry moved, so the cookie's must too, or the browser discards
    // it on day 30 while the session behind it is still good.
    if (resolved.renewed) await writeSessionCookie(c, deps, token)
    return next()
  }
}

/**
 * Resolves an `Authorization: Bearer philo_…` key onto the request. Like
 * `sessionMiddleware` it rejects nothing: a bad key falls through to the cookie
 * and then to `requireAuth`, which is the one place a request is refused.
 */
export function apiKeyMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === undefined) return next()

    const key = resolveApiKey(deps.db, token)
    if (key !== undefined) c.set('apiKey', key)
    return next()
  }
}

/** The credential from an `Authorization` header, if it is a bearer one. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  // The scheme is case-insensitive per RFC 7235; the credential is not.
  const match = /^bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
}

/** Deny-by-default guard for the machine-facing API. Either credential passes. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('user') === undefined && c.get('apiKey') === undefined) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
}

/**
 * The narrower guard, for what a `philo_` key deliberately does not reach:
 *
 * - **Minting and revoking keys.** A key that could mint another would outlive
 *   its own revocation.
 * - **Push subscriptions.** They belong to a browser and to the person signed
 *   into it; a key has neither.
 * - **Mail server settings and the test-send.** Instance credentials, plus a
 *   bare send-to-this-address primitive. Email *templates* stay open on purpose
 *   — DESIGN.md (MCP surface) wants an agent designing the emails — so this is
 *   not a boundary against a key composing outbound mail, and nothing here
 *   should be read as one. It keeps the SMTP credentials out of a key's reach.
 * - **The session itself.** There is no user behind a key to describe.
 *
 * 403 rather than 401: the credential is good, the route is not for it, and
 * answering 401 would send a client off to re-authenticate forever.
 */
export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('user') !== undefined) return next()
  if (c.get('apiKey') !== undefined) return c.json({ error: 'session_required' }, 403)
  return c.json({ error: 'unauthorized' }, 401)
}

/**
 * The authenticated user, for handlers behind `requireUser`. Throws rather than
 * returning undefined so a route that forgets the guard fails loudly in tests
 * instead of quietly serving an anonymous request — or, now, an API key request
 * that has no user behind it at all.
 */
export function currentUser(c: Context<AuthEnv>): SessionUser {
  const user = c.get('user')
  if (user === undefined) throw new Error('currentUser() requires requireUser() on the route')
  return user
}

/**
 * Who the timeline records. One identity per credential — DESIGN.md (Auth and
 * access) — so a lead moved by an agent is distinguishable from one moved by a
 * person afterwards.
 */
export function actorOf(c: Context<AuthEnv>): string {
  const user = c.get('user')
  if (user !== undefined) return `user:${user.id}`
  const key = c.get('apiKey')
  if (key !== undefined) return `api_key:${key.id}`
  throw new Error('actorOf() requires requireAuth() on the route')
}
