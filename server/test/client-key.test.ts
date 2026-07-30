import { describe, expect, it } from 'vitest'
import { resolveClientAddress, UNKNOWN_ADDRESS } from '../src/client-key.ts'

/** A proxy on a Docker bridge network — the deployment DESIGN.md describes. */
const PROXY = '172.18.0.2'
const VISITOR = '203.0.113.7'

function trusting(peer: string, forwardedFor?: string): string {
  return resolveClientAddress(peer, forwardedFor, true)
}

describe('resolveClientAddress with no proxy trusted', () => {
  it('uses the peer address', () => {
    expect(resolveClientAddress(PROXY, undefined, false)).toBe(PROXY)
  })

  it('ignores the forwarded header entirely', () => {
    expect(resolveClientAddress(PROXY, VISITOR, false)).toBe(PROXY)
  })
})

describe('resolveClientAddress with a trusted proxy', () => {
  it('reads the caller the proxy appended', () => {
    expect(trusting(PROXY, VISITOR)).toBe(VISITOR)
  })

  it('works for a proxy on loopback', () => {
    expect(trusting('127.0.0.1', VISITOR)).toBe(VISITOR)
  })

  it('works for a proxy on an IPv6 unique-local or loopback address', () => {
    expect(trusting('::1', VISITOR)).toBe(VISITOR)
    expect(trusting('fd00::2', VISITOR)).toBe(VISITOR)
  })

  it('accepts an IPv6 visitor', () => {
    expect(trusting(PROXY, '2001:db8::1')).toBe('2001:db8::1')
  })

  it('tolerates the whitespace real proxies write', () => {
    expect(trusting(PROXY, `  ${VISITOR}  `)).toBe(VISITOR)
  })

  it('ignores empty entries rather than keying on one', () => {
    expect(trusting(PROXY, `${VISITOR}, ,`)).toBe(VISITOR)
  })
})

/**
 * The reason this walks from the right. Everything a client sends arrives left of
 * what the proxy appended, so none of it can name the caller — which is what stops
 * an attacker minting a fresh rate-limit bucket per request.
 */
describe('resolveClientAddress against a forged header', () => {
  it('ignores a forged public address', () => {
    expect(trusting(PROXY, `198.51.100.1, ${VISITOR}`)).toBe(VISITOR)
  })

  it('ignores a forged private address, which would otherwise look like a proxy', () => {
    expect(trusting(PROXY, `10.0.0.1, ${VISITOR}`)).toBe(VISITOR)
  })

  it('ignores a long forged chain, however it is padded', () => {
    const forged = ['a', '', '10.1.1.1', '192.168.5.5', '198.51.100.9', 'not-an-address'].join(',')
    expect(trusting(PROXY, `${forged}, ${VISITOR}`)).toBe(VISITOR)
  })

  it('ignores forged commas and whitespace', () => {
    expect(trusting(PROXY, `,,  , ${VISITOR}`)).toBe(VISITOR)
  })

  // Duplicate header lines reach us joined with ", " — the same string shape, so
  // the walk lands in the same place.
  it('ignores an earlier duplicate header line', () => {
    expect(trusting(PROXY, `evil, ${VISITOR}`)).toBe(VISITOR)
  })
})

describe('resolveClientAddress on a chain of proxies', () => {
  it('walks back through private hops to the visitor', () => {
    expect(trusting(PROXY, `${VISITOR}, 10.0.0.5, 172.18.0.3`)).toBe(VISITOR)
  })

  /**
   * A CDN's egress addresses are public, so the walk stops there and everything
   * arriving through it shares one bucket. Restrictive, never permissive — and it
   * needs no list of addresses to keep current.
   */
  it('stops at a public hop rather than trusting past it', () => {
    expect(trusting(PROXY, `${VISITOR}, 198.51.100.50`)).toBe('198.51.100.50')
  })
})

describe('resolveClientAddress normalization', () => {
  // Azure Application Gateway and IIS append a port that changes per connection.
  // Keeping it would give every request its own bucket and switch the limit off.
  it('drops a port from an IPv4 entry', () => {
    expect(trusting(PROXY, `${VISITOR}:54321`)).toBe(VISITOR)
  })

  it('drops a port from a bracketed IPv6 entry', () => {
    expect(trusting(PROXY, '[2001:db8::1]:443')).toBe('2001:db8::1')
  })

  it('unwraps a bracketed IPv6 entry with no port', () => {
    expect(trusting(PROXY, '[2001:db8::1]')).toBe('2001:db8::1')
  })

  it('keeps a bare IPv6 address whole', () => {
    expect(trusting(PROXY, '2001:db8::1:2:3')).toBe('2001:db8::1:2:3')
  })

  it('treats an IPv4-mapped peer as the IPv4 address it is', () => {
    expect(trusting('::ffff:127.0.0.1', VISITOR)).toBe(VISITOR)
  })

  it('lowercases, so one caller is one bucket', () => {
    expect(trusting(PROXY, '2001:DB8::1')).toBe('2001:db8::1')
  })
})

/**
 * The failure directions. Every one of these over-restricts — several callers
 * share a bucket — rather than letting a stranger pick their own key.
 */
describe('resolveClientAddress falls back to the peer', () => {
  it('when the peer is public, so the app port is directly reachable', () => {
    expect(trusting('198.51.100.99', VISITOR)).toBe('198.51.100.99')
  })

  it('when there is no socket to judge, so nothing vouches for the header', () => {
    expect(trusting(UNKNOWN_ADDRESS, VISITOR)).toBe(UNKNOWN_ADDRESS)
  })

  it('when the header is absent', () => {
    expect(trusting(PROXY)).toBe(PROXY)
  })

  it('when the header is empty or only separators', () => {
    expect(trusting(PROXY, '')).toBe(PROXY)
    expect(trusting(PROXY, ' , ,')).toBe(PROXY)
  })

  it('when every entry is private, so no caller is named in it', () => {
    expect(trusting(PROXY, '10.0.0.1, 192.168.1.1, 172.16.0.1')).toBe(PROXY)
  })

  it('when a private peer is link-local rather than routed', () => {
    expect(trusting('169.254.1.1', VISITOR)).toBe(VISITOR)
    expect(trusting('fe80::1', VISITOR)).toBe(VISITOR)
  })
})
