import { useState } from 'react'
import type { User } from './auth.ts'
import { FunnelBoard } from './FunnelBoard.tsx'
import { dismissInstallPrompt, isInstallPromptDismissed, shouldOfferInstall } from './install.ts'
import { InstallHelper } from './InstallHelper.tsx'
import { LeadDetail } from './LeadDetail.tsx'
import { LeadList } from './LeadList.tsx'
import { Link, usePath } from './router.tsx'

export interface AppShellProps {
  user: User
  onSignOut: () => void
  /** A 401 from any screen: the session ended, so hand back to the login screen. */
  onSessionExpired: () => void
}

const LEAD_PATH = /^\/leads\/(\d+)$/

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

export function AppShell({ user, onSignOut, onSessionExpired }: AppShellProps) {
  const path = usePath()
  // Read once per mount: neither the browser nor the dismissal changes under us,
  // and re-checking on every render would re-run the user-agent sniffing.
  const [offerInstall, setOfferInstall] = useState(
    () => shouldOfferInstall() && !isInstallPromptDismissed(),
  )

  function handleDismissInstall() {
    dismissInstallPrompt()
    setOfferInstall(false)
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">
          Philo
        </Link>
        <nav aria-label="Sections">
          {/* A lead has no section of its own, and is opened from both the list
              and the board, so its detail screen keeps Leads lit either way. */}
          <Link to="/" aria-current={path === '/spam' || path === '/board' ? undefined : 'page'}>
            Leads
          </Link>
          <Link to="/board" aria-current={path === '/board' ? 'page' : undefined}>
            Funnel
          </Link>
          <Link to="/spam" aria-current={path === '/spam' ? 'page' : undefined}>
            Spam
          </Link>
        </nav>
        <div className="session">
          <span className="muted">{user.name ?? user.email}</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
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
