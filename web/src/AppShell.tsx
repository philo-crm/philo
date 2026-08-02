import type { User } from './auth.ts'
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
  const isSpam = path === '/spam'

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">
          Philo
        </Link>
        <nav aria-label="Sections">
          <Link to="/" aria-current={isSpam ? undefined : 'page'}>
            Leads
          </Link>
          <Link to="/spam" aria-current={isSpam ? 'page' : undefined}>
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
      <main>{screenFor(path, { user, onSessionExpired })}</main>
    </div>
  )
}
