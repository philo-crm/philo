import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { HOST_TIMEOUT_MS, resetHostPage, type PhiloHost, type PhiloHostContext, type PhiloHostMount } from '../src/host.ts'
import { readTheme } from '../src/theme.ts'
import { installFakeApi, TEST_CLIENT_ID, TEST_ISSUER, TEST_USER, type FakeApi } from './support/fake-api.ts'
import { reloadAt, watchRedirects } from './support/sign-in.tsx'

const getExtraToken = vi.hoisted(() => vi.fn(async () => 'extra-token' as string | null))
vi.mock('../src/extra-token.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/extra-token.ts')>()),
  getExtraToken,
}))

const SCRIPT_URL = '/host/chrome.js'
const HOST_CONFIG = { feedUrl: 'https://feed.example.com', nested: { on: true } }
const RESOURCE = 'https://feed.example.com'

function withHost(overrides: Partial<FakeApi> & { signedIn?: boolean } = {}): FakeApi {
  return installFakeApi({
    leads: [],
    web: { hostScriptUrl: SCRIPT_URL, hostConfig: HOST_CONFIG, hostTokenResources: [RESOURCE] },
    ...overrides,
  })
}

/**
 * Stands in for the browser loading the host script, which jsdom does not:
 * each script element the page adds "loads" on the next microtask, running
 * `onLoad` (the script's own code) first, or fails with `'error'`.
 */
function serveHostScript(onLoad: (() => void) | 'error') {
  const scripts: HTMLScriptElement[] = []
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLScriptElement) || node.src === '') continue
        scripts.push(node)
        queueMicrotask(() => {
          if (onLoad === 'error') {
            node.dispatchEvent(new Event('error'))
            return
          }
          onLoad()
          node.dispatchEvent(new Event('load'))
        })
      }
    }
  })
  observer.observe(document, { childList: true, subtree: true })
  stops.push(() => observer.disconnect())
  return { scripts }
}

/** A host whose `mount` records each context and answers with `answer`. */
function hostAnswering(answer: (ctx: PhiloHostContext) => ReturnType<PhiloHost['mount']>) {
  const contexts: PhiloHostContext[] = []
  const host: PhiloHost = {
    mount(ctx) {
      contexts.push(ctx)
      return answer(ctx)
    },
  }
  serveHostScript(() => {
    window.PhiloHost = host
  })
  return { contexts }
}

/** A host that draws a menu of its own and takes over Philo's. */
function drawingHost(answer: PhiloHostMount = { replaces: ['account-menu'] }) {
  return hostAnswering((ctx) => {
    const button = document.createElement('button')
    button.textContent = 'Host account'
    ctx.slot.append(button)
    return Promise.resolve(answer)
  })
}

const stops: (() => void)[] = []

function hostScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script[src]')]
}

function slot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.host-slot')
}

async function signedInShell() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Leads' })
}

