import { useEffect, useState } from 'react'
import { AccountMenu } from './AccountMenu.tsx'
import type { User } from './auth.ts'
import { FunnelBoard } from './FunnelBoard.tsx'
import { FUNNEL_SECTIONS, FunnelSettings, type FunnelSection } from './FunnelSettings.tsx'
import { FunnelSwitcher } from './FunnelSwitcher.tsx'
import { PlusIcon } from './icons.tsx'
import { dismissInstallPrompt, isInstallPromptDismissed, shouldOfferInstall } from './install.ts'
import { InstallHelper } from './InstallHelper.tsx'
import { LeadDetail } from './LeadDetail.tsx'
import { LeadList } from './LeadList.tsx'
import { NewLead } from './NewLead.tsx'
import { isInAppNotificationsOn, onInAppNotificationsChange, runInAppNotifications } from './push.ts'
import { Link, usePath } from './router.tsx'
import { SETTINGS_SECTIONS, Settings, type SettingsSection } from './Settings.tsx'

export interface AppShellProps {
  user: User
  onSignOut: () => void
  /** A 401 from any screen: the session ended, so hand back to the sign-in screen. */
  onSessionExpired: () => void
}

const LEAD_PATH = /^\/leads\/(\d+)$/
const SETTINGS_PATH = /^\/settings(?:\/([\w-]+))?$/
const FUNNEL_PATH = /^\/funnel(?:\/([\w-]+))?$/

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

function screenFor(path: string, props: Omit<AppShellProps, 'onSignOut'>) {
  const { user, onSessionExpired } = props

  if (path === '/') {
    return <LeadList key="leads" isSpam={false} onSessionExpired={onSessionExpired} />
  }
  if (path === '/spam') {
    // Keyed apart from the funnel list so switching views resets its filters
    // rather than carrying a stage filter into a screen that has no stages.
    return <LeadList key="spam" isSpam onSessionExpired={onSessionExpired} />
  }
  if (path === '/board') {
    return <FunnelBoard onSessionExpired={onSessionExpired} />
  }
  const settingsSection = sectionOf<SettingsSection>(SETTINGS_PATH.exec(path), SETTINGS_SECTIONS, 'email')
  if (settingsSection !== undefined) {
    return <Settings section={settingsSection} onSessionExpired={onSessionExpired} />
  }
  const funnelSection = sectionOf<FunnelSection>(FUNNEL_PATH.exec(path), FUNNEL_SECTIONS, 'general')
  if (funnelSection !== undefined) {
    return <FunnelSettings section={funnelSection} onSessionExpired={onSessionExpired} />
  }
  if (path === '/leads/new') {
    return <NewLead onSessionExpired={onSessionExpired} />
  }
  if (path === '/install') {
    return <InstallHelper />
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

export function AppShell({ user, onSignOut, onSessionExpired }: AppShellProps) {
  const path = usePath()
  useInAppNotifications()
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
          <FunnelSwitcher />
          <Link to="/leads/new" className="button-link new-lead" aria-label="New lead">
            <PlusIcon />
            <span className="new-lead-text">New lead</span>
          </Link>
          <AccountMenu user={user} onSignOut={onSignOut} />
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
        {screenFor(path, { user, onSessionExpired })}
      </main>
    </div>
  )
}
