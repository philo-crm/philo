import { createMcpApp } from '@philo/mcp'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupTestApps,
  createIntakeForm,
  createTestApp,
  defaultFormKey,
  setupAdmin,
  TEST_PUBLIC_BASE_URL,
} from '../../../packages/server/test/support/app.ts'
import { leads } from '../../../packages/server/src/db/schema.ts'
import { createStandaloneApp } from '../src/app.ts'
import { pwaContentSecurityPolicy } from '../src/csp.ts'

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

/** Every header, in a stable order, to show a response passed through untouched. */
function headersOf(res: Response): [string, string][] {
  return [...res.headers.entries()].toSorted(([a], [b]) => a.localeCompare(b))
}

describe('security headers', () => {
  const PWA_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy'] as const

  it('builds the default policy for the built-in IdP', () => {
    expect(pwaContentSecurityPolicy()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none'; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    )
  })

  it('lets the PWA reach an external issuer, by origin only', () => {
    const policy = pwaContentSecurityPolicy({ issuer: 'https://id.example.com/realms/philo/' })
    expect(policy).toContain("connect-src 'self' https://id.example.com;")
    expect(policy).not.toContain('/realms')
    // Only connect-src: the sign-in is a top-level navigation, which no directive here governs.
    expect(policy.match(/id\.example\.com/g)).toHaveLength(1)
  })

  it('adds the configured extra origins to connect-src, and nowhere else', () => {
    const policy = pwaContentSecurityPolicy({
      issuer: 'https://id.example.com',
      connectOrigins: ['https://token.example-apis.com', 'https://revoke.example.net'],
    })
    expect(policy).toContain(
      "connect-src 'self' https://id.example.com https://token.example-apis.com https://revoke.example.net;",
    )
    expect(policy.match(/example-apis\.com/g)).toHaveLength(1)
    expect(policy.match(/example\.net/g)).toHaveLength(1)
  })

  it('leaves the default policy unchanged with no extra origins', () => {
    expect(pwaContentSecurityPolicy({ connectOrigins: [] })).toBe(pwaContentSecurityPolicy())
  })

  it('names an origin only once', () => {
    const policy = pwaContentSecurityPolicy({ issuer: 'https://id.example.com/realms/x', connectOrigins: ['https://id.example.com'] })
    expect(policy).toContain("connect-src 'self' https://id.example.com;")
  })

  it.each(['/', '/leads/42', '/auth/callback', '/sw.js', '/manifest.webmanifest', '/app.js', '/assets/index-abc123.js'])(
    'sets the PWA headers on %s',
    async (path) => {
      const res = await standalone().app.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe(pwaContentSecurityPolicy())
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    },
  )

  it('sets them on a PWA 404 too', async () => {
    const res = await standalone().app.request('/assets/not-built-yet-abc123.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-security-policy')).toBe(pwaContentSecurityPolicy())
  })

  it('serves the policy it was given', async () => {
    const server = createTestApp()
    const mcp = createMcpApp({
      apiBaseUrl: TEST_PUBLIC_BASE_URL,
      publicUrl: `${TEST_PUBLIC_BASE_URL}/mcp`,
      fetch: (input, init) => server.app.request(input, init),
    })
    const policy = pwaContentSecurityPolicy({ issuer: 'https://id.example.com' })
    const app = createStandaloneApp({ server: server.app, mcp, webDir: createWebDir(), contentSecurityPolicy: policy })
    expect((await app.request('/')).headers.get('content-security-policy')).toBe(policy)
  })

  it.each([
    ['/api/v1/stages', 'GET'],
    ['/api/v1/nope', 'GET'],
    ['/oauth/nope', 'GET'],
    ['/.well-known/openid-configuration', 'GET'],
    ['/.well-known/oauth-protected-resource/mcp', 'GET'],
    ['/version', 'GET'],
    ['/llms.txt', 'GET'],
    ['/mcp', 'POST'],
  ])('leaves %s to the server’s own headers', async (path, method) => {
    const res = await standalone().app.request(path, { method })
    for (const header of PWA_HEADERS) expect(res.headers.get(header), `${path} ${header}`).toBeNull()
  })

  it('leaves the IdP dialog’s headers alone', async () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'philo-web',
      redirect_uri: `${TEST_PUBLIC_BASE_URL}/auth/callback`,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    const { server, app } = standalone()
    const direct = await server.app.request(`/oauth/authorize?${params}`)
    const res = await app.request(`/oauth/authorize?${params}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(direct.headers.get('content-security-policy'))
  })

  it('keeps the email preview frame’s own policy, which lets a template’s styles render', async () => {
    const { server, app } = standalone()
    const direct = await server.app.request('/api/email-preview')
    const res = await app.request('/api/email-preview')
    expect(res.status).toBe(200)
    const policy = res.headers.get('content-security-policy')
    expect(policy).toBe(direct.headers.get('content-security-policy'))
    expect(policy).toContain("style-src 'unsafe-inline'")
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('keeps the attachment download’s own sandbox policy', async () => {
    const { server, app } = standalone()
    const authorization = await setupAdmin(server)
    const intake = await app.request(`/api/intake/${defaultFormKey(server)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dana Rivers', email: 'dana@example.com' }),
    })
    expect(intake.status).toBe(201)
    const [lead] = server.db.select({ id: leads.id }).from(leads).all()
    const uploaded = await app.request(`/api/v1/leads/${lead!.id}/attachments?filename=cv.html`, {
      method: 'POST',
      headers: { 'content-type': 'text/html', authorization },
      body: '<script>alert(1)</script>',
    })
    const { lead: withFile } = (await uploaded.json()) as { lead: { attachments: { id: number }[] } }

    const res = await app.request(`/api/v1/leads/${lead!.id}/attachments/${withFile.attachments[0]!.id}`, {
      headers: { authorization },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(res.headers.get('referrer-policy')).toBeNull()
  })

  describe('intake, posted to cross-origin from public websites', () => {
    const SITE_ORIGIN = 'https://www.example.com'

    it('answers a preflight exactly as the server does', async () => {
      const { server, app } = standalone()
      const formKey = createIntakeForm(server, 'careers-key', [SITE_ORIGIN])
      const init = {
        method: 'OPTIONS',
        headers: {
          origin: SITE_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }
      const direct = await server.app.request(`/api/intake/${formKey}`, init)
      const res = await app.request(`/api/intake/${formKey}`, init)
      expect(res.status).toBe(direct.status)
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN)
      expect(headersOf(res)).toEqual(headersOf(direct))
      for (const header of PWA_HEADERS) expect(res.headers.get(header)).toBeNull()
    })

    it('answers a submission exactly as the server does', async () => {
      const { server, app } = standalone()
      const formKey = createIntakeForm(server, 'careers-key', [SITE_ORIGIN])
      const post = (body: unknown) => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE_ORIGIN },
        body: JSON.stringify(body),
      })
      const direct = await server.app.request(`/api/intake/${formKey}`, post({ name: 'A', email: 'a@example.com' }))
      const res = await app.request(`/api/intake/${formKey}`, post({ name: 'B', email: 'b@example.com' }))
      expect(res.status).toBe(201)
      expect(res.status).toBe(direct.status)
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN)
      expect(headersOf(res)).toEqual(headersOf(direct))
      for (const header of PWA_HEADERS) expect(res.headers.get(header)).toBeNull()
    })
  })
})
