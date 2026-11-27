import type { Role, WebConfig } from '@philo/sdk'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { philo } from './client.ts'
import { getExtraToken } from './extra-token.ts'
import { navigate } from './router.tsx'
import { setTheme, THEMES, type Theme } from './theme.ts'

/**
 * The operator host script — ADR-0013, documented in docs/DESIGN.md under
 * "Host chrome". Off unless the operator sets `PHILO_WEB_HOST_SCRIPT_URL`.
 *
 * The script, when it runs, sets `window.PhiloHost`; the signed-in shell calls
 * its `mount` with an empty element in the top bar and the context below.
 * The script runs with the page's full authority, so this is a contract for
 * a well-behaved host, not a sandbox: what it bounds is that nothing the host
 * does, or fails to do, can leave the person without Philo's own way to sign
 * out.
 */

/** The host script sets this global when it runs. */
export interface PhiloHost {
  mount(ctx: PhiloHostContext): PhiloHostMount | void | Promise<PhiloHostMount | void>
}

export interface PhiloHostMount {
  /** Philo controls the host now draws instead. Today only the account menu. */
  replaces?: ReadonlyArray<'account-menu'>
}

export interface PhiloHostContext {
  /** Bumped only by a breaking change; new optional fields do not bump it. */
  version: 1
  /** An empty element at the right end of the top bar's actions. The host's until `signal` aborts. */
  slot: HTMLElement
  /** The IdP the PWA signs in with: the same values as GET /api/v1/auth/config. */
  issuer: string
  clientId: string
  user: { email: string; name: string | null }
  /** ADR-0012. */
  role: Role
  /** PHILO_WEB_HOST_CONFIG. */
  config: unknown
  /**
   * The extra-token helper, for a resource in PHILO_WEB_HOST_TOKEN_RESOURCES only.
   * null for any other resource, with the built-in IdP, or when the IdP refused.
   */
  getToken(request: { resource: string; scope: string; prompt?: string }): Promise<string | null>
  /** Client-side navigation inside Philo. Only a same-app path (one leading `/`, not `//`); anything else is ignored. */
  navigate(path: string): void
  /** Philo's own sign-out, revocation included. */
  signOut(): void
  /** The host cannot draw what it replaced: Philo shows its own account menu again. */
  fallback(): void
  /** Philo's own theme store: its stored choice, `data-theme` and the `theme-color` meta. */
  setTheme(theme: Theme): void
  /** Philo's own account-menu entries for this person's role (Server settings for an admin only). */
  accountItems: ReadonlyArray<{ label: string; path: string }>
  /** Aborted when the signed-in shell unmounts: sign-out, an expired session. */
  signal: AbortSignal
}

declare global {
  interface Window {
    PhiloHost?: PhiloHost | undefined
  }
}

/** What the PWA does with no host script, and when the web config cannot be read. */
export const NO_HOST: WebConfig = { hostScriptUrl: null, hostConfig: {}, hostTokenResources: [] }

/**
 * How long the host has to load and mount, counted from injection, and how
 * long after mounting it has to put something in the slot it took over.
 */
export const HOST_TIMEOUT_MS = 5_000

/**
 * Never throws: a server that predates the endpoint, or a network failure,
 * is a page without a host script, which is the safe answer.
 */
export async function loadWebConfig(): Promise<WebConfig> {
  try {
    const config = await philo.web.config()
    return typeof config.hostScriptUrl === 'string' ? config : NO_HOST
  } catch {
    return NO_HOST
  }
}

/** Philo's own account-menu entries — AccountMenu.tsx draws the same ones. */
export function accountItemsFor(role: Role): ReadonlyArray<{ label: string; path: string }> {
  return [
    role === 'admin' ? { label: 'Server settings', path: '/settings' } : { label: 'Settings', path: '/settings/notifications' },
    { label: 'Install the app', path: '/install' },
  ]
}

/** One per page: the script is injected once, and a failure stands until the page reloads. */
interface PageState {
  script: Promise<PhiloHost> | undefined
  failed: boolean
}

let page: PageState = { script: undefined, failed: false }

/** Whether this page has injected a host script; sign-out reloads the page when it has. */
export function hostScriptLoaded(): boolean {
  return page.script !== undefined
}

/** Forgets the script, as a fresh page load would. For tests: a real page never needs it. */
export function resetHostPage(): void {
  page = { script: undefined, failed: false }
}

function injectScript(url: string): Promise<PhiloHost> {
  page.script ??= new Promise<PhiloHost>((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.addEventListener('load', () => {
      const host = window.PhiloHost
      if (typeof host?.mount === 'function') resolve(host)
      else reject(new Error('the host script set no window.PhiloHost'))
    })
    script.addEventListener('error', () => reject(new Error('the host script did not load')))
    document.head.append(script)
  })
  return page.script
}

