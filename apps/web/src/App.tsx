import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppShell } from './AppShell.tsx'
import {
  beginSignIn,
  CALLBACK_PATH,
  completeSignIn,
  fetchCurrentUser,
  loadAuth,
  signInErrorMessage,
  signOut,
  type Auth,
  type User,
} from './auth.ts'
import { BrandMark } from './icons.tsx'
import { syncPushSubscription } from './push.ts'

type Screen =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'signed-out'; auth: Auth; error?: string }
  | { kind: 'ready'; auth: Auth; user: User }

/**
 * The URL is replaced rather than pushed: the callback's code is single-use, so
 * Back must never land on it again. The router hears nothing, which is fine —
 * the shell mounts after this and reads the path fresh.
 */
function leaveCallback(to: string): void {
  window.history.replaceState(null, '', to)
}

async function signedInScreen(auth: Auth): Promise<Screen> {
  const user = await fetchCurrentUser(auth)
  return user === undefined ? { kind: 'signed-out', auth } : { kind: 'ready', auth, user }
}

async function finishCallback(auth: Auth): Promise<Screen> {
  try {
    leaveCallback(await completeSignIn(auth))
  } catch (error) {
    leaveCallback('/')
    return { kind: 'signed-out', auth, error: signInErrorMessage(error) }
  }
  return signedInScreen(auth)
}

async function boot(): Promise<Screen> {
  try {
    const auth = await loadAuth()
    if (window.location.pathname === CALLBACK_PATH) return await finishCallback(auth)
    return await signedInScreen(auth)
  } catch {
    return { kind: 'unreachable' }
  }
}

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="auth-screen">
      <p className="auth-brand">
        <BrandMark />
        Philo
      </p>
      {children}
    </main>
  )
}

function SignedOut({ auth, error }: { auth: Auth; error: string | undefined }) {
  const [pending, setPending] = useState(false)

  function handleSignIn() {
    setPending(true)
    beginSignIn(auth).catch(() => setPending(false))
  }

  return (
    <AuthScreen>
      <section className="auth-card">
        <div className="auth-head">
          <h1>{error === undefined ? 'Sign in' : 'Sign-in failed'}</h1>
          {error === undefined && (
            <p className="muted">You’ll come straight back to this page once you’ve signed in.</p>
          )}
        </div>
        {/* `role="alert"` so a failure is announced, not just recoloured. */}
        {error !== undefined && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="primary" onClick={handleSignIn} disabled={pending}>
          {error === undefined ? 'Sign in' : 'Try again'}
        </button>
      </section>
    </AuthScreen>
  )
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  // Once per page load, even under StrictMode's double effect: the callback's
  // code can be spent only once, and a second exchange would report a failure
  // over the top of the sign-in that just worked.
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void boot().then(setScreen)
  }, [])

  // The service worker re-subscribes on its own when the browser rotates a
  // subscription, but holds no token to tell the server with (src/sw.js), so
  // every signed-in load re-registers whatever this browser has.
  const signedIn = screen.kind === 'ready'
  useEffect(() => {
    if (signedIn) void syncPushSubscription()
  }, [signedIn])

  const auth = screen.kind === 'ready' || screen.kind === 'signed-out' ? screen.auth : undefined

  const handleSignOut = useCallback(async () => {
    if (auth === undefined) return
    await signOut(auth)
    setScreen({ kind: 'signed-out', auth })
  }, [auth])

  /**
   * A 401 from a screen behind the shell. The token was refused, so it is
   * dropped rather than kept to be refused again.
   */
  const handleSessionExpired = useCallback(() => {
    if (auth === undefined) return
    auth.session.clear()
    setScreen({ kind: 'signed-out', auth })
  }, [auth])

  if (screen.kind === 'loading') {
    return (
      <AuthScreen>
        <p className="muted">Loading…</p>
      </AuthScreen>
    )
  }

  if (screen.kind === 'unreachable') {
    return (
      <AuthScreen>
        <section className="auth-card">
          <h1>Connection problem</h1>
          <p className="notice notice-error" role="alert">
            Could not reach the server. Check your connection and try again.
          </p>
          <button type="button" className="primary" onClick={() => void boot().then(setScreen)}>
            Retry
          </button>
        </section>
      </AuthScreen>
    )
  }

  if (screen.kind === 'signed-out') return <SignedOut auth={screen.auth} error={screen.error} />

  return (
    <AppShell
      user={screen.user}
      onSignOut={() => void handleSignOut()}
      onSessionExpired={handleSessionExpired}
    />
  )
}
