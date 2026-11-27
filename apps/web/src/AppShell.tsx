import { useEffect, useRef, useState } from 'react'
import { AccountMenu } from './AccountMenu.tsx'
import type { WebConfig } from '@philo/sdk'
import type { User } from './auth.ts'
import { FunnelBoard } from './FunnelBoard.tsx'
import { FUNNEL_SECTIONS, FunnelSettings, type FunnelSection } from './FunnelSettings.tsx'
import { FunnelSwitcher } from './FunnelSwitcher.tsx'
import { NO_HOST, useHost } from './host.ts'
import { PlusIcon } from './icons.tsx'
import { dismissInstallPrompt, isInstallPromptDismissed, shouldOfferInstall } from './install.ts'
import { InstallHelper } from './InstallHelper.tsx'
import { LeadDetail } from './LeadDetail.tsx'
import { LeadList } from './LeadList.tsx'
import { NewLead } from './NewLead.tsx'
import { isInAppNotificationsOn, onInAppNotificationsChange, runInAppNotifications } from './push.ts'
import { Link, usePath } from './router.tsx'
import { AdminOnly, SETTINGS_SECTIONS, Settings, type SettingsSection } from './Settings.tsx'

export interface AppShellProps {
  user: User
  /** The operator's host script, if any — ADR-0013. */
  web?: WebConfig | undefined
  /** The IdP the PWA signed in with, for the host's context. */
  signIn?: { issuer: string; clientId: string } | undefined
  onSignOut: () => void
  /** A 401 from any screen: the session ended, so hand back to the sign-in screen. */
  onSessionExpired: () => void
}

const LEAD_PATH = /^\/leads\/(\d+)$/
const SETTINGS_PATH = /^\/settings(?:\/([\w-]+))?$/
const FUNNEL_PATH = /^\/funnel(?:\/([\w-]+))?$/

/** Signs out from a bookmark or the address bar — ADR-0013. */
export const SIGN_OUT_PATH = '/sign-out'

const NO_SIGN_IN = { issuer: '', clientId: '' }

/** A path's section, or undefined for one the area does not have. */
function sectionOf<T extends string>(match: RegExpExecArray | null, sections: Record<T, unknown>, fallback: T): T | undefined {
  if (match === null) return undefined
  const named = match[1] ?? fallback
  return Object.hasOwn(sections, named) ? (named as T) : undefined
}

/**
 * Which top-bar tab a path lights. A lead has no tab of its own and is opened
 * from both the list and the board, so its screen keeps Leads lit; the
 * settings areas belong to the menus, not to a tab, and light none.
 */
function tabFor(path: string): string | undefined {
  if (path === '/board' || path === '/spam') return path
  if (path === '/' || path.startsWith('/leads')) return '/'
  return undefined
}

type ScreenProps = Pick<AppShellProps, 'user' | 'onSignOut' | 'onSessionExpired'>

/**
 * Signs out as soon as it shows, whatever the top bar does: the way out no
 * host script can take away (ADR-0013). Once per visit, StrictMode included.
 */
function SignOutRoute({ onSignOut }: { onSignOut: () => void }) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    onSignOut()
  }, [onSignOut])
  return (
    <section className="screen">
      <p className="muted">Signing out…</p>
    </section>
  )
}

