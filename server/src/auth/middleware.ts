import type { Context, MiddlewareHandler } from 'hono'
import type { CookieOptions } from 'hono/utils/cookie'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Db } from '../db/index.ts'
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

/** Deny-by-default guard for the machine-facing API. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('user') === undefined) return c.json({ error: 'unauthorized' }, 401)
  return next()
}

/**
 * The authenticated user, for handlers behind `requireAuth`. Throws rather than
 * returning undefined so a route that forgets the guard fails loudly in tests
 * instead of quietly serving an anonymous request.
 */
export function currentUser(c: Context<AuthEnv>): SessionUser {
  const user = c.get('user')
  if (user === undefined) throw new Error('currentUser() requires requireAuth() on the route')
  return user
}
