import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.ts'
import {
  cleanupTestApps,
  createPublicDir,
  createTestApp,
  setupAdmin,
  type TestApp,
} from './support/app.ts'

let testApp: TestApp
let app: TestApp['app']

beforeEach(() => {
  testApp = createTestApp()
  app = testApp.app
})

afterEach(cleanupTestApps)

describe('GET /version', () => {
  it('reports the package version', async () => {
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ name: 'philo', version: VERSION })
  })

  it('reports a semver-shaped version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('static PWA', () => {
  it('serves index.html at the root', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    await expect(res.text()).resolves.toContain('Philo')
  })

  it('serves built assets', async () => {
    const res = await app.request('/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.request('/leads/42')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('serves the service worker as a script', async () => {
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('serves the manifest as a manifest', async () => {
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/manifest+json')
  })

  it.each(['/sw.js', '/manifest.webmanifest', '/icon-512.png', '/favicon.svg'])(
    '404s %s when the build did not emit it, instead of answering with the shell',
    async (path) => {
      // HTML where a script, a manifest or an icon was asked for fails inside
      // the browser, where nothing reports it — a 404 at least says what
      // happened, and a half-deployed PWA stops hiding.
      const bare = createTestApp({ publicDir: createPublicDir({ withPwaFiles: false }) })
      const res = await bare.app.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).not.toContain('text/html')
    },
  )
})

describe('caching', () => {
  it.each(['/', '/leads/42'])('never caches the app shell at %s', async (path) => {
    const res = await app.request(path)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('caches content-hashed assets forever', async () => {
    const res = await app.request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('caches a ranged read of a hashed asset too', async () => {
    // A partial read is still the file, and the file is still content-hashed.
    const res = await app.request('/assets/index-abc123.js', { headers: { range: 'bytes=0-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('never caches a missing asset as if it were the asset', async () => {
    // A 404 here is a deploy still in flight. Cached for a year, and `public`
    // so in shared caches too, it outlives the deploy that fixes it.
    const res = await app.request('/assets/not-built-yet-abc123.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('does not mark unhashed root files immutable', async () => {
    const res = await app.request('/app.js')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  // A cached service worker is a deploy that never lands: the browser keeps
  // running the old one, and it is the old one that decides what to cache next.
  it.each(['/sw.js', '/manifest.webmanifest'])('makes %s revalidate', async (path) => {
    const res = await app.request(path)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })
})

describe('unknown machine-facing paths', () => {
  it.each(['/api/intake/some-key', '/mcp', '/mcp/anything'])(
    '404s %s as JSON instead of falling through to the SPA',
    async (path) => {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    },
  )

  it('404s an unknown guarded path as JSON once authenticated', async () => {
    const cookie = await setupAdmin(testApp)
    const res = await app.request('/api/v1/nope', { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('does not shadow API routes registered after createApp', async () => {
    // Registered before the first request: Hono freezes its router once one arrives.
    app.get('/api/v1/later', (c) => c.json({ later: true }))
    const cookie = await setupAdmin(testApp)
    const res = await app.request('/api/v1/later', { headers: { cookie } })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ later: true })
  })
})
