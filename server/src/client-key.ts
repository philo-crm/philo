import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/** What a rate limiter falls back to when the request has no address at all. */
const UNKNOWN = 'unknown'

/**
 * Rate-limit key for the caller.
 *
 * The socket's peer address is the honest answer, and behind a reverse proxy it
 * is also a useless one: every request arrives from the proxy, so every caller
 * shares one bucket and one attacker can spend the whole deployment's budget.
 * `PHILO_TRUSTED_PROXY_HOPS` is how an operator says otherwise.
 *
 * `X-Forwarded-For` is only trustworthy from the right, and only as far as the
 * proxies that wrote it. Each hop appends the address it saw, so with N trusted
 * proxies the caller is N entries from the end and everything left of that is
 * whatever the client sent — which an attacker sets to anything they like, one
 * fresh value per request, to get a fresh bucket every time. Hence a hop count
 * rather than a boolean: the count is what says where the trustworthy part
 * starts. Zero, the default, trusts nothing and reads no header at all.
 *
 * If the header is shorter than the configured hop count the deployment does not
 * match the configuration, and the safe reading is the peer address — never the
 * leftmost entry, which is the one part an attacker controls.
 */
export function clientKey(c: Context, trustedProxyHops = 0): string {
  const peer = peerAddress(c)
  if (trustedProxyHops === 0) return peer

  const forwarded = c.req
    .header('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (forwarded === undefined || forwarded.length < trustedProxyHops) return peer

  return forwarded[forwarded.length - trustedProxyHops] ?? peer
}

function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN
  } catch {
    // No socket behind the request — `app.request()` in tests, for one.
    return UNKNOWN
  }
}
