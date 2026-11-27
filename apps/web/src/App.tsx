import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WebConfig } from '@philo/sdk'
import { AppShell, SIGN_OUT_PATH } from './AppShell.tsx'
import {
  accessRefusedMessage,
  beginSignIn,
  browser,
  CALLBACK_PATH,
  completeSignIn,
  fetchCurrentUser,
  finishSignOut,
  loadAuth,
  signInErrorMessage,
  signOut,
  type Auth,
  type User,
} from './auth.ts'
import { configureExtraTokens } from './extra-token.ts'
import { hostScriptLoaded, loadWebConfig } from './host.ts'
import { BrandMark } from './icons.tsx'
import { syncPushSubscription } from './push.ts'

type Screen =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'signed-out'; auth: Auth; error?: string }
  | { kind: 'ready'; auth: Auth; user: User; web: WebConfig }

/**
 * The URL is replaced rather than pushed: the callback's code is single-use, so
 * Back must never land on it again. The router hears nothing, which is fine —
 * the shell mounts after this and reads the path fresh.
 */
function leaveCallback(to: string): void {
  window.history.replaceState(null, '', to)
}

async function signedInScreen(auth: Auth, web: WebConfig): Promise<Screen> {
  let user: User | undefined
  try {
    user = await fetchCurrentUser(auth)
  } catch (error) {
    // Signed in at the IdP, refused here: saying so beats "unreachable", and
    // dropping the session lets "Try again" fetch a token that may now pass.
    const refused = accessRefusedMessage(error)
    if (refused === undefined) throw error
    auth.session.clear()
    return { kind: 'signed-out', auth, error: refused }
  }
  return user === undefined ? { kind: 'signed-out', auth } : { kind: 'ready', auth, user, web }
}

async function finishCallback(auth: Auth, web: WebConfig): Promise<Screen> {
  try {
    leaveCallback(await completeSignIn(auth))
  } catch (error) {
    leaveCallback('/')
    return { kind: 'signed-out', auth, error: signInErrorMessage(error) }
  }
  return signedInScreen(auth, web)
}

async function boot(): Promise<Screen> {
  finishSignOut()
  try {
    // Side by side, and never the reason boot fails: without it, there is
    // simply no host script (host.ts).
    const [auth, web] = await Promise.all([loadAuth(), loadWebConfig()])
    if (window.location.pathname === CALLBACK_PATH) return await finishCallback(auth, web)
    return await signedInScreen(auth, web)
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

  // Extra tokens belong to one sign-in: a fresh one clears their cache and
  // refusals, and leaving the signed-in shell drops them.
  useEffect(() => {
    if (screen.kind !== 'ready') return
    configureExtraTokens(screen.auth)
    return () => configureExtraTokens(undefined)
  }, [screen])

  const auth = screen.kind === 'ready' || screen.kind === 'signed-out' ? screen.auth : undefined

  // Signed out at `/sign-out`, there is nothing left to do there, and signing
  // in again must not come straight back to it.
  useEffect(() => {
    if (screen.kind === 'signed-out' && window.location.pathname === SIGN_OUT_PATH) leaveCallback('/')
  }, [screen])

  const handleSignOut = useCallback(async () => {
    if (auth === undefined) return
    // First, not on leaving the shell: sign-out may send the browser on to the
    // provider's end-session page, and nothing should be handed out meanwhile.
    configureExtraTokens(undefined)
    const left = await signOut(auth)
    // Nothing a host script left resident may outlive the person who signed
    // out (ADR-0013), so a page that loaded one starts again from scratch.
    if (!left && hostScriptLoaded()) {
      browser.assign('/')
      return
    }
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
      web={screen.web}
      signIn={screen.auth.config}
      onSignOut={() => void handleSignOut()}
      onSessionExpired={handleSessionExpired}
      onUserChanged={(user) => setScreen({ ...screen, user })}
    />
  )
}
