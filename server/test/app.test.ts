import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { VERSION } from '../src/version.ts'

let publicDir: string
let app: ReturnType<typeof createApp>

beforeAll(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'philo-public-'))
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Philo</title>')
  writeFileSync(join(publicDir, 'app.js'), 'console.log("philo")')
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

describe('unknown API paths', () => {
  it('404s as JSON instead of falling through to the SPA', async () => {
    const res = await app.request('/api/v1/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
