import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/**
 * Rate-limit key for the caller. Behind a reverse proxy every request arrives
 * from the proxy, so this collapses to one bucket for the whole deployment;
 * per-IP fidelity there needs a trusted-proxy setting Philo does not model yet.
 * Every caller of this has to stay honest about what happens when it does
 * collapse — see FailureThrottle (auth) and TokenBucket (intake).
 */
export function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // No socket behind the request — `app.request()` in tests, for one.
    return 'unknown'
  }
}
