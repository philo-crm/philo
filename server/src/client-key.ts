import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/** What a rate limiter falls back to when the request has no address at all. */
export const UNKNOWN_ADDRESS = 'unknown'

/**
 * Rate-limit key for the caller.
 *
 * The socket's peer address is the honest answer, and behind a reverse proxy it
 * is also a useless one: every request arrives from the proxy, so every caller
 * shares one bucket and one attacker can spend the whole deployment's budget.
 * `PHILO_TRUSTED_PROXY` is how an operator says a proxy is there.
 *
 * See `resolveClientAddress` for the rule, which is the security-relevant part.
 */
export function clientKey(c: Context, trustProxy = false): string {
  return resolveClientAddress(peerAddress(c), c.req.header('x-forwarded-for'), trustProxy)
}

/**
 * The caller's address, given what the socket says and what the proxy claims.
 *
 * `X-Forwarded-For` is only trustworthy from the right, and only as far as the
 * proxies that wrote it: each hop appends the address it saw, so the entries a
 * proxy added are the trailing ones and everything to their left is whatever the
 * client sent — an attacker sets that to a fresh value per request to get a fresh
 * bucket every time. So this walks right to left, skipping private addresses
 * (which is what walking back through a chain of proxies looks like) and stopping
 * at the first public one. Injected entries sit left of what the proxy appended,
 * so the walk never reaches them.
 *
 * A count of trusted hops is the other common design, and it is worse: an
 * operator who miscounts by one — is the CDN a hop? the load balancer? — hands an
 * attacker the ability to pad the header until the entry the count selects is one
 * they wrote. There is no equivalent mistake to make here.
 *
 * Two deliberate failure directions, both over-restrictive rather than under:
 *
 * - **The peer must itself be private.** A proxy reaches Philo over loopback, a
 *   Docker bridge, or a private network in every deployment DESIGN.md describes.
 *   Requiring that is what stops a published port from becoming a bypass: an
 *   attacker who reaches the app directly has a public peer address, so the
 *   header is ignored and their own address is what gets throttled.
 * - **A public proxy collapses to itself.** With a CDN in front whose egress
 *   addresses are public, the walk stops at the CDN rather than the visitor, so
 *   everything arriving through it shares one bucket. Restrictive, never
 *   permissive, and it needs no list of addresses to keep current.
 */
export function resolveClientAddress(
  peer: string,
  forwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  // Normalized here rather than at the call site, so this function is the whole
  // rule and a caller cannot get the trust decision wrong by handing it a
  // dual-stack socket's `::ffff:` form or an address with a port on it.
  const normalizedPeer = normalizeAddress(peer)
  if (!trustProxy || !isPrivateAddress(normalizedPeer)) return normalizedPeer
  if (forwardedFor === undefined) return normalizedPeer

  const entries = forwardedFor
    .split(',')
    .map((entry) => normalizeAddress(entry))
    .filter((entry) => entry.length > 0)

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry !== undefined && !isPrivateAddress(entry)) return entry
  }
  // Every entry was private, so there is no caller in here to find — an internal
  // request, or a chain that only ever saw private addresses.
  return normalizedPeer
}

/**
 * Strips what varies between connections and normalizes what does not. Azure
 * Application Gateway and IIS append `:port`, which changes per connection —
 * keeping it would hand every request its own bucket and quietly switch every
 * rate limit off.
 */
function normalizeAddress(raw: string): string {
  const address = raw.trim().toLowerCase()
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(address)
  if (bracketed?.[1] !== undefined) return unwrapMappedIpv4(bracketed[1])
  // Exactly one colon is `host:port`; more than one is a bare IPv6 address.
  const colon = address.indexOf(':')
  if (colon !== -1 && address.indexOf(':', colon + 1) === -1) return unwrapMappedIpv4(address.slice(0, colon))
  return unwrapMappedIpv4(address)
}

/** Node reports an IPv4 peer as `::ffff:127.0.0.1` on a dual-stack socket. */
function unwrapMappedIpv4(address: string): string {
  return /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1] ?? address
}

/**
 * Whether an address is one a proxy would reach Philo from rather than one a
 * visitor arrives with. Only the ranges that matter for that question — this is
 * not a general-purpose address classifier, and `unknown` is not private, so a
 * request with no socket behind it never unlocks the header.
 */
function isPrivateAddress(address: string): boolean {
  const octets = parseIpv4(address)
  if (octets !== undefined) {
    const [a, b] = octets
    if (a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    // Link-local: what a host uses when it never got an address.
    return a === 169 && b === 254
  }
  if (address === '::1') return true
  const group = firstIpv6Group(address)
  if (group === undefined) return false
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return (group >= 0xfc00 && group <= 0xfdff) || (group >= 0xfe80 && group <= 0xfebf)
}

function parseIpv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets as [number, number, number, number]
}

/**
 * The leading 16-bit group, which is all the prefixes above need. A leading `::`
 * means those bits are zero, so no general IPv6 parser is required.
 */
function firstIpv6Group(address: string): number | undefined {
  if (!address.includes(':')) return undefined
  if (address.startsWith('::')) return 0
  const [head] = address.split(':')
  if (head === undefined || !/^[0-9a-f]{1,4}$/.test(head)) return undefined
  return Number.parseInt(head, 16)
}

function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_ADDRESS
  } catch {
    // No socket behind the request — `app.request()` in tests, for one.
    return UNKNOWN_ADDRESS
  }
}
