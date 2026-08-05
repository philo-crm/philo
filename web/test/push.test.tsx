import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disablePush,
  enablePush,
  isPushSupported,
  readPushState,
  syncPushSubscription,
} from '../src/push.ts'
import { Settings } from '../src/Settings.tsx'
import { installFakeApi, TEST_VAPID_PUBLIC_KEY } from './support/fake-api.ts'
import { installPushEnv, makeSubscription, TEST_ENDPOINT } from './support/push-env.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isPushSupported', () => {
  it('is false in a browser missing the APIs', () => {
    installPushEnv({ supported: false })
    expect(isPushSupported()).toBe(false)
  })

  it('is true once they are all there', () => {
    installPushEnv()
    expect(isPushSupported()).toBe(true)
  })
})

describe('readPushState', () => {
  it('reports an unsupported browser', async () => {
    installPushEnv({ supported: false })
    await expect(readPushState()).resolves.toBe('unsupported')
  })

  // A Safari tab, or dev: the Push API is there but no worker is installed, so
  // there is nothing to hang a subscription off.
  it('reports unsupported when no service worker is registered', async () => {
    installPushEnv({ hasRegistration: false })
    await expect(readPushState()).resolves.toBe('unsupported')
  })

  it('reports a browser that has been told no', async () => {
    installPushEnv({ permission: 'denied' })
    await expect(readPushState()).resolves.toBe('blocked')
  })

  it('reports off when nothing is subscribed yet', async () => {
    installPushEnv({ permission: 'granted' })
    await expect(readPushState()).resolves.toBe('off')
  })

  it('reports on when this browser already holds a subscription', async () => {
    installPushEnv({ permission: 'granted', subscription: makeSubscription() })
    await expect(readPushState()).resolves.toBe('on')
  })
})

describe('enablePush', () => {
  it('subscribes and registers the subscription with the server', async () => {
    const api = installFakeApi()
    const env = installPushEnv()

    await expect(enablePush()).resolves.toBe('on')

    expect(api.pushSubscriptions).toEqual([
      { endpoint: TEST_ENDPOINT, p256dh: 'BNc-public-key', auth: 'auth-secret' },
    ])
    expect(env.subscribeCalls).toHaveLength(1)
  })

  // Every browser refuses a subscription without it, and it is true of this
  // deployment: every push Philo sends shows a notification.
  it('asks for a user-visible subscription', async () => {
    installFakeApi()
    const env = installPushEnv()

    await enablePush()

    expect(env.subscribeCalls[0]?.userVisibleOnly).toBe(true)
  })

  it('subscribes with the key the server generated, decoded to bytes', async () => {
    installFakeApi()
    const env = installPushEnv()

    await enablePush()

    const key = env.subscribeCalls[0]?.applicationServerKey
    expect(key).toBeInstanceOf(Uint8Array)
    // A P-256 point is 65 bytes, and the leading 0x04 is what says it is uncompressed.
    expect((key as Uint8Array).length).toBe(65)
    expect((key as Uint8Array)[0]).toBe(4)
  })

  it('fetches the key from the server rather than hard-coding one', async () => {
    const api = installFakeApi()
    installPushEnv()

    await enablePush()

    expect(api.calls.some((call) => call.path === '/api/v1/push/key')).toBe(true)
    expect(api.vapidPublicKey).toBe(TEST_VAPID_PUBLIC_KEY)
  })

  it('reuses a subscription this browser already holds', async () => {
    const api = installFakeApi()
    const env = installPushEnv({ permission: 'granted', subscription: makeSubscription() })

    await expect(enablePush()).resolves.toBe('on')

    // No second subscribe, but the server is still told — the row may predate
    // a restore, or have been dropped with a regenerated VAPID key.
    expect(env.subscribeCalls).toEqual([])
    expect(api.pushSubscriptions).toHaveLength(1)
  })

  // Declining the browser's own prompt is an answer, not a failure.
  it('reports blocked when permission is refused, and subscribes to nothing', async () => {
    const api = installFakeApi()
    const env = installPushEnv({ respondWith: 'denied' })

    await expect(enablePush()).resolves.toBe('blocked')

    expect(env.subscribeCalls).toEqual([])
    expect(api.pushSubscriptions).toEqual([])
  })

  it('stays off when the prompt is dismissed without an answer', async () => {
    installFakeApi()
    installPushEnv({ respondWith: 'default' })

    await expect(enablePush()).resolves.toBe('off')
  })

  it('reports unsupported rather than hanging when no worker is registered', async () => {
    installFakeApi()
    installPushEnv({ hasRegistration: false })

    await expect(enablePush()).resolves.toBe('unsupported')
  })

  /**
   * The important failure. A browser subscription the server never stored is one
   * nothing will ever push to, and it would still read as "on" here — so it is
   * rolled back rather than left to look like it worked.
   */
  it('undoes the browser subscription when the server refuses to store it', async () => {
    const api = installFakeApi()
    // Refused on its own merits rather than for the session: the server only
    // stores https endpoints, since it makes outbound requests to them.
    const subscription = makeSubscription('http://push.example.com/insecure')
    installPushEnv({ permission: 'granted', subscription })

    await expect(enablePush()).rejects.toThrow()

    expect(api.pushSubscriptions).toEqual([])
    expect(subscription.unsubscribed).toBe(true)
  })

  /**
   * The exception to the rollback. A lapsed cookie says nothing about the
   * subscription, and `syncPushSubscription` registers it on the next sign-in
   * — throwing it away would cost a working device over a session timeout.
   */
  it('keeps the browser subscription when the session has expired', async () => {
    const api = installFakeApi()
    const subscription = makeSubscription()
    installPushEnv({ permission: 'granted', subscription })
    api.expired = true

    await expect(enablePush()).rejects.toThrow()

    expect(subscription.unsubscribed).toBe(false)
  })
})

