import { Hono } from 'hono'
import { actorOf, currentUser, type AuthEnv } from './middleware.ts'
import { ConcurrencyGate, FailureThrottle, type ThrottleOptions } from './rate-limit.ts'
import type { SessionUser } from './session.ts'

/**
 * Failed attempts per key that cost nothing. Above this the next attempt waits,
 * doubling up to the ceiling — see FailureThrottle for why this slows callers
 * down instead of refusing them.
 */
export const LOGIN_FREE_ATTEMPTS = 5
export const LOGIN_BASE_DELAY_MS = 250
export const LOGIN_MAX_DELAY_MS = 2_000
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * Simultaneous password hashes. Node's default libuv threadpool is four, so
 * beyond that a request would queue anyway; this bounds the memory those hashes
 * reserve rather than letting a burst decide it.
 */
export const MAX_CONCURRENT_HASHES = 8

interface UserResponse {
  id: number
  email: string
  name: string | null
}

function toUserResponse(user: SessionUser): UserResponse {
  return { id: user.id, email: user.email, name: user.name }
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  windowMs: LOGIN_FAILURE_WINDOW_MS,
  freeAttempts: LOGIN_FREE_ATTEMPTS,
  baseDelayMs: LOGIN_BASE_DELAY_MS,
  maxDelayMs: LOGIN_MAX_DELAY_MS,
}

export interface AuthTuning {
  /** Overridden in tests, which would otherwise spend real seconds asleep. */
  throttle?: Partial<ThrottleOptions>
  maxConcurrentHashes?: number
}

/**
 * What every password check on this server shares: one attempt counter and one
 * hashing budget. Shared rather than per-route on purpose — the sign-in and
 * first-boot setup on the authorize dialog take the same password, so separate counters would let
 * an attacker alternate between them and pay half the delay for each guess.
 */
export interface AuthGuards {
  throttle: FailureThrottle
  hashGate: ConcurrencyGate
}

/** Built once per app instance, so a test gets a fresh budget and a restart forgives. */
export function createAuthGuards(tuning: AuthTuning = {}): AuthGuards {
  return {
    throttle: new FailureThrottle({ ...DEFAULT_THROTTLE, ...tuning.throttle }),
    hashGate: new ConcurrencyGate(tuning.maxConcurrentHashes ?? MAX_CONCURRENT_HASHES),
  }
}

export interface AuthRoutesDeps {
  /** What a client is told to sign in against. */
  signIn: { issuer: string; clientId: string; scope: string }
}

/**
 * What is left of auth on the API once the IdP owns sign-in (ADR-0006): where
 * to sign in, and who the token in hand belongs to. Setup, login and logout
 * are IdP dialogs and endpoints now — see oauth/routes.ts.
 */
export function createAuthRoutes(deps: AuthRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  // Public: a client asks this before it has any token at all.
  routes.get('/config', (c) => c.json(deps.signIn))

  routes.get('/session', (c) => c.json({ user: toUserResponse(currentUser(c)) }))

  // Any credential: whose it is and how the timeline will name it. The
  // cheapest way for a client — the MCP app among them — to check a token
  // before relying on it.
  routes.get('/principal', (c) => c.json({ user: toUserResponse(currentUser(c)), actor: actorOf(c) }))

  return routes
}
