import { describe, expect, it, vi } from 'vitest'
import {
  loadServiceWorker,
  makeClient,
  ORIGIN,
  pushEvent,
  TEST_PRECACHE,
} from './support/service-worker.ts'

function navigation(path: string) {
  return { request: { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' } }
}

function assetRequest(path: string) {
  return { request: { url: `${ORIGIN}${path}`, method: 'GET', mode: 'no-cors' } }
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

describe('install and activate', () => {
  it('precaches the whole shell — not just the page — and takes over', async () => {
    const worker = loadServiceWorker()
    await worker.dispatch('install', {})

    expect(worker.skippedWaiting).toBe(true)
    const cache = worker.caches.get(worker.cacheName)
    // A shell cached without its bundle is a blank screen offline.
    for (const path of TEST_PRECACHE) {
      await expect(cache?.match(path)).resolves.toBeDefined()
    }
  })

  it('fails install rather than taking over with a half-cached shell', async () => {
    const worker = loadServiceWorker(async (input) =>
      String(input).endsWith('.js') ? new Response('gone', { status: 404 }) : new Response('ok'),
    )

    await expect(worker.dispatch('install', {})).rejects.toThrow()
    expect(worker.skippedWaiting).toBe(false)
  })

  it('drops caches from previous builds and claims open pages', async () => {
    const worker = loadServiceWorker()
    await worker.dispatch('install', {})
    worker.caches.set('philo-oldbuild000', worker.caches.get(worker.cacheName)!)

    await worker.dispatch('activate', {})

    expect([...worker.caches.keys()]).toEqual([worker.cacheName])
    expect(worker.claimed).toBe(true)
  })
})

describe('fetch', () => {
  it('serves navigations from the network and refreshes the cached shell', async () => {
    const fetchImpl = vi.fn(async () => html('fresh shell'))
    const worker = loadServiceWorker(fetchImpl as unknown as typeof fetch)
    await worker.dispatch('install', {})

    const response = (await worker.dispatch('fetch', navigation('/leads/42'))) as Response
    await expect(response.text()).resolves.toBe('fresh shell')

    const cached = await worker.caches.get(worker.cacheName)?.match('/')
    await expect(cached?.text()).resolves.toBe('fresh shell')
  })

  it('does not let a navigation that is not the shell become the shell', async () => {
    // /version is a URL an operator types in, and it answers JSON. Cached under
    // the shell key it would be the whole app the next time the network is out.
    const worker = loadServiceWorker(async (input) =>
      String(input).endsWith('/version') ? Response.json({ name: 'philo' }) : html('shell from network'),
    )
    await worker.dispatch('install', {})

    await worker.dispatch('fetch', navigation('/version'))

    const cached = await worker.caches.get(worker.cacheName)?.match('/')
    await expect(cached?.text()).resolves.toBe('shell from network')
  })

  it('falls back to the cached shell when the network is gone', async () => {
    // Installed while online, then the network drops — the sequence a phone in
    // a yard with no signal actually goes through.
    const fetchImpl = vi.fn(async () => html('shell from network'))
    const worker = loadServiceWorker(fetchImpl as unknown as typeof fetch)
    await worker.dispatch('install', {})
    fetchImpl.mockRejectedValue(new TypeError('offline'))

    const response = (await worker.dispatch('fetch', navigation('/board'))) as Response
    await expect(response.text()).resolves.toBe('shell from network')
  })

  it('rethrows when there is neither a network nor a cached shell', async () => {
    const worker = loadServiceWorker(async () => {
      throw new TypeError('offline')
    })

    await expect(worker.dispatch('fetch', navigation('/'))).rejects.toThrow('offline')
  })

  it('serves a precached asset without going to the network at all', async () => {
    const fetchImpl = vi.fn(async () => html('bundle'))
    const worker = loadServiceWorker(fetchImpl as unknown as typeof fetch)
    await worker.dispatch('install', {})
    fetchImpl.mockClear()

    await worker.dispatch('fetch', assetRequest('/assets/index-abc123.js'))

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caches an asset the precache missed, once', async () => {
    const fetchImpl = vi.fn(async () => new Response('lazy chunk'))
    const worker = loadServiceWorker(fetchImpl as unknown as typeof fetch)

    await worker.dispatch('fetch', assetRequest('/assets/later-def456.js'))
    await worker.dispatch('fetch', assetRequest('/assets/later-def456.js'))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('still answers when the cache refuses the write', async () => {
    // Quota is a real limit on a phone, and it is not a reason to fail a
    // request whose response has already come back.
    const worker = loadServiceWorker(async () => new Response('bundle'))
    await worker.dispatch('install', {})
    const cache = worker.caches.get(worker.cacheName)
    if (cache !== undefined) {
      cache.put = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'))
    }

    const asset = (await worker.dispatch('fetch', assetRequest('/assets/later-def456.js'))) as Response
    await expect(asset.text()).resolves.toBe('bundle')
    const shell = (await worker.dispatch('fetch', navigation('/'))) as Response
    expect(shell.status).toBe(200)
  })

  it.each([
    ['an API response', { request: { url: `${ORIGIN}/api/v1/leads`, method: 'GET', mode: 'cors' } }],
    ['a cross-origin request', { request: { url: 'https://elsewhere.example.com/x.js', method: 'GET', mode: 'cors' } }],
    ['a mutation', { request: { url: `${ORIGIN}/api/v1/leads`, method: 'POST', mode: 'cors' } }],
  ])('never answers %s', async (_label, event) => {
    const worker = loadServiceWorker()
    await expect(worker.dispatch('fetch', event)).resolves.toBeUndefined()
  })
})

describe('push', () => {
  const declarative = {
    web_push: 8030,
    notification: {
      title: 'New lead: Dana Okafor',
      body: 'Applied through the careers form',
      navigate: `${ORIGIN}/leads/42`,
      tag: 'lead-42',
    },
  }

  it('renders a Declarative Web Push payload', async () => {
    const worker = loadServiceWorker()
    await worker.dispatch('push', pushEvent(declarative))

    expect(worker.shown).toHaveLength(1)
    expect(worker.shown[0]?.title).toBe('New lead: Dana Okafor')
    expect(worker.shown[0]?.options).toMatchObject({
      body: 'Applied through the careers form',
      tag: 'lead-42',
      data: { navigate: `${ORIGIN}/leads/42` },
    })
  })

  it.each([
    ['no data at all', {}],
    ['a body that is not JSON', { data: { json: () => JSON.parse('not json') } }],
    ['JSON in some other shape', pushEvent({ hello: 'world' })],
    ['a notification with no title', pushEvent({ notification: { body: 'orphaned' } })],
  ])('shows nothing for %s', async (_label, event) => {
    const worker = loadServiceWorker()
    await worker.dispatch('push', event)
    expect(worker.shown).toHaveLength(0)
  })
})

function clickEvent(data: unknown) {
  return { notification: { data, close: () => undefined } }
}

describe('notificationclick', () => {
  it('focuses a window already showing the target', async () => {
    const worker = loadServiceWorker()
    const other = makeClient(`${ORIGIN}/board`)
    const match = makeClient(`${ORIGIN}/leads/42`)
    worker.clients.push(other, match)

    await worker.dispatch('notificationclick', clickEvent({ navigate: `${ORIGIN}/leads/42` }))

    expect(match.focused).toBe(true)
    expect(match.navigatedTo).toBeUndefined()
    expect(other.focused).toBe(false)
  })

  it('steers an already-open window rather than opening a second one', async () => {
    const worker = loadServiceWorker()
    const open = makeClient(`${ORIGIN}/board`)
    worker.clients.push(open)

    await worker.dispatch('notificationclick', clickEvent({ navigate: `${ORIGIN}/leads/42` }))

    expect(open.focused).toBe(true)
    expect(open.navigatedTo).toBe(`${ORIGIN}/leads/42`)
    expect(worker.openedWindows).toHaveLength(0)
  })

  it('opens a window when the app is not running', async () => {
    const worker = loadServiceWorker()
    await worker.dispatch('notificationclick', clickEvent({ navigate: '/leads/42' }))
    expect(worker.openedWindows).toEqual([`${ORIGIN}/leads/42`])
  })

  it('opens a window when an open one refuses to be steered', async () => {
    // A tab opened before this worker took over is not one it may navigate.
    const worker = loadServiceWorker()
    const uncontrolled = makeClient(`${ORIGIN}/board`)
    uncontrolled.navigate = () => Promise.reject(new TypeError('not controlled'))
    worker.clients.push(uncontrolled)

    await worker.dispatch('notificationclick', clickEvent({ navigate: `${ORIGIN}/leads/42` }))

    expect(worker.openedWindows).toEqual([`${ORIGIN}/leads/42`])
  })

  it.each([
    ['a cross-origin target', { navigate: 'https://elsewhere.example.com/steal' }],
    ['a target that is not a string', { navigate: 42 }],
    ['no target at all', undefined],
  ])('opens nothing for %s', async (_label, data) => {
    const worker = loadServiceWorker()
    await worker.dispatch('notificationclick', clickEvent(data))
    expect(worker.openedWindows).toHaveLength(0)
  })
})
