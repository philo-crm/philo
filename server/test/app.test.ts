import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { VERSION } from '../src/version.ts'

let publicDir: string
let app: ReturnType<typeof createApp>

beforeAll(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'philo-public-'))
  mkdirSync(join(publicDir, 'assets'))
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Philo</title>')
  writeFileSync(join(publicDir, 'app.js'), 'console.log("philo")')
  writeFileSync(join(publicDir, 'assets', 'index-abc123.js'), 'console.log("hashed")')
  app = createApp({ publicDir })
})

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

  it('does not mark unhashed root files immutable', async () => {
    const res = await app.request('/app.js')
    expect(res.headers.get('cache-control')).toBeNull()
  })
})

describe('unknown machine-facing paths', () => {
  it.each(['/api/v1/nope', '/api/intake/some-key', '/mcp', '/mcp/anything'])(
    '404s %s as JSON instead of falling through to the SPA',
    async (path) => {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    },
  )

  it('does not shadow API routes registered after createApp', async () => {
    const withApi = createApp({ publicDir })
    withApi.get('/api/v1/leads', (c) => c.json({ leads: [] }))
    const res = await withApi.request('/api/v1/leads')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ leads: [] })
  })
})