/**
 * The drift this exists to close: the server drops rows on a regenerated VAPID
 * pair, on a 404/410 prune, and on a restore — and in every case the browser
 * still holds its subscription, so the toggle reads "on" while nothing is sent.
 */
describe('syncPushSubscription', () => {
  it('re-registers a subscription the server has forgotten', async () => {
    const api = installFakeApi()
    installPushEnv({ permission: 'granted', subscription: makeSubscription() })
    expect(api.pushSubscriptions).toEqual([])

    await expect(syncPushSubscription()).resolves.toBe('on')

    expect(api.pushSubscriptions).toEqual([
      { endpoint: TEST_ENDPOINT, p256dh: 'BNc-public-key', auth: 'auth-secret' },
    ])
  })

  it('says nothing to the server when this browser is not subscribed', async () => {
    const api = installFakeApi()
    installPushEnv({ permission: 'granted' })

    await expect(syncPushSubscription()).resolves.toBe('off')

    expect(api.calls.some((call) => call.method === 'POST')).toBe(false)
  })

  // A repair, not a request the operator made — it must not turn a working
  // screen into an error, and the switch still reflects the browser.
  it('still reports the browser state when the re-register fails', async () => {
    const api = installFakeApi()
    installPushEnv({ permission: 'granted', subscription: makeSubscription() })
    api.expired = true

    await expect(syncPushSubscription()).resolves.toBe('on')
  })
})

