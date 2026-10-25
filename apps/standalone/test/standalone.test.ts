import { createMcpApp } from '@philo/mcp'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupTestApps,
  createTestApp,
  setupAdmin,
  TEST_PUBLIC_BASE_URL,
} from '../../../packages/server/test/support/app.ts'
import { createStandaloneApp } from '../src/app.ts'

const webDirs: string[] = []

afterEach(() => {
  cleanupTestApps()
  for (const dir of webDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A minimal stand-in for the Vite build. `withPwaFiles: false` models a build
 * that never emitted them.
 */
function createWebDir({ withPwaFiles = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-web-'))
  webDirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Philo</title>')
  writeFileSync(join(dir, 'app.js'), 'console.log("philo")')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("hashed")')
  if (withPwaFiles) {
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("push", () => {})')
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Philo","short_name":"Philo"}')
  }
  return dir
}

function standalone(options: { withPwaFiles?: boolean } = {}) {
  const server = createTestApp()
  const mcp = createMcpApp({
    apiBaseUrl: TEST_PUBLIC_BASE_URL,
    publicUrl: `${TEST_PUBLIC_BASE_URL}/mcp`,
    fetch: (input, init) => server.app.request(input, init),
  })
  return { server, app: createStandaloneApp({ server: server.app, mcp, webDir: createWebDir(options) }) }
}

describe('routing', () => {
  it('sends the API to the server', async () => {
    const { server, app } = standalone()
    const authorization = await setupAdmin(server)
    const res = await app.request('/api/v1/stages', { headers: { authorization } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers an unknown API path in JSON, never with the app shell', async () => {
    const { app } = standalone()
    // /api/v1 is guarded before it is routed, so a stranger gets 401 there.
    for (const [path, status] of [['/api/v1/nope', 401], ['/api/intake', 404], ['/oauth/nope', 404], ['/.well-known/nonsense', 404]] as const) {
      const res = await app.request(path)
      expect(res.status, path).toBe(status)
      expect(res.headers.get('content-type'), path).toContain('application/json')
    }
  })

  it('sends MCP to the MCP app, which points a client at discovery', async () => {
    const { app } = standalone()
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${TEST_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    )

    const metadata = await app.request('/.well-known/oauth-protected-resource/mcp')
    expect(await metadata.json()).toMatchObject({ authorization_servers: [TEST_PUBLIC_BASE_URL] })
  })

  it('keeps the server’s own protected-resource metadata at the bare path', async () => {
    const { app } = standalone()
    const res = await app.request('/.well-known/oauth-protected-resource')
    expect(await res.json()).toMatchObject({ resource: TEST_PUBLIC_BASE_URL })
  })

  it('leaves the IdP dialog uncached, as the server marked it', async () => {
    const { app } = standalone()
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'philo-web',
      redirect_uri: `${TEST_PUBLIC_BASE_URL}/auth/callback`,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    const res = await app.request(`/oauth/authorize?${params}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('static PWA', () => {
  it('serves index.html at the root', async () => {
    const res = await standalone().app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    await expect(res.text()).resolves.toContain('Philo')
  })

  it('serves built assets', async () => {
    const res = await standalone().app.request('/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it.each(['/leads/42', '/auth/callback'])('falls back to index.html for the client-side route %s', async (path) => {
    const res = await standalone().app.request(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('serves the service worker as a script and the manifest as a manifest', async () => {
    const { app } = standalone()
    expect((await app.request('/sw.js')).headers.get('content-type')).toContain('javascript')
    expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toContain(
      'application/manifest+json',
    )
  })

  it.each(['/sw.js', '/manifest.webmanifest', '/icon-512.png', '/favicon.svg'])(
    '404s %s when the build did not emit it, instead of answering with the shell',
    async (path) => {
      // HTML where a script, a manifest or an icon was asked for fails inside
      // the browser, where nothing reports it.
      const res = await standalone({ withPwaFiles: false }).app.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).not.toContain('text/html')
    },
  )
})

describe('caching', () => {
  it.each(['/', '/leads/42'])('never caches the app shell at %s', async (path) => {
    const res = await standalone().app.request(path)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('caches content-hashed assets forever', async () => {
    const res = await standalone().app.request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('caches a ranged read of a hashed asset too', async () => {
    const res = await standalone().app.request('/assets/index-abc123.js', { headers: { range: 'bytes=0-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('never caches a missing asset as if it were the asset', async () => {
    // A 404 here is a deploy still in flight; cached for a year it would
    // outlive the deploy that fixes it.
    const res = await standalone().app.request('/assets/not-built-yet-abc123.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('does not mark unhashed root files immutable', async () => {
    const res = await standalone().app.request('/app.js')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  // A cached service worker is a deploy that never lands.
  it.each(['/sw.js', '/manifest.webmanifest'])('makes %s revalidate', async (path) => {
    const res = await standalone().app.request(path)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })
})
