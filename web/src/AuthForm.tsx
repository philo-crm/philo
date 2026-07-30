import { useState, type FormEvent } from 'react'
import { AuthError, MIN_PASSWORD_LENGTH, submitLogin, submitSetup, type User } from './auth.ts'

interface AuthFormProps {
  /** Setup collects a confirmation and a name; login does not. */
  mode: 'setup' | 'login'
  onAuthenticated: (user: User) => void
  /**
   * Called when the server says setup is already done — someone else claimed the
   * account first. Without this the screen would sit there repeating a 409.
   */
  onSetupSuperseded?: () => void
}

function messageFor(error: unknown): string {
  if (error instanceof AuthError) return error.message
  return 'Could not reach the server. Check your connection and try again.'
}

export function AuthForm({ mode, onAuthenticated, onSetupSuperseded }: AuthFormProps) {
  const isSetup = mode === 'setup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    if (isSetup && password !== confirmation) {
      setError('Those passwords do not match.')
      return
    }
    if (isSetup && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }

    setError(null)
    setPending(true)
    try {
      const trimmedName = name.trim()
      const user = isSetup
        ? await submitSetup(trimmedName === '' ? { email, password } : { email, password, name: trimmedName })
        : await submitLogin({ email, password })
      onAuthenticated(user)
    } catch (caught) {
      if (caught instanceof AuthError && caught.status === 409 && onSetupSuperseded !== undefined) {
        onSetupSuperseded()
        return
      }
      setError(messageFor(caught))
      setPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h1>{isSetup ? 'Set up Philo' : 'Sign in'}</h1>
      <p>
        {isSetup
          ? 'Create the account for this instance. It is the only one, so keep the password somewhere safe.'
          : 'Enter your email and password.'}
      </p>

      <label>
        Email
        <input
          type="email"
          name="email"
          value={email}
          autoComplete="username"
          required
          autoFocus
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label>
        Password
        <input
          type="password"
          name="password"
          value={password}
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          required
          minLength={isSetup ? MIN_PASSWORD_LENGTH : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      {isSetup && (
        <>
          <label>
            Confirm password
            <input
              type="password"
              name="confirmation"
              value={confirmation}
              autoComplete="new-password"
              required
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <label>
            Your name <span>(optional)</span>
            <input
              type="text"
              name="name"
              value={name}
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </>
      )}

      {/* `role="alert"` so a failure is announced, not just recoloured. */}
      {error !== null && <p role="alert">{error}</p>}

      <button type="submit" disabled={pending}>
        {pending ? 'Working…' : isSetup ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
