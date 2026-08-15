import { useCallback, useState, type FormEvent } from 'react'
import {
  apiKeyErrorMessage,
  createApiKey,
  fetchApiKeys,
  revokeApiKey,
  MAX_API_KEY_NAME_LENGTH,
  type ApiKeyRecord,
} from './api.ts'
import { formatDateTime } from './format.ts'
import { useResource, useSessionGuard } from './useResource.ts'

export interface ApiKeysProps {
  onSessionExpired: () => void
}

export function ApiKeys({ onSessionExpired }: ApiKeysProps) {
  const load = useCallback((signal: AbortSignal) => fetchApiKeys(signal), [])
  const keys = useResource(load)
  useSessionGuard(keys.error, onSessionExpired)

  const [name, setName] = useState('')
  /** The secret, from the one response that carries it. Never refetched. */
  const [secret, setSecret] = useState<string | undefined>(undefined)
  /** Which key the Revoke button is waiting for a second click on. */
  const [confirming, setConfirming] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)

  useSessionGuard(error, onSessionExpired)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (name.trim() === '') return
    void run(async () => {
      const created = await createApiKey(name.trim())
      setSecret(created.secret)
      setName('')
      keys.set([created.key, ...(keys.data ?? [])])
    })
  }

  function handleRevoke(key: ApiKeyRecord) {
    if (confirming !== key.id) {
      setConfirming(key.id)
      return
    }
    setConfirming(undefined)
    void run(async () => {
      await revokeApiKey(key.id)
      keys.set((keys.data ?? []).filter((row) => row.id !== key.id))
      // A revoked key's secret must not stay on screen implying it still works.
      setSecret(undefined)
    })
  }

  return (
    <section className="screen">
      {/* h2 rather than h1: this sits under the Settings screen's own heading. */}
      <header className="screen-head">
        <h2>API keys</h2>
      </header>

      <p className="hint">
        For scripts, cron jobs and AI agents. Send one as{' '}
        <code>Authorization: Bearer philo_…</code>. A key can read and change leads, the funnel, and
        your email templates — so it can write what Philo sends out under your business&rsquo;s name.
        It cannot sign in, manage keys, or see your mail server settings. Give one only to something
        you would trust with the leads themselves.
      </p>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {apiKeyErrorMessage(error)}
        </p>
      )}

      {secret !== undefined && <NewSecret secret={secret} onDismiss={() => setSecret(undefined)} />}

      <form className="panel key-form" onSubmit={handleCreate}>
        <label className="field">
          <span className="field-label">What is this key for?</span>
          <input
            value={name}
            maxLength={MAX_API_KEY_NAME_LENGTH}
            autoComplete="off"
            placeholder="Claude Code on my laptop"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="settings-actions">
          <button type="submit" disabled={busy || name.trim() === ''}>
            {busy ? 'Working…' : 'Create key'}
          </button>
          <span className="hint">The key is shown once, when it is created.</span>
        </div>
      </form>

      {keys.data === undefined ? (
        keys.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {apiKeyErrorMessage(keys.error)}
          </p>
        )
      ) : keys.data.length === 0 ? (
        <p className="empty">No API keys yet.</p>
      ) : (
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>
                    <code>{key.keyPrefix}…</code>
                  </td>
                  <td>{formatDateTime(key.createdAt)}</td>
                  <td>{key.lastUsedAt === null ? 'Never' : formatDateTime(key.lastUsedAt)}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={
                        confirming === key.id ? `Confirm revoking ${key.name}` : `Revoke ${key.name}`
                      }
                      disabled={busy}
                      onClick={() => handleRevoke(key)}
                    >
                      {confirming === key.id ? 'Confirm revoke' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * The secret, the only time it exists anywhere but the caller's hands. Readonly
 * rather than plain text so it can be selected and copied on a phone, and
 * dismissable so it does not sit on a shared screen for the rest of the session.
 */
function NewSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    // Absent on http origins other than localhost, which is a deployment
    // DESIGN.md allows — so the box above stays the way that always works.
    void navigator.clipboard?.writeText(secret).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <div className="notice notice-ok new-key" role="status">
      <p>Copy this key now. It is not stored anywhere it can be read again.</p>
      <label className="field">
        <span className="field-label">New API key</span>
        <input
          className="new-key-secret"
          readOnly
          value={secret}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="settings-actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  )
}
