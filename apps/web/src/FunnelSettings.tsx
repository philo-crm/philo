import { useState, type FormEvent } from 'react'
import {
  createFunnel,
  deleteFunnel,
  funnelErrorMessage,
  updateFunnel,
  MAX_FUNNEL_NAME_LENGTH,
  MAX_SETTINGS_NAME_LENGTH,
  type FunnelRecord,
} from './api.ts'
import { useFunnels } from './FunnelPicker.tsx'
import { useSessionGuard } from './useResource.ts'

export interface FunnelSettingsProps {
  onSessionExpired: () => void
}

/**
 * Funnels — ADR-0009: one per intake flow, each with its own stages, forms,
 * templates and the sender settings below. The mail server, From address and
 * business name above are the instance's and shared by all of them.
 */
export function FunnelSettings({ onSessionExpired }: FunnelSettingsProps) {
  const funnels = useFunnels()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  useSessionGuard(funnels.error ?? error, onSessionExpired)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    if (busy || name === '') return
    setBusy(true)
    setError(undefined)
    try {
      await createFunnel(name)
      setNewName('')
      funnels.reload()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const list = funnels.data ?? []

  return (
    <section className="screen">
      <header className="screen-head">
        <h2>Funnels</h2>
      </header>
      <p className="hint">
        One funnel per intake flow. Each has its own stages, intake form and email templates, and may
        override the sender name, reply-to and who is notified. Leave an override blank to use the
        settings above.
      </p>

      {(funnels.error ?? error) !== undefined && (
        <p className="notice notice-error" role="alert">
          {funnelErrorMessage(funnels.error ?? error)}
        </p>
      )}

      {funnels.data === undefined && funnels.error === undefined && <p className="empty">Loading…</p>}

      {list.map((funnel) => (
        <FunnelEditor
          key={funnel.id}
          funnel={funnel}
          deletable={list.length > 1 && funnel.leadCount === 0}
          onChanged={funnels.reload}
        />
      ))}

      <form className="panel stage-form" aria-label="Add a funnel" onSubmit={(event) => void handleCreate(event)}>
        <label className="field">
          <span className="field-label">New funnel</span>
          <input
            value={newName}
            placeholder="Funnel name"
            maxLength={MAX_FUNNEL_NAME_LENGTH}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <div className="settings-actions">
          <button type="submit" disabled={busy || newName.trim() === ''}>
            Add funnel
          </button>
          <span className="hint">Starts with the default stages, both templates and its own intake form.</span>
        </div>
      </form>
    </section>
  )
}

interface FunnelEditorProps {
  /** Read once, at mount. Everything after that is the editor's own state. */
  funnel: FunnelRecord
  deletable: boolean
  onChanged: () => void
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address !== '')
}

function FunnelEditor({ funnel, deletable, onChanged }: FunnelEditorProps) {
  const [name, setName] = useState(funnel.name)
  const [fromName, setFromName] = useState(funnel.fromName)
  const [replyTo, setReplyTo] = useState(funnel.replyTo)
  const [recipients, setRecipients] = useState(funnel.notifyRecipients.join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      await action()
      setStatus(done)
      onChanged()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(
      () => updateFunnel(funnel.id, { name, fromName, replyTo, notifyRecipients: parseRecipients(recipients) }),
      'Funnel saved.',
    )
  }

  function handleDelete() {
    if (!window.confirm(`Delete the ${funnel.name} funnel? Its intake form stops accepting submissions.`)) return
    void run(() => deleteFunnel(funnel.id), 'Funnel deleted.')
  }

  return (
    <form className="panel" aria-label={`${funnel.name} funnel`} onSubmit={handleSave}>
      <h3>
        {funnel.name}
        {funnel.isDefault && <> <span className="tag">Default</span></>}
      </h3>
      <p className="hint">
        {funnel.leadCount} {funnel.leadCount === 1 ? 'lead' : 'leads'}.
      </p>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {funnelErrorMessage(error)}
        </p>
      )}
      {status !== undefined && (
        <p className="notice notice-ok" role="status">
          {status}
        </p>
      )}

      <div className="fields">
        <label className="field">
          <span className="field-label">Funnel name</span>
          <input value={name} maxLength={MAX_FUNNEL_NAME_LENGTH} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">From name for this funnel</span>
          <input
            value={fromName}
            placeholder="Same as above"
            maxLength={MAX_SETTINGS_NAME_LENGTH}
            onChange={(event) => setFromName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Reply-to for this funnel</span>
          <input
            type="email"
            value={replyTo}
            autoComplete="off"
            placeholder="Same as above"
            onChange={(event) => setReplyTo(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Notify about new leads</span>
          <textarea
            value={recipients}
            rows={3}
            placeholder="Everyone who can sign in"
            onChange={(event) => setRecipients(event.target.value)}
          />
        </label>
        <p className="hint">One address per line.</p>
        {funnel.forms.map((form) => (
          <p key={form.id} className="field">
            <span className="field-label">Intake URL</span>
            <code className="intake-url">{form.intakeUrl}</code>
          </p>
        ))}
      </div>

      <div className="settings-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save funnel'}
        </button>
        {deletable && (
          <button type="button" disabled={busy} onClick={handleDelete}>
            Delete funnel
          </button>
        )}
      </div>
    </form>
  )
}
