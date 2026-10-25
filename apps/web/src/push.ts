/*
 * Turning push on and off for this browser. ADR-0004: push is the fast path and
 * email the guaranteed one, so everything here fails soft — a browser that will
 * not subscribe costs an operator the banner, never the lead.
 *
 * iOS is the constraint that shapes this: push works only from a Home Screen
 * web app, and permission has to be asked from a tap. `enablePush` is therefore
 * written to be called straight out of a click handler, with nothing awaited
 * before `requestPermission` — Safari drops the user gesture otherwise.
 */

import { fetchVapidPublicKey, storePushSubscription, forgetPushSubscription } from './api.ts'
import { isUnauthorized } from './http.ts'

export type PushState =
  /** No Push API here, or no service worker to hang a subscription off. */
  | 'unsupported'
  /** The browser has been told no, and will not ask again from a tap. */
  | 'blocked'
  | 'off'
  | 'on'

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * The active worker, or undefined when there is not one. `ready` never settles
 * without a registration, so it is only ever awaited behind this check — a
 * settings toggle that hangs forever is worse than one that says it cannot help.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing === undefined || existing === null) return undefined
  return navigator.serviceWorker.ready
}

/** What the toggle shows on arrival. Never throws: this runs on render. */
export async function readPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    const registration = await activeRegistration()
    if (registration === undefined) return 'unsupported'
    const subscription = await registration.pushManager.getSubscription()
    return subscription === null ? 'off' : 'on'
  } catch {
    return 'unsupported'
  }
}

/**
 * The VAPID public key as the Push API wants it: raw bytes, not the base64url
 * the server serves it in.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  // Allocated over its own ArrayBuffer rather than built with `Uint8Array.from`,
  // which infers the shared-memory-capable type `subscribe` will not take.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (const [index, character] of [...binary].entries()) {
    bytes[index] = character.codePointAt(0) ?? 0
  }
  return bytes
}

/**
 * Subscribes this browser and tells the server about it. Call it from a click:
 * `requestPermission` is the first thing that happens, because iOS only honours
 * it while the tap that led here is still current.
 *
 * Answers with the state the toggle should now show rather than throwing for a
 * refusal — a person declining the browser's prompt is an answer, not an error.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off'

  const registration = await activeRegistration()
  if (registration === undefined) return 'unsupported'

  // Reused when there is one: a browser hands back the same endpoint, and
  // re-subscribing over the top would only rotate keys the server already has.
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by every browser that implements the Push API, and true of
      // this deployment: every push Philo sends shows a notification.
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(await fetchVapidPublicKey()),
    }))

  try {
    await storePushSubscription(subscription.toJSON())
  } catch (error) {
    // A subscription the server does not know about is one nothing will ever
    // send to, and it would still read as "on" here. Undo it so the toggle
    // tells the truth, then let the screen report the failure.
    //
    // An expired session is the exception: the subscription is perfectly good
    // and `syncPushSubscription` registers it on the next sign-in, so throwing
    // it away would cost a working device over a cookie.
    if (!isUnauthorized(error)) await subscription.unsubscribe().catch(() => undefined)
    throw error
  }
  return 'on'
}

/**
 * The state of this browser, having first made sure the server agrees with it.
 *
 * The two can drift, and only ever in the direction that silently costs a
 * notification: the server drops rows on a regenerated VAPID pair, on a 404 or
 * 410 from a push service, and on any restore from an older backup — and in
 * every one of those the browser still holds its subscription, so the toggle
 * reads "on" while nothing is ever sent. Re-registering what the browser has is
 * cheap (`saveSubscription` is an upsert keyed on the endpoint) and closes it.
 */
export async function syncPushSubscription(): Promise<PushState> {
  const state = await readPushState()
  if (state !== 'on') return state
  try {
    const registration = await activeRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription !== undefined && subscription !== null) {
      await storePushSubscription(subscription.toJSON())
    }
  } catch {
    // Best-effort repair. The switch still reflects the browser, and the
    // operator can always turn it off and on to force the issue.
  }
  return state
}

/**
 * Stops this browser receiving pushes. The server is told first: a row that
 * outlives the browser's subscription is one every later lead pushes at until a
 * 410 prunes it, whereas a browser that unsubscribed with the row still stored
 * simply gets nothing.
 */
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported'
  const registration = await activeRegistration()
  if (registration === undefined) return 'unsupported'

  const subscription = await registration.pushManager.getSubscription()
  if (subscription === null) return 'off'

  await forgetPushSubscription(subscription.endpoint)
  await subscription.unsubscribe()
  return 'off'
}
