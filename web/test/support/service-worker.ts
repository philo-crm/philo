/**
 * src/sw.js never goes through a bundler — vite.config.ts emits it verbatim —
 * so the only honest way to test it is to run the same text against a stand-in
 * for the worker global. `?raw` is what keeps this the shipped text rather than
 * a transformed copy of it.
 */
import SOURCE from '../../src/sw.js?raw'

export interface FakeCache {
  entries: Map<string, Response>
  add: (request: string) => Promise<void>
  put: (request: Request | string, response: Response) => Promise<void>
  match: (request: Request | string) => Promise<Response | undefined>
}

export interface FakeClient {
  url: string
  focused: boolean
  navigatedTo: string | undefined
  focus: () => Promise<FakeClient>
  navigate: (url: string) => Promise<FakeClient>
}

export type Handlers = Record<string, (event: unknown) => void>

export interface WorkerHarness {
  handlers: Handlers
  caches: Map<string, FakeCache>
  cacheName: string
  shown: { title: string; options: Record<string, unknown> }[]
  clients: FakeClient[]
  openedWindows: string[]
  claimed: boolean
  skippedWaiting: boolean
  /** Fires a listener and awaits everything it passed to `waitUntil`/`respondWith`. */
  dispatch: (type: string, event: Record<string, unknown>) => Promise<unknown>
}

export const ORIGIN = 'https://philo.example.com'

function makeCache(): FakeCache {
  const entries = new Map<string, Response>()
  const key = (request: Request | string) =>
    typeof request === 'string' ? new URL(request, ORIGIN).href : request.url
  return {
    entries,
    add: async (request) => {
      entries.set(key(request), new Response('shell from network'))
    },
    put: async (request, response) => {
      entries.set(key(request), response)
    },
    match: async (request) => entries.get(key(request)),
  }
}

export function makeClient(url: string): FakeClient {
  const client: FakeClient = {
    url,
    focused: false,
    navigatedTo: undefined,
    focus: async () => {
      client.focused = true
      return client
    },
    navigate: async (to) => {
      client.navigatedTo = to
      client.url = to
      return client
    },
  }
  return client
}

/**
 * Evaluates the worker source against fresh fakes and hands back everything the
 * assertions need to look at.
 */
export function loadServiceWorker(fetchImpl: typeof fetch = async () => new Response('network')): WorkerHarness {
  const handlers: Handlers = {}
  const cacheStore = new Map<string, FakeCache>()
  const harness: Partial<WorkerHarness> = {
    handlers,
    caches: cacheStore,
    shown: [],
    clients: [],
    openedWindows: [],
    claimed: false,
    skippedWaiting: false,
  }

  const cachesApi = {
    open: async (name: string) => {
      const existing = cacheStore.get(name)
      if (existing !== undefined) return existing
      const created = makeCache()
      cacheStore.set(name, created)
      return created
    },
    keys: async () => [...cacheStore.keys()],
    delete: async (name: string) => cacheStore.delete(name),
  }

  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers[type] = handler
    },
    skipWaiting: async () => {
      harness.skippedWaiting = true
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        harness.shown?.push({ title, options })
      },
    },
    clients: {
      claim: async () => {
        harness.claimed = true
      },
      matchAll: async () => harness.clients ?? [],
      openWindow: async (url: string) => {
        harness.openedWindows?.push(url)
        return makeClient(url)
      },
    },
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('self', 'caches', 'fetch', 'Response', 'URL', SOURCE)
  run(self, cachesApi, fetchImpl, Response, URL)

  const pending: unknown[] = []
  harness.dispatch = async (type, event) => {
    const handler = handlers[type]
    if (handler === undefined) throw new Error(`no ${type} listener registered`)
    let responded: unknown
    handler({
      ...event,
      waitUntil: (promise: unknown) => pending.push(promise),
      respondWith: (promise: unknown) => {
        responded = promise
      },
    })
    await Promise.all(pending.splice(0))
    return responded === undefined ? undefined : await responded
  }

  // The cache name is stamped at build time; tests read it back off the store
  // after `install` rather than duplicating the placeholder.
  Object.defineProperty(harness, 'cacheName', {
    get: () => [...cacheStore.keys()].find((name) => name.startsWith('philo-')) ?? '',
  })

  return harness as WorkerHarness
}

/** A push event whose `data.json()` returns the given payload. */
export function pushEvent(payload: unknown): Record<string, unknown> {
  return {
    data: {
      json: () => {
        if (typeof payload === 'string') return JSON.parse(payload)
        return payload
      },
    },
  }
}