describe('disablePush', () => {
  it('tells the server and unsubscribes the browser', async () => {
    const api = installFakeApi({
      pushSubscriptions: [{ endpoint: TEST_ENDPOINT, p256dh: 'BNc-public-key', auth: 'auth-secret' }],
    })
    const subscription = makeSubscription()
    installPushEnv({ permission: 'granted', subscription })

    await expect(disablePush()).resolves.toBe('off')

    expect(api.pushSubscriptions).toEqual([])
    expect(subscription.unsubscribed).toBe(true)
  })

  it('does nothing when this browser was never subscribed', async () => {
    const api = installFakeApi()
    installPushEnv({ permission: 'granted' })

    await expect(disablePush()).resolves.toBe('off')

    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  /**
   * The server is told first on purpose: a row that outlives the browser's
   * subscription is pushed at until a 410 prunes it, so if the DELETE fails the
   * browser keeps its subscription and the two stay in agreement.
   */
  it('keeps the browser subscribed when the server cannot be told', async () => {
    const api = installFakeApi()
    const subscription = makeSubscription()
    installPushEnv({ permission: 'granted', subscription })
    api.expired = true

    await expect(disablePush()).rejects.toThrow()

    expect(subscription.unsubscribed).toBe(false)
  })
})

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1'

/**
 * jsdom has no matchMedia and a read-only navigator — the same shape
 * install.test.tsx needs, for the same `isStandalone`/`isIosSafari` pair.
 */
function useBrowser(userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', standalone = false) {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

describe('the Settings notifications panel', () => {
  const TOGGLE = 'Push a notification to this device when a new lead arrives.'

  function renderSettings(onSessionExpired = vi.fn()) {
    useBrowser()
    render(<Settings onSessionExpired={onSessionExpired} />)
    return onSessionExpired
  }

  async function toggle(): Promise<HTMLInputElement> {
    return (await screen.findByLabelText(TOGGLE)) as HTMLInputElement
  }

  it('starts off in a browser that has not subscribed', async () => {
    installFakeApi()
    installPushEnv({ permission: 'granted' })
    renderSettings()

    const checkbox = await toggle()
    expect(checkbox.checked).toBe(false)
    expect(checkbox.disabled).toBe(false)
  })

  it('starts on when this browser already holds a subscription', async () => {
    installFakeApi()
    installPushEnv({ permission: 'granted', subscription: makeSubscription() })
    renderSettings()

    await waitFor(async () => expect((await toggle()).checked).toBe(true))
  })

  it('subscribes when switched on', async () => {
    const api = installFakeApi()
    installPushEnv()
    renderSettings()

    fireEvent.click(await toggle())

    await waitFor(() => expect(api.pushSubscriptions).toHaveLength(1))
    expect((await toggle()).checked).toBe(true)
  })

  it('unsubscribes when switched off', async () => {
    const api = installFakeApi({
      pushSubscriptions: [{ endpoint: TEST_ENDPOINT, p256dh: 'BNc-public-key', auth: 'auth-secret' }],
    })
    installPushEnv({ permission: 'granted', subscription: makeSubscription() })
    renderSettings()
    await waitFor(async () => expect((await toggle()).checked).toBe(true))

    fireEvent.click(await toggle())

    await waitFor(() => expect(api.pushSubscriptions).toEqual([]))
    expect((await toggle()).checked).toBe(false)
  })

  it('cannot be switched on in a browser that has blocked notifications', async () => {
    installFakeApi()
    installPushEnv({ permission: 'denied' })
    renderSettings()

    const checkbox = await toggle()
    expect(checkbox.disabled).toBe(true)
    expect(screen.getByText(/blocked notifications/i)).toBeDefined()
  })

  it('explains the iPhone case rather than just refusing', async () => {
    installFakeApi()
    installPushEnv({ hasRegistration: false })
    useBrowser(IPHONE_SAFARI)
    render(<Settings onSessionExpired={vi.fn()} />)

    const checkbox = await toggle()
    expect(checkbox.disabled).toBe(true)
    expect(screen.getByText(/added to the Home Screen/i)).toBeDefined()
  })

  it('says push is unavailable in a browser without the APIs', async () => {
    installFakeApi()
    installPushEnv({ supported: false })
    renderSettings()

    expect((await toggle()).disabled).toBe(true)
    expect(screen.getByText(/still emailed to everyone who can sign in/i)).toBeDefined()
  })

  // The switch must never claim something the browser did not do.
  it('reports a failure and falls back to what the browser actually did', async () => {
    const api = installFakeApi()
    // Refused on the subscription's own merits, so the panel reports it rather
    // than treating it as a dead session.
    installPushEnv({ subscribeEndpoint: 'http://push.example.com/insecure' })
    renderSettings()

    fireEvent.click(await toggle())

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(api.pushSubscriptions).toEqual([])
    // And the switch is back where the browser actually is.
    await waitFor(async () => expect((await toggle()).checked).toBe(false))
  })

  /**
   * A 401 is the one failure with an answer other than a message — every other
   * authenticated screen sends it to the login flow, and this one has to too.
   */
  it('sends an expired session to the login flow rather than showing an error', async () => {
    const api = installFakeApi()
    installPushEnv()
    const onSessionExpired = renderSettings()
    await toggle()
    api.expired = true

    fireEvent.click(await toggle())

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })
})