/** One leading `/`, not `//` or `/\`, which a browser reads as another origin. */
function isAppPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')
}

export interface UseHostOptions {
  web: WebConfig
  issuer: string
  clientId: string
  user: { email: string; name: string | null; role: Role }
  onSignOut: () => void
}

export interface HostState {
  /** Where the slot goes; null when there is no host script. Empty, it takes no room (index.css). */
  slotRef: RefObject<HTMLDivElement | null> | null
  /** Whether Philo's own account menu should step aside. */
  replacesAccountMenu: boolean
}

/**
 * Loads the host script on the first signed-in shell, and mounts it on every
 * one. Philo's own controls stay until the host takes over, and come back
 * whenever it cannot have: a load failure, a throw, no answer in time, an
 * empty slot, or the host saying so.
 */
export function useHost({ web, issuer, clientId, user, onSignOut }: UseHostOptions): HostState {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [replacesAccountMenu, setReplacesAccountMenu] = useState(false)
  const scriptUrl = web.hostScriptUrl

  // Read inside the mount only: a host mounts once per shell, so later
  // renders do not hand it a new context.
  const latest = useRef({ web, issuer, clientId, user, onSignOut })
  latest.current = { web, issuer, clientId, user, onSignOut }

  useEffect(() => {
    const found = slotRef.current
    if (scriptUrl === null || page.failed || found === null) return
    const slot: HTMLDivElement = found
    const context = latest.current
    const controller = new AbortController()
    const { signal } = controller
    /** Settled one way or the other, or the shell has gone: nothing the host says now counts. */
    let decided = false
    /** The host gave up what it replaced, for the rest of this mount. */
    let fellBack = false
    let watchTimer: number | undefined
    let observer: MutationObserver | undefined

    function stopWatching(): void {
      window.clearTimeout(watchTimer)
      observer?.disconnect()
    }

    function fallback(): void {
      if (signal.aborted || fellBack) return
      fellBack = true
      stopWatching()
      setReplacesAccountMenu(false)
    }

    function fail(reason: unknown): void {
      if (decided) return
      decided = true
      window.clearTimeout(deadline)
      page.failed = true
      console.error('Philo: the host script failed, so Philo keeps its own account menu.', reason)
      controller.abort()
      slot.replaceChildren()
      setReplacesAccountMenu(false)
    }

    const tokenResources = new Set(context.web.hostTokenResources)
    const ctx: PhiloHostContext = {
      version: 1,
      slot,
      issuer: context.issuer,
      clientId: context.clientId,
      user: { email: context.user.email, name: context.user.name },
      role: context.user.role,
      config: structuredClone(context.web.hostConfig),
      getToken(request) {
        const { resource, scope, prompt } = (request ?? {}) as Partial<typeof request>
        if (signal.aborted || typeof resource !== 'string' || typeof scope !== 'string') return Promise.resolve(null)
        if (!tokenResources.has(resource)) return Promise.resolve(null)
        return getExtraToken({ resource, scope, prompt: typeof prompt === 'string' ? prompt : undefined })
      },
      navigate(path) {
        if (!signal.aborted && isAppPath(path)) navigate(path)
      },
      signOut() {
        if (!signal.aborted) latest.current.onSignOut()
      },
      fallback,
      setTheme(theme) {
        if (!signal.aborted && (THEMES as readonly unknown[]).includes(theme)) setTheme(theme)
      },
      accountItems: Object.freeze(accountItemsFor(context.user.role).map((item) => Object.freeze({ ...item }))),
      signal,
    }

    const deadline = window.setTimeout(() => fail(new Error(`no answer in ${HOST_TIMEOUT_MS} ms`)), HOST_TIMEOUT_MS)

    function took(result: PhiloHostMount | void): void {
      if (decided) return
      decided = true
      window.clearTimeout(deadline)
      const replaces = result?.replaces
      if (fellBack || !Array.isArray(replaces) || !replaces.includes('account-menu')) return
      setReplacesAccountMenu(true)
      // A resolved mount does not prove a working menu: one that never
      // draws, or later empties the slot, gives Philo's back.
      const isEmpty = () => slot.children.length === 0
      watchTimer = window.setTimeout(() => {
        if (isEmpty()) fallback()
      }, HOST_TIMEOUT_MS)
      observer = new MutationObserver(() => {
        if (isEmpty()) fallback()
      })
      observer.observe(slot, { childList: true })
    }

    injectScript(new URL(scriptUrl, window.location.origin).href)
      .then((host) => {
        if (decided) return undefined
        return host.mount(ctx)
      })
      .then(took, fail)

    return () => {
      decided = true
      window.clearTimeout(deadline)
      stopWatching()
      controller.abort()
      setReplacesAccountMenu(false)
    }
  }, [scriptUrl])

  return { slotRef: scriptUrl === null ? null : slotRef, replacesAccountMenu }
}
