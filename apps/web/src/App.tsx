import { useCallback, useEffect, useRef, useState } from 'react'
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

function SignedOut({ auth, error }: { auth: Auth; error: string | undefined }) {
  const [pending, setPending] = useState(false)

  function handleSignIn() {
    setPending(true)
    beginSignIn(auth).catch(() => setPending(false))
  }

  return (
    <main>
      <section className="auth-form">
        <h1>{error === undefined ? 'Sign in' : 'Sign-in failed'}</h1>
        {/* `role="alert"` so a failure is announced, not just recoloured. */}
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="button" onClick={handleSignIn} disabled={pending}>
          {error === undefined ? 'Sign in' : 'Try again'}
        </button>
      </section>
    </main>
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
      <main>
        <p>Loading…</p>
      </main>
    )
  }

  if (screen.kind === 'unreachable') {
    return (
      <main>
        <h1>Philo</h1>
        <p role="alert">Could not reach the server.</p>
        <button type="button" onClick={() => void boot().then(setScreen)}>
          Retry
        </button>
      </main>
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
