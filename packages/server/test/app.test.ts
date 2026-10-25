import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.ts'
import {
  cleanupTestApps,
  createTestApp,
  setupAdmin,
  TEST_PUBLIC_BASE_URL,
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

describe('GET /llms.txt', () => {
  it('serves the agent tour as plain text, unauthenticated', async () => {
    const res = await app.request('/llms.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    // Unhashed and served from the root, like sw.js and the manifest: an
    // upgrade rewrites it, so a shared cache must revalidate.
    expect(res.headers.get('cache-control')).toBe('no-cache')
    await expect(res.text()).resolves.toContain('# Philo')
  })

  it('builds its URLs from the public base url and the MCP url', async () => {
    const configured = createTestApp({
      publicBaseUrl: 'https://philo.example.com',
      mcpUrl: 'https://agents.example.com/mcp',
    })
    const body = await (await configured.app.request('/llms.txt')).text()
    expect(body).toContain('https://philo.example.com/api/v1')
    expect(body).toContain('https://agents.example.com/mcp')
    expect(body).toContain('https://agents.example.com/.well-known/oauth-protected-resource/mcp')
    expect(body).not.toContain('http://localhost')
  })

  it('names the endpoints an agent has to find', async () => {
    const body = await (await app.request('/llms.txt')).text()
    // Fixed by the code or by an RFC, and unreachable by guessing: a tour that
    // has drifted off them is worse than none.
    for (const path of [
      '/mcp',
      '/api/v1',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/openid-configuration',
      '/oauth/authorize',
      '/oauth/token',
    ]) {
      expect(body).toContain(`${TEST_PUBLIC_BASE_URL}${path}`)
    }
  })
})

describe('unknown paths', () => {
  // Headless: there is no app shell to fall through to, and an HTML answer
  // would be an unparseable success to whatever asked.
  it.each(['/api/intake/some-key', '/mcp', '/', '/leads/42', '/assets/index.js'])(
    '404s %s as JSON',
    async (path) => {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    },
  )

  it('404s an unknown guarded path as JSON once authenticated', async () => {
    const authorization = await setupAdmin(testApp)
    const res = await app.request('/api/v1/nope', { headers: { authorization } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('does not shadow API routes registered after createApp', async () => {
    // Registered before the first request: Hono freezes its router once one arrives.
    app.get('/api/v1/later', (c) => c.json({ later: true }))
    const authorization = await setupAdmin(testApp)
    const res = await app.request('/api/v1/later', { headers: { authorization } })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ later: true })
  })
})
