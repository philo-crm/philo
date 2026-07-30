import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { clientKey } from '../src/client-key.ts'

/**
 * `app.request()` has no socket behind it, so the peer address resolves to
 * `unknown` — which makes it exactly the right stand-in for the proxy every
 * caller would otherwise share.
 */
const PEER = 'unknown'

async function keyFor(trustedProxyHops: number, forwardedFor?: string): Promise<string> {
  const app = new Hono()
  app.get('/', (c) => c.text(clientKey(c, trustedProxyHops)))
  const headers = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
  return (await app.request('/', { headers })).text()
}

describe('clientKey', () => {
  it('uses the peer address when no proxy is trusted', async () => {
    expect(await keyFor(0)).toBe(PEER)
  })

  it('ignores the forwarded header entirely when no proxy is trusted', async () => {
    expect(await keyFor(0, '203.0.113.7')).toBe(PEER)
  })

  it('reads the caller from one trusted hop', async () => {
    expect(await keyFor(1, '203.0.113.7')).toBe('203.0.113.7')
  })

  it('counts from the right, so a client-supplied prefix cannot win a fresh bucket', async () => {
    expect(await keyFor(1, '198.51.100.1, 203.0.113.7')).toBe('203.0.113.7')
    expect(await keyFor(1, 'anything-at-all, 203.0.113.7')).toBe('203.0.113.7')
  })

  it('skips the hops it is told to, and no more', async () => {
    expect(await keyFor(2, '198.51.100.1, 203.0.113.7, 10.0.0.1')).toBe('203.0.113.7')
  })

  it('tolerates the whitespace real proxies write', async () => {
    expect(await keyFor(1, '  203.0.113.7  ')).toBe('203.0.113.7')
  })

  it('ignores empty entries rather than keying on one', async () => {
    expect(await keyFor(1, '203.0.113.7, ,')).toBe('203.0.113.7')
  })

  // The deployment does not match the configuration. Falling back to the peer
  // address over-restricts; taking the leftmost entry would hand an attacker a
  // fresh bucket per request, which is the failure that matters.
  it('falls back to the peer address when the header is shorter than the hop count', async () => {
    expect(await keyFor(2, '203.0.113.7')).toBe(PEER)
  })

  it('falls back to the peer address when the header is absent', async () => {
    expect(await keyFor(1)).toBe(PEER)
  })
})
