import { useCallback, useEffect, useState } from 'react'
import { AppShell } from './AppShell.tsx'
import { AuthForm } from './AuthForm.tsx'
import { fetchCurrentUser, fetchStatus, submitLogout, type User } from './auth.ts'

type Screen =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready'; user: User }

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })

  /**
   * Ask for the session first: signed in is the common case and costs one
   * request. Only an anonymous caller needs `status` to tell a fresh instance
   * that has never been set up from one that just wants a login.
   */
  const resolveScreen = useCallback(async (signal?: AbortSignal): Promise<Screen> => {
    try {
      const user = await fetchCurrentUser(signal)
      if (user !== undefined) return { kind: 'ready', user }
      const status = await fetchStatus(signal)
      return status.needsSetup ? { kind: 'setup' } : { kind: 'login' }
    } catch {
      return { kind: 'unreachable' }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    resolveScreen(controller.signal).then((next) => {
      if (!controller.signal.aborted) setScreen(next)
    })
    return () => controller.abort()
  }, [resolveScreen])

  const handleAuthenticated = useCallback((user: User) => setScreen({ kind: 'ready', user }), [])

  const handleLogout = useCallback(async () => {
    // The cookie is httpOnly, so only the server can end the session; on a
    // failed request the safe thing is still to stop showing signed-in state.
    await submitLogout().catch(() => undefined)
    setScreen(await resolveScreen())
  }, [resolveScreen])

  /**
   * A 401 from a screen behind the shell. Straight to login rather than back
   * through `resolveScreen`: an instance that has handed out a session cannot
   * be one that still needs setup, so there is nothing left to ask the server.
   */
  const handleSessionExpired = useCallback(() => setScreen({ kind: 'login' }), [])

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
        <button type="button" onClick={() => void resolveScreen().then(setScreen)}>
          Retry
        </button>
      </main>
    )
  }

  if (screen.kind === 'setup') {
    return (
      <main>
        <AuthForm
          mode="setup"
          onAuthenticated={handleAuthenticated}
          onSetupSuperseded={() => setScreen({ kind: 'login' })}
        />
      </main>
    )
  }

  if (screen.kind === 'login') {
    return (
      <main>
        <AuthForm mode="login" onAuthenticated={handleAuthenticated} />
      </main>
    )
  }

  return (
    <AppShell
      user={screen.user}
      onSignOut={() => void handleLogout()}
      onSessionExpired={handleSessionExpired}
    />
  )
}
