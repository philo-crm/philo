/*
 * Philo's service worker. Not bundled: vite.config.ts emits this file verbatim
 * at /sw.js, filling in the two placeholders below from the build it just made.
 * Every deploy therefore names its own cache, and `activate` can drop the
 * previous one whole.
 *
 * Two jobs, both deliberately small:
 *   1. Keep the app shell openable when the network is not there.
 *   2. Render a push the browser could not render itself (see `push` below).
 */

const CACHE = 'philo-__PHILO_BUILD__'

/** The shell and the hashed files it pulls in — enough to boot with no network. */
const PRECACHE = __PHILO_PRECACHE__

/** The one navigation response worth keeping: the server answers every client-side route with it. */
const SHELL = '/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // All or nothing: a shell cached without its bundle is a blank screen,
      // and failing here leaves the previous worker in charge.
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return

  // Network first, so a deploy is picked up on the next load rather than
  // whenever the shell happens to fall out of the cache.
  if (request.mode === 'navigate') {
    event.respondWith(shellFirstFromNetwork(request))
    return
  }

  // Content-hashed by vite, so a hit is never stale. Everything else — the API
  // above all — is left alone: a cached answer about leads is a wrong answer.
  if (new URL(request.url).pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
  }
})

/**
 * The network answer goes straight back, and the cache is left alone. What is
 * in it is this build's shell alongside this build's assets, and a deploy that
 * landed a minute ago would overwrite the first without the second — a shell
 * asking for bundles that are not there, which is a blank screen offline. The
 * new build gets its own cache when its own worker installs.
 */
async function shellFirstFromNetwork(request) {
  try {
    return await fetch(request)
  } catch (error) {
    const cached = await caches.open(CACHE).then((cache) => cache.match(SHELL))
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await store(cache, request, response)
  return response
}

/**
 * Writing to the cache is best-effort. Storage can be full or evicted mid-write,
 * and neither is a reason to fail a request whose answer is already in hand.
 */
async function store(cache, key, response) {
  try {
    await cache.put(key, response.clone())
  } catch {
    // Nothing to do: the response still goes back, just without being kept.
  }
}

/*
 * Declarative Web Push (DESIGN.md, Notifications). iOS 18.4+ renders this exact
 * JSON with no service worker involved; every other browser lands here and has
 * to render it by hand. Same payload either way — the server has one format.
 */
self.addEventListener('push', (event) => {
  const notification = readDeclarativeNotification(event.data)
  if (notification === undefined) return
  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      tag: notification.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { navigate: notification.navigate },
    }),
  )
})

function readDeclarativeNotification(data) {
  if (!data) return undefined
  let payload
  try {
    payload = data.json()
  } catch {
    // A payload this worker cannot parse is not worth a blank notification.
    return undefined
  }
  const notification = payload?.notification
  if (typeof notification?.title !== 'string') return undefined
  return notification
}

/*
 * The browser replaced this subscription on its own — key expiry, or a push
 * service rotating the endpoint. The replacement is one the server has never
 * heard of, and the old row it still holds is dead, so every later lead would
 * be pushed nowhere until someone happened to open Settings. Re-register it.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe())
})

async function resubscribe() {
  try {
    const keyResponse = await fetch('/api/v1/push/key')
    // Signed out: nothing to re-register against. The settings toggle picks
    // this up on the next visit, and email is the guaranteed channel meanwhile.
    if (!keyResponse.ok) return
    const { publicKey } = await keyResponse.json()
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(publicKey),
    })
    const stored = await fetch('/api/v1/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    // A subscription the server did not take is one nothing will ever send to,
    // and nothing on screen would ever say so. Dropping it puts the browser
    // back where it started, so the settings toggle reads "off" and the
    // operator can act — the same rollback src/push.ts does.
    if (!stored.ok) await subscription.unsubscribe()
  } catch {
    // Best-effort by design (ADR-0004). The stale row is pruned by the 410 it
    // earns on the next send, and the toggle re-registers when next opened.
  }
}

/**
 * The VAPID key as raw bytes. The Push API also accepts the base64url string,
 * but not every browser firing this event is known to, and a subscribe() that
 * rejects here is a device that silently stops being notified.
 */
function decodeBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (const [index, character] of [...binary].entries()) {
    bytes[index] = character.codePointAt(0)
  }
  return bytes
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const navigateTo = event.notification.data?.navigate
  if (typeof navigateTo !== 'string') return
  event.waitUntil(openApp(navigateTo))
})

/** Reuse an open window when there is one; a second copy of the app helps nobody. */
async function openApp(navigateTo) {
  let target
  try {
    target = new URL(navigateTo, self.location.origin)
  } catch {
    return
  }
  // The payload arrives from the network, so where it points is not taken on trust.
  if (target.origin !== self.location.origin) return

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const existing = windows.find((client) => client.url === target.href) ?? windows[0]
  if (existing === undefined) return self.clients.openWindow(target.href)

  await existing.focus()
  if (existing.url === target.href) return
  try {
    await existing.navigate(target.href)
  } catch {
    // navigate() refuses on a window this worker does not control — the tab was
    // open before the worker took over. A new window still gets them there.
    await self.clients.openWindow(target.href)
  }
}
