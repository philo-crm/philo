import { vi } from 'vitest'

/**
 * jsdom implements none of the Push API, so src/push.ts is exercised against
 * this stand-in. It models the parts the client actually leans on: permission
 * that has to be asked for, a registration that only exists once a worker is
 * installed, and a `PushManager` that hands back the same subscription twice.
 */

export interface FakeSubscription {
  endpoint: string
  /** True once `unsubscribe()` has been called, as a rollback does. */
  unsubscribed: boolean
  unsubscribe: () => Promise<boolean>
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
}

export interface PushEnv {
  /** What `Notification.requestPermission()` will answer. */
  permission: NotificationPermission
  /** Set before the answer is given, to model a person tapping "Don't allow". */
  respondWith: NotificationPermission | undefined
  /** Undefined models a browser with no service worker installed — dev, or iOS Safari in a tab. */
  registration: FakeRegistration | undefined
  /** Every `subscribe()` call's options, so the test can assert on what was asked for. */
  subscribeCalls: { userVisibleOnly?: boolean; applicationServerKey?: unknown }[]
  /** Set to make `subscribe()` reject, as a browser with no push service does. */
  subscribeFailure: Error | undefined
}

export interface FakeRegistration {
  pushManager: {
    getSubscription: () => Promise<FakeSubscription | null>
    subscribe: (options: Record<string, unknown>) => Promise<FakeSubscription>
  }
}

export const TEST_ENDPOINT = 'https://push.example.com/subscription/abc123'

export function makeSubscription(endpoint = TEST_ENDPOINT): FakeSubscription {
  const subscription: FakeSubscription = {
    endpoint,
    unsubscribed: false,
    unsubscribe: async () => {
      subscription.unsubscribed = true
      return true
    },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BNc-public-key', auth: 'auth-secret' } }),
  }
  return subscription
}

/**
 * Installs the fakes on `navigator`, `window` and `globalThis`. `supported:
 * false` leaves them off entirely, which is the shape of a browser that cannot
 * do push at all.
 */
export function installPushEnv(
  options: {
    supported?: boolean
    permission?: NotificationPermission
    respondWith?: NotificationPermission
    subscription?: FakeSubscription | null
    hasRegistration?: boolean
    /** The endpoint a fresh `subscribe()` hands back. */
    subscribeEndpoint?: string
  } = {},
): PushEnv {
  const {
    supported = true,
    permission = 'default',
    respondWith = 'granted',
    subscription = null,
    hasRegistration = true,
    subscribeEndpoint = TEST_ENDPOINT,
  } = options

  const env: PushEnv = {
    permission,
    respondWith,
    registration: undefined,
    subscribeCalls: [],
    subscribeFailure: undefined,
  }

  if (!supported) {
    // `vi.stubGlobal(name, undefined)` still defines the property, and
    // `'PushManager' in window` would then be true — so they are deleted.
    for (const key of ['PushManager', 'Notification']) {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, key)
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, key)
    }
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serviceWorker')
    return env
  }

  let current = subscription
  const registration: FakeRegistration = {
    pushManager: {
      // An unsubscribed subscription is one the browser no longer hands back,
      // which is what makes a rolled-back `enablePush` read as "off" again.
      getSubscription: async () => (current?.unsubscribed === true ? null : current),
      subscribe: async (subscribeOptions) => {
        env.subscribeCalls.push(subscribeOptions)
        if (env.subscribeFailure !== undefined) throw env.subscribeFailure
        current = makeSubscription(subscribeEndpoint)
        return current
      },
    },
  }
  if (hasRegistration) env.registration = registration

  const notification = {
    get permission() {
      return env.permission
    },
    requestPermission: async () => {
      if (env.respondWith !== undefined) env.permission = env.respondWith
      return env.permission
    },
  }

  vi.stubGlobal('Notification', notification)
  // Only ever tested for with `'PushManager' in window`, so its presence is the
  // whole of what it has to be.
  vi.stubGlobal('PushManager', {})
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => env.registration,
      // Only ever awaited behind a getRegistration() check, so it settles with
      // whatever that found — a real `ready` would simply never resolve.
      get ready() {
        return Promise.resolve(env.registration)
      },
    },
  })

  return env
}