beforeEach(() => {
  resetHostPage()
  delete window.PhiloHost
  for (const script of hostScripts()) script.remove()
  getExtraToken.mockClear()
  window.history.pushState(null, '', '/')
  window.localStorage.removeItem('philo.theme')
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('with no host script configured', () => {
  it('loads no script, leaves no slot and keeps Philo’s own menu', async () => {
    installFakeApi({ leads: [] })
    await signedInShell()
    expect(hostScripts()).toHaveLength(0)
    expect(slot()).toBeNull()
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })

  it('carries on as if there were none when the web config cannot be read', async () => {
    installFakeApi({ leads: [], offline: /^\/api\/v1\/web\/config$/ })
    await signedInShell()
    expect(hostScripts()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })
})

describe('a host script', () => {
  it('is loaded once, async and classic, and mounted with the documented context', async () => {
    withHost()
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))

    const [script] = hostScripts()
    expect(hostScripts()).toHaveLength(1)
    expect(script?.src).toBe(`${window.location.origin}${SCRIPT_URL}`)
    expect(script?.async).toBe(true)
    expect(script?.type).toBe('')

    const ctx = contexts[0]!
    expect(ctx.version).toBe(1)
    expect(ctx.issuer).toBe(TEST_ISSUER)
    expect(ctx.clientId).toBe(TEST_CLIENT_ID)
    expect(ctx.user).toEqual({ email: TEST_USER.email, name: TEST_USER.name })
    expect(ctx.role).toBe('admin')
    expect(ctx.config).toEqual(HOST_CONFIG)
    expect(ctx.accountItems).toEqual([
      { label: 'Server settings', path: '/settings' },
      { label: 'Install the app', path: '/install' },
    ])
    expect(ctx.signal.aborted).toBe(false)
    // The slot is in the page, at the right end of the top bar's actions.
    expect(ctx.slot.isConnected).toBe(true)
    expect(ctx.slot).toBe(document.querySelector('.topbar-actions')?.lastElementChild)
  })

  it('gives a user-role person their own settings entry, not the server’s', async () => {
    withHost({ user: { ...TEST_USER, role: 'user' } })
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))
    expect(contexts[0]?.role).toBe('user')
    expect(contexts[0]?.accountItems).toEqual([
      { label: 'Settings', path: '/settings/notifications' },
      { label: 'Install the app', path: '/install' },
    ])
  })

  it('hides Philo’s menu once the host says it replaces it, and not before', async () => {
    withHost()
    const pending: { take?: (answer: PhiloHostMount) => void } = {}
    hostAnswering((ctx) => {
      ctx.slot.append(document.createElement('button'))
      return new Promise((resolve) => (pending.take = resolve))
    })
    await signedInShell()
    await waitFor(() => expect(hostScripts()).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()

    await act(async () => pending.take?.({ replaces: ['account-menu'] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Account' })).toBeNull())
  })

  it('keeps Philo’s menu beside a host that replaces nothing', async () => {
    withHost()
    const { contexts } = drawingHost({})
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Host account' })).toBeDefined()
  })

  it('is not loaded or mounted again on a re-render or a route change', async () => {
    withHost()
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))

    act(() => {
      window.history.pushState(null, '', '/board')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('link', { name: 'Board', current: 'page' })
    act(() => {
      window.history.pushState(null, '', '/spam')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('link', { name: 'Spam', current: 'page' })
    expect(hostScripts()).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.signal.aborted).toBe(false)
  })

  it('mounts again with a fresh context after a later sign-in, without loading the script again', async () => {
    const api = withHost()
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))

    // The session expires: the shell goes, and with it the first mount.
    api.expired = true
    act(() => {
      window.history.pushState(null, '', '/board')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(contexts[0]?.signal.aborted).toBe(true))

    // Signed in again on the same page.
    cleanup()
    api.expired = false
    window.history.replaceState(null, '', '/')
    window.localStorage.setItem('philo.refresh-token', api.refreshToken ?? '')
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(2))
    expect(contexts[1]).not.toBe(contexts[0])
    expect(contexts[1]?.signal.aborted).toBe(false)
    expect(hostScripts()).toHaveLength(1)
  })

  it('is never loaded on the signed-out screen', async () => {
    withHost({ signedIn: false })
    serveHostScript(() => undefined)
    render(<App />)
    await screen.findByRole('heading', { name: 'Sign in' })
    await act(async () => {})
    expect(hostScripts()).toHaveLength(0)
  })

  it('is never loaded on a failed callback', async () => {
    withHost({ signedIn: false })
    serveHostScript(() => undefined)
    reloadAt('/auth/callback?code=x&state=y')
    await screen.findByRole('heading', { name: 'Sign-in failed' })
    await act(async () => {})
    expect(hostScripts()).toHaveLength(0)
  })

  it('is never loaded when the server cannot be reached', async () => {
    withHost({ offline: /openid-configuration/ })
    serveHostScript(() => undefined)
    render(<App />)
    await screen.findByRole('heading', { name: 'Connection problem' })
    expect(hostScripts()).toHaveLength(0)
  })
})

describe('when the host fails, Philo keeps its own menu', () => {
  async function expectPhiloMenuKept(error: ReturnType<typeof vi.spyOn>) {
    await waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
    expect(slot()?.children).toHaveLength(0)
  }

  it('when the script does not load', async () => {
    withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    serveHostScript('error')
    await signedInShell()
    await expectPhiloMenuKept(error)
  })

  it('when the script sets no PhiloHost', async () => {
    withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    serveHostScript(() => undefined)
    await signedInShell()
    await expectPhiloMenuKept(error)
  })

  it('when mount throws, and the slot is emptied and the signal aborted', async () => {
    withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { contexts } = hostAnswering((ctx) => {
      ctx.slot.append(document.createElement('button'))
      throw new Error('boom')
    })
    await signedInShell()
    await expectPhiloMenuKept(error)
    expect(contexts[0]?.signal.aborted).toBe(true)
  })

  it('for the rest of the page, even after a later sign-in', async () => {
    const api = withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { contexts } = hostAnswering(() => Promise.reject(new Error('nope')))
    await signedInShell()
    await expectPhiloMenuKept(error)

    cleanup()
    window.localStorage.setItem('philo.refresh-token', api.refreshToken ?? '')
    await signedInShell()
    await act(async () => {})
    expect(contexts).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })

  it('when mount rejects', async () => {
    withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    hostAnswering(() => Promise.reject(new Error('nope')))
    await signedInShell()
    await expectPhiloMenuKept(error)
  })

  it('when mount takes longer than 5 s, and ignores the late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    withHost()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pending: { take?: (answer: PhiloHostMount) => void } = {}
    const { contexts } = hostAnswering(
      (ctx) =>
        new Promise((resolve) => {
          ctx.slot.append(document.createElement('button'))
          pending.take = resolve
        }),
    )
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))

    await act(() => vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS))
    await expectPhiloMenuKept(error)
    expect(contexts[0]?.signal.aborted).toBe(true)

    await act(async () => pending.take?.({ replaces: ['account-menu'] }))
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })
})

