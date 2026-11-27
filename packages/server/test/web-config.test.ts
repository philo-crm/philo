import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTestApps, createTestApp } from './support/app.ts'

afterEach(cleanupTestApps)

/** ADR-0013: what the PWA reads, before it holds a token, to decide whether to load a host script. */
describe('GET /api/v1/web/config', () => {
  it('is public, and says there is no host script by default', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/web/config')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    expect(await res.json()).toEqual({ hostScriptUrl: null, hostConfig: {}, hostTokenResources: [] })
  })

  it('hands over the operator’s script, config and token resources', async () => {
    const testApp = createTestApp({
      webHost: {
        scriptUrl: '/host/chrome.js',
        config: { feedUrl: 'https://feed.example.com' },
        tokenResources: ['https://feed.example.com'],
      },
    })
    const res = await testApp.app.request('/api/v1/web/config')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      hostScriptUrl: '/host/chrome.js',
      hostConfig: { feedUrl: 'https://feed.example.com' },
      hostTokenResources: ['https://feed.example.com'],
    })
  })
})