function screenFor(path: string, props: ScreenProps) {
  const { user, onSessionExpired } = props
  const isAdmin = user.role === 'admin'

  if (path === '/') {
    return <LeadList key="leads" isSpam={false} onSessionExpired={onSessionExpired} />
  }
  if (path === '/spam') {
    // Keyed apart from the funnel list so switching views resets its filters
    // rather than carrying a stage filter into a screen that has no stages.
    return <LeadList key="spam" isSpam onSessionExpired={onSessionExpired} />
  }
  if (path === '/board') {
    return <FunnelBoard canConfigure={isAdmin} onSessionExpired={onSessionExpired} />
  }
  const settingsSection = sectionOf<SettingsSection>(
    SETTINGS_PATH.exec(path),
    SETTINGS_SECTIONS,
    isAdmin ? 'email' : 'notifications',
  )
  if (settingsSection !== undefined) {
    return <Settings section={settingsSection} isAdmin={isAdmin} onSessionExpired={onSessionExpired} />
  }
  const funnelSection = sectionOf<FunnelSection>(FUNNEL_PATH.exec(path), FUNNEL_SECTIONS, 'general')
  if (funnelSection !== undefined) {
    if (!isAdmin) {
      return (
        <section className="screen">
          <h1>Funnel settings</h1>
          <AdminOnly />
        </section>
      )
    }
    return <FunnelSettings section={funnelSection} onSessionExpired={onSessionExpired} />
  }
  if (path === '/leads/new') {
    return <NewLead onSessionExpired={onSessionExpired} />
  }
  if (path === '/install') {
    return <InstallHelper />
  }
  if (path === SIGN_OUT_PATH) {
    return <SignOutRoute onSignOut={props.onSignOut} />
  }

  const match = LEAD_PATH.exec(path)
  if (match?.[1] !== undefined) {
    const id = Number(match[1])
    // A path can hold a number too large to be an id; the API would 404 on it
    // anyway, but not every such string survives Number() as an integer.
    if (Number.isSafeInteger(id) && id > 0) {
      return (
        <LeadDetail
          key={id}
          leadId={id}
          currentUserId={user.id}
          onSessionExpired={onSessionExpired}
        />
      )
    }
  }

  return (
    <section className="screen">
      <h1>Not found</h1>
      <p>
        <Link to="/">Back to leads</Link>
      </p>
    </section>
  )
}

/**
 * The in-app stand-in for push (push.ts): the live stream is held for as long as
 * the signed-in app is open, whichever screen is showing.
 */
function useInAppNotifications(): void {
  const [on, setOn] = useState(isInAppNotificationsOn)

  useEffect(() => onInAppNotificationsChange(() => setOn(isInAppNotificationsOn())), [])

  useEffect(() => {
    if (!on) return
    const controller = new AbortController()
    void runInAppNotifications(controller.signal)
    return () => controller.abort()
  }, [on])
}

export function AppShell({ user, web = NO_HOST, signIn = NO_SIGN_IN, onSignOut, onSessionExpired }: AppShellProps) {
  const path = usePath()
  useInAppNotifications()
  // Not at /sign-out: the page is about to go, and a host loaded there would
  // only be torn down again.
  const host = useHost({
    web: path === SIGN_OUT_PATH ? NO_HOST : web,
    issuer: signIn.issuer,
    clientId: signIn.clientId,
    user,
    onSignOut,
  })
  // Read once per mount: neither the browser nor the dismissal changes under us,
  // and re-checking on every render would re-run the user-agent sniffing.
  const [offerInstall, setOfferInstall] = useState(
    () => shouldOfferInstall() && !isInstallPromptDismissed(),
  )

  function handleDismissInstall() {
    dismissInstallPrompt()
    setOfferInstall(false)
  }

  const tab = tabFor(path)

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">
          Philo
        </Link>
        <nav className="topnav" aria-label="Sections">
          <Link to="/" aria-current={tab === '/' ? 'page' : undefined}>
            Leads
          </Link>
          <Link to="/board" aria-current={tab === '/board' ? 'page' : undefined}>
            Board
          </Link>
          <Link to="/spam" aria-current={tab === '/spam' ? 'page' : undefined}>
            Spam
          </Link>
        </nav>
        <div className="topbar-actions">
          <FunnelSwitcher isAdmin={user.role === 'admin'} />
          <Link to="/leads/new" className="button-link new-lead" aria-label="New lead">
            <PlusIcon />
            <span className="new-lead-text">New lead</span>
          </Link>
          {!host.replacesAccountMenu && <AccountMenu user={user} onSignOut={onSignOut} />}
          {host.slotRef !== null && <div ref={host.slotRef} className="host-slot" />}
        </div>
      </header>
      <main>
        {offerInstall && path !== '/install' && (
          <p className="notice notice-warn install-banner">
            <span>Add Philo to your Home Screen to open it full screen and get notifications.</span>
            <Link to="/install">How</Link>
            <button type="button" onClick={handleDismissInstall}>
              Dismiss
            </button>
          </p>
        )}
        {screenFor(path, { user, onSignOut, onSessionExpired })}
      </main>
    </div>
  )
}