describe('sign-out stays reachable after the host takes over', () => {
  it('shows Philo’s menu again when the host falls back', async () => {
    withHost()
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Account' })).toBeNull())

    act(() => contexts[0]?.fallback())
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })

  it('shows it again when the slot is still empty 5 s after mounting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    withHost()
    hostAnswering(() => ({ replaces: ['account-menu'] }))
    await signedInShell()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Account' })).toBeNull())

    await act(() => vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS))
    expect(screen.getByRole('button', { name: 'Account' })).toBeDefined()
  })

  it('shows it again when the host empties the slot later', async () => {
    withHost()
    drawingHost()
    await signedInShell()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Account' })).toBeNull())

    act(() => slot()?.replaceChildren())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account' })).toBeDefined())
  })

  it('signs out at /sign-out, whatever the top bar shows', async () => {
    const api = withHost()
    drawingHost()
    const assign = watchRedirects()
    window.history.pushState(null, '', '/sign-out')
    render(<App />)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
    expect(api.revoked).toHaveLength(1)
  })

  it('at /sign-out with no host, lands on the sign-in screen, which would not come back to it', async () => {
    const api = installFakeApi({ leads: [] })
    window.history.pushState(null, '', '/sign-out')
    render(<App />)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(api.revoked).toHaveLength(1)
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })
})

describe('the context reaches Philo’s own stores', () => {
  async function mounted(): Promise<PhiloHostContext> {
    const { contexts } = drawingHost()
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))
    return contexts[0]!
  }

  it('navigates inside the app, and ignores anything that is not an app path', async () => {
    withHost()
    const ctx = await mounted()
    act(() => ctx.navigate('/board'))
    expect(window.location.pathname).toBe('/board')
    expect(await screen.findByRole('link', { name: 'Board', current: 'page' })).toBeDefined()

    for (const path of ['//evil.example.com/x', '/\\evil.example.com', 'https://evil.example.com/', 'board', 42]) {
      act(() => ctx.navigate(path as string))
      expect(window.location.pathname).toBe('/board')
    }
  })

  it('sets the theme in Philo’s own store', async () => {
    withHost()
    const ctx = await mounted()
    act(() => ctx.setTheme('dark'))
    expect(readTheme()).toBe('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
    act(() => ctx.setTheme('nope' as 'dark'))
    expect(readTheme()).toBe('dark')
    act(() => ctx.setTheme('system'))
    expect(document.documentElement.dataset['theme']).toBeUndefined()
  })

  it('signs out through Philo’s own sign-out, aborts the signal and reloads the page', async () => {
    const api = withHost()
    const ctx = await mounted()
    const assign = watchRedirects()
    act(() => ctx.signOut())
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
    expect(api.revoked).toHaveLength(1)
  })

  it('aborts the signal when Philo’s own menu signs out', async () => {
    const api = withHost()
    const { contexts } = drawingHost({})
    await signedInShell()
    await waitFor(() => expect(contexts).toHaveLength(1))
    const assign = watchRedirects()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
    expect(api.revoked).toHaveLength(1)
    cleanup()
    expect(contexts[0]?.signal.aborted).toBe(true)
  })

  it('goes to the provider’s end-session page instead of reloading, when it has one', async () => {
    withHost({ endSessionEndpoint: 'https://idp.example.com/logout' })
    const ctx = await mounted()
    const assign = watchRedirects()
    act(() => ctx.signOut())
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/^https:\/\/idp\.example\.com\/logout\?/)
  })

  it('hands out tokens for an allow-listed resource only', async () => {
    withHost()
    const ctx = await mounted()
    expect(await ctx.getToken({ resource: RESOURCE, scope: 'feed:read' })).toBe('extra-token')
    expect(getExtraToken).toHaveBeenCalledWith({ resource: RESOURCE, scope: 'feed:read', prompt: undefined })
    expect(await ctx.getToken({ resource: RESOURCE, scope: 'feed:read', prompt: 'none' })).toBe('extra-token')
    expect(getExtraToken).toHaveBeenLastCalledWith({ resource: RESOURCE, scope: 'feed:read', prompt: 'none' })

    getExtraToken.mockClear()
    expect(await ctx.getToken({ resource: TEST_ISSUER, scope: 'operator' })).toBeNull()
    expect(await ctx.getToken({ resource: `${RESOURCE}/`, scope: 'feed:read' })).toBeNull()
    expect(await ctx.getToken(undefined as never)).toBeNull()
    expect(getExtraToken).not.toHaveBeenCalled()
  })

  it('hands out nothing once the shell has gone', async () => {
    const api = withHost()
    const ctx = await mounted()
    api.expired = true
    act(() => {
      window.history.pushState(null, '', '/board')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: 'Sign in' })
    // The shell's cleanup is a passive effect: it can run a moment after the screen changes.
    await waitFor(() => expect(ctx.signal.aborted).toBe(true))
    getExtraToken.mockClear()
    expect(await ctx.getToken({ resource: RESOURCE, scope: 'feed:read' })).toBeNull()
    expect(getExtraToken).not.toHaveBeenCalled()
  })
})
