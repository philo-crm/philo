import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { InstallHelper } from '../src/InstallHelper.tsx'
import { isIosSafari, isStandalone, shouldOfferInstall } from '../src/install.ts'
import { installFakeApi, makeLead } from './support/fake-api.ts'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/137.0 Mobile/15E148 Safari/604.1'
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36'

/** jsdom's navigator is read-only, so each field is redefined rather than assigned. */
function useBrowser(userAgent: string, { maxTouchPoints = 0, standalone = false } = {}): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

/** jsdom ships no Storage, so the dismissal needs one to be written down in. */
function useMemoryStorage(): void {
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
  })
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
  useMemoryStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detection', () => {
  it('recognises iPhone Safari in a tab', () => {
    useBrowser(IPHONE_SAFARI)
    expect(isIosSafari()).toBe(true)
    expect(isStandalone()).toBe(false)
    expect(shouldOfferInstall()).toBe(true)
  })

  it('recognises iPadOS, which reports itself as a Mac', () => {
    useBrowser(IPAD_SAFARI, { maxTouchPoints: 5 })
    expect(isIosSafari()).toBe(true)
    expect(shouldOfferInstall()).toBe(true)
  })

  it('leaves a touchless Mac alone', () => {
    useBrowser(IPAD_SAFARI)
    expect(isIosSafari()).toBe(false)
    expect(shouldOfferInstall()).toBe(false)
  })

  it('does not nudge iOS Chrome, which cannot add to the Home Screen', () => {
    useBrowser(IPHONE_CHROME)
    expect(isIosSafari()).toBe(false)
    expect(shouldOfferInstall()).toBe(false)
  })

  it('leaves desktop browsers to their own install affordance', () => {
    useBrowser(DESKTOP_CHROME)
    expect(shouldOfferInstall()).toBe(false)
  })

  it.each([
    ['display-mode', IPHONE_SAFARI],
    ['navigator.standalone', IPHONE_SAFARI],
  ])('stops nudging once installed, per %s', (_label, userAgent) => {
    useBrowser(userAgent, { standalone: true })
    expect(isStandalone()).toBe(true)
    expect(shouldOfferInstall()).toBe(false)
  })

  it('keeps working where storage throws, as Safari private mode does', async () => {
    useBrowser(IPHONE_SAFARI)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    // The nudge still appears, and dismissing it still hides it for this load.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})

describe('InstallHelper', () => {
  it('walks iOS Safari through the Share menu', () => {
    useBrowser(IPHONE_SAFARI)
    render(<InstallHelper />)

    expect(screen.getByText('Add to Home Screen')).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('points other browsers at their own install control', () => {
    useBrowser(DESKTOP_CHROME)
    render(<InstallHelper />)

    expect(screen.getByText('Install app')).toBeDefined()
    expect(screen.queryByText('Add to Home Screen')).toBeNull()
  })

  it('says so when the app is already installed', () => {
    useBrowser(IPHONE_SAFARI, { standalone: true })
    render(<InstallHelper />)

    expect(screen.getByText(/already installed/)).toBeDefined()
    expect(screen.queryByText('Add to Home Screen')).toBeNull()
  })
})

describe('the shell banner', () => {
  it('offers the walkthrough on iOS Safari and remembers a dismissal', async () => {
    useBrowser(IPHONE_SAFARI)
    installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    const view = render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('link', { name: 'How' }))
    expect(await screen.findByRole('heading', { name: 'Install Philo' })).toBeDefined()
    // The banner would be repeating the screen it links to.
    expect(screen.queryByRole('link', { name: 'How' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Back to leads' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()

    // A reload is a fresh mount; the dismissal has to outlive it.
    view.unmount()
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('stays out of the way on desktop', async () => {
    useBrowser(DESKTOP_CHROME)
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    // The screen itself stays reachable for anyone who goes looking.
    window.history.pushState(null, '', '/install')
    render(<InstallHelper />)
    expect(screen.getByRole('heading', { name: 'Install Philo' })).toBeDefined()
  })
})
