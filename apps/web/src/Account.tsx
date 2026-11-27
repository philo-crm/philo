import { useCallback, useState, type FormEvent } from 'react'
import {
  changePassword,
  fetchAccount,
  peopleErrorMessage,
  updateAccount,
  MAX_PERSON_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  type Account as AccountRecord,
  type AccountPatch,
} from './api.ts'
import { SettingsCard } from './SettingsLayout.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface AccountProps {
  /** Your name or email changed: the account menu shows the new one. */
  onAccountChanged: (account: AccountRecord) => void
  onSessionExpired: () => void
}

const ROLE_TEXT = {
  admin: 'You are an admin: you work every lead, and also configure the instance and manage people.',
  user: 'You are a user: you work every lead in every funnel. An admin configures the instance and manages people.',
} as const

/** Your own account — ADR-0012: name, email and password, and which role you hold. */
export function Account({ onAccountChanged, onSessionExpired }: AccountProps) {
  const load = useCallback((signal: AbortSignal) => fetchAccount(signal), [])
  const account = useResource(load)
  useSessionGuard(account.error, onSessionExpired)

  const saved = (next: AccountRecord) => {
    account.set(next)
    onAccountChanged(next)
  }

  return (
    <section className="screen screen-narrow">
      <header className="screen-head">
        <h1>Your account</h1>
      </header>
      {account.data === undefined ? (
        account.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {peopleErrorMessage(account.error)}
          </p>
        )
      ) : (
        <>
          <p className="muted">{ROLE_TEXT[account.data.role]}</p>
          <ProfileForm initial={account.data} onSaved={saved} onSessionExpired={onSessionExpired} />
          {!account.data.managedByIdp && <PasswordForm onSessionExpired={onSessionExpired} />}
        </>
      )}
    </section>
  )
}

interface ProfileFormProps {
  /** What the server holds now: the boxes start from it and are compared against it. */
  initial: AccountRecord
  onSaved: (account: AccountRecord) => void
  onSessionExpired: () => void
}

function ProfileForm({ initial, onSaved, onSessionExpired }: ProfileFormProps) {
  const [name, setName] = useState(initial.name ?? '')
  const [email, setEmail] = useState(initial.email)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)
  useSessionGuard(error, onSessionExpired)

  const nameChanged = name.trim() !== (initial.name ?? '')
  const emailChanged = !initial.managedByIdp && email.trim().toLowerCase() !== initial.email
  const ready = (nameChanged || emailChanged) && (!emailChanged || password !== '')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy) return
    const patch: AccountPatch = {}
    if (nameChanged) patch.name = name.trim() === '' ? null : name.trim()
    if (emailChanged) {
      patch.email = email.trim()
      patch.currentPassword = password
    }
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    updateAccount(patch).then(
      (next) => {
        setBusy(false)
        setStatus('Saved.')
        setName(next.name ?? '')
        setEmail(next.email)
        // Spent: it is not left sitting in the box.
        setPassword('')
        onSaved(next)
      },
      (caught: unknown) => {
        setBusy(false)
        setError(caught)
      },
    )
  }

  return (
    <>
      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {peopleErrorMessage(error)}
        </p>
      )}
      {status !== undefined && (
        <p className="notice notice-ok" role="status">
          {status}
        </p>
      )}
      <form className="panel settings-cards" aria-label="Your details" onSubmit={handleSubmit}>
        <SettingsCard
          title="Details"
          description={
            initial.managedByIdp
              ? 'Your email and password are managed by your identity provider. Change them there.'
              : 'Your colleagues see your name on the timeline. You sign in with your email.'
          }
        >
          <label className="field">
            <span className="field-label">Name</span>
            <input
              value={name}
              autoComplete="name"
              maxLength={MAX_PERSON_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              readOnly={initial.managedByIdp}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {emailChanged && (
            <div className="field">
              <label className="field-label" htmlFor="account-email-password">
                Password
              </label>
              <input
                id="account-email-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <span className="hint">Your current password, to confirm the new email.</span>
            </div>
          )}
        </SettingsCard>
        <div className="form-footer">
          <button type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </>
  )
}

function PasswordForm({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [mismatch, setMismatch] = useState(false)
  const [done, setDone] = useState(false)
  useSessionGuard(error, onSessionExpired)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(undefined)
    setDone(false)
    if (next !== repeat) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    setBusy(true)
    changePassword(current, next).then(
      () => {
        setBusy(false)
        setDone(true)
        setCurrent('')
        setNext('')
        setRepeat('')
      },
      (caught: unknown) => {
        setBusy(false)
        setError(caught)
      },
    )
  }

  return (
    <>
      {(error !== undefined || mismatch) && (
        <p className="notice notice-error" role="alert">
          {mismatch ? 'The new passwords do not match.' : peopleErrorMessage(error)}
        </p>
      )}
      {done && (
        <p className="notice notice-ok" role="status">
          Password changed. Your other sessions and connected apps are signed out.
        </p>
      )}
      <form className="panel settings-cards" aria-label="Change password" onSubmit={handleSubmit}>
        <SettingsCard
          title="Password"
          description={`At least ${MIN_PASSWORD_LENGTH} characters. Changing it signs you out everywhere else.`}
        >
          <label className="field">
            <span className="field-label">Current password</span>
            <input
              type="password"
              name="current-password"
              value={current}
              autoComplete="current-password"
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">New password</span>
            <input
              type="password"
              value={next}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              onChange={(event) => setNext(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">New password again</span>
            <input
              type="password"
              value={repeat}
              autoComplete="new-password"
              onChange={(event) => setRepeat(event.target.value)}
            />
          </label>
        </SettingsCard>
        <div className="form-footer">
          <button type="submit" disabled={busy || current === '' || next === '' || repeat === ''}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </>
  )
}
