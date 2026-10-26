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
import { EmailTemplates } from './EmailTemplates.tsx'
import { funnelsChanged, selectFunnel, useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { IntakeDetails } from './IntakeDetails.tsx'
import { Link, navigate } from './router.tsx'
import { SettingsCard, SettingsLayout, SettingsSection } from './SettingsLayout.tsx'
import { useSessionGuard } from './useResource.ts'

/**
 * A funnel's own settings — ADR-0009: one per intake flow, each with its own
 * stages, form, templates and the sender overrides below. The mail server,
 * From address and business name are the server's, under Server settings.
 */
export const FUNNEL_SECTIONS = {
  general: 'General',
  form: 'Website form',
  emails: 'Email templates',
} as const

export type FunnelSection = keyof typeof FUNNEL_SECTIONS

function funnelPath(section: FunnelSection): string {
  return section === 'general' ? '/funnel' : `/funnel/${section}`
}

const FUNNEL_NAV = (Object.keys(FUNNEL_SECTIONS) as FunnelSection[]).map((section) => ({
  to: funnelPath(section),
  label: FUNNEL_SECTIONS[section],
}))

export interface FunnelSettingsProps {
  section?: FunnelSection
  onSessionExpired: () => void
}

/** The selected funnel's settings. Which funnel is chosen in the top bar. */
export function FunnelSettings({ section = 'general', onSessionExpired }: FunnelSettingsProps) {
  const funnels = useFunnels()
  const [funnelId] = useSelectedFunnel(funnels.data)
  useSessionGuard(funnels.error, onSessionExpired)
  const list = funnels.data ?? []
  const funnel = list.find((candidate) => candidate.id === funnelId)

  function handleChanged() {
    funnels.reload()
    funnelsChanged()
  }

  return (
    <SettingsLayout
      title={funnel === undefined ? 'Funnel settings' : `${funnel.name} funnel`}
      description="Settings for this funnel only. Switch funnels from the top bar."
      nav={FUNNEL_NAV}
      current={funnelPath(section)}
    >
      {funnel === undefined ? (
        funnels.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {funnelErrorMessage(funnels.error)}
          </p>
        )
      ) : (
        <>
          {section === 'general' && (
            <FunnelEditor
              key={funnel.id}
              funnel={funnel}
              deletable={list.length > 1 && funnel.leadCount === 0}
              lastFunnel={list.length <= 1}
              onChanged={handleChanged}
            />
          )}
          {section === 'form' && (
            <SettingsSection
              title="Website form"
              description="Where this funnel's leads come from. Each funnel has its own address, so the address alone says which funnel a lead lands in."
            >
              {funnel.forms.map((form) => (
                <div key={form.id} className="panel">
                  <IntakeDetails form={form} />
                </div>
              ))}
            </SettingsSection>
          )}
          {section === 'emails' && (
            <EmailTemplates key={funnel.id} funnelId={funnel.id} onSessionExpired={onSessionExpired} />
          )}
        </>
      )}
    </SettingsLayout>
  )
}

function openSettings(funnel: FunnelRecord) {
  selectFunnel(funnel.id)
  navigate('/funnel')
}

/** Every funnel on the server, and the way to add one. */
export function FunnelList({ onSessionExpired }: { onSessionExpired: () => void }) {
  const funnels = useFunnels()
  const [selectedId] = useSelectedFunnel(funnels.data)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)
  useSessionGuard(funnels.error ?? error, onSessionExpired)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    if (busy || name === '') return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      const created = await createFunnel(name)
      setNewName('')
      setStatus(`${created.name} added.`)
      funnels.reload()
      funnelsChanged()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const failure = funnels.error ?? error

  return (
    <SettingsSection
      title="Funnels"
      description="One funnel per intake flow. Each has its own stages, website form and email templates, and may override the sender name, reply-to and who is notified."
    >
      {failure !== undefined && (
        <p className="notice notice-error" role="alert">
          {funnelErrorMessage(failure)}
        </p>
      )}
      {status !== undefined && (
        <p className="notice notice-ok" role="status">
          {status}
        </p>
      )}

      {funnels.data === undefined ? (
        funnels.error === undefined && <p className="empty">Loading…</p>
      ) : (
        <ul className="panel row-list" aria-label="Funnels">
          {funnels.data.map((funnel) => (
            <li key={funnel.id} className="row-list-item">
              <div className="row-list-main">
                <span className="row-list-title">
                  {funnel.name}
                  {funnel.isDefault && <span className="tag">Default</span>}
                  {funnel.id === selectedId && <span className="tag tag-accent">Selected</span>}
                </span>
                <span className="hint numeric">
                  {funnel.leadCount} {funnel.leadCount === 1 ? 'lead' : 'leads'}
                </span>
              </div>
              <button type="button" aria-label={`Open ${funnel.name} settings`} onClick={() => openSettings(funnel)}>
                Settings
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="panel inline-form" aria-label="Add a funnel" onSubmit={(event) => void handleCreate(event)}>
        <label className="field field-grow">
          <span className="field-label">New funnel</span>
          <input
            value={newName}
            placeholder="Funnel name"
            maxLength={MAX_FUNNEL_NAME_LENGTH}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || newName.trim() === ''}>
          Add funnel
        </button>
        <p className="hint inline-form-hint">Starts with the default stages, both email templates and its own website form.</p>
      </form>
    </SettingsSection>
  )
}

interface FunnelEditorProps {
  /** Read once, at mount. Everything after that is the editor's own state. */
  funnel: FunnelRecord
  deletable: boolean
  lastFunnel: boolean
  onChanged: () => void
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address !== '')
}

function FunnelEditor({ funnel, deletable, lastFunnel, onChanged }: FunnelEditorProps) {
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
    if (!window.confirm(`Delete the ${funnel.name} funnel? Its website form stops accepting submissions.`)) return
    void run(() => deleteFunnel(funnel.id), 'Funnel deleted.')
  }

  return (
    <SettingsSection title="General">
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

      <form className="panel settings-cards" aria-label={`${funnel.name} funnel`} onSubmit={handleSave}>
        <SettingsCard
          title="Name"
          description={
            <>
              Holds {funnel.leadCount} {funnel.leadCount === 1 ? 'lead' : 'leads'}.
              {funnel.isDefault && ' The default funnel.'} Stages are edited on the{' '}
              <Link to="/board">board</Link>.
            </>
          }
        >
          <label className="field">
            <span className="field-label">Funnel name</span>
            <input value={name} maxLength={MAX_FUNNEL_NAME_LENGTH} onChange={(event) => setName(event.target.value)} />
          </label>
        </SettingsCard>
        <SettingsCard
          title="Sender"
          description="Overrides for email about this funnel's leads. Leave a box blank to use the server's settings."
        >
          <label className="field">
            <span className="field-label">From name for this funnel</span>
            <input
              value={fromName}
              placeholder="Same as the server"
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
              placeholder="Same as the server"
              onChange={(event) => setReplyTo(event.target.value)}
            />
          </label>
        </SettingsCard>
        <SettingsCard title="Who is notified" description="One address per line. Leave empty to notify everyone who can sign in.">
          <label className="field">
            <span className="field-label">Notify about new leads</span>
            <textarea
              value={recipients}
              rows={3}
              placeholder="Everyone who can sign in"
              onChange={(event) => setRecipients(event.target.value)}
            />
          </label>
        </SettingsCard>
        <div className="form-footer">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save funnel'}
          </button>
        </div>
      </form>

      <div className="panel danger-zone">
        <div>
          <h3>Delete this funnel</h3>
          <p className="hint">
            {deletable
              ? 'Its stages, templates and website form go with it.'
              : lastFunnel
                ? 'The server keeps its last funnel.'
                : 'Only an empty funnel can be deleted. Move or delete its leads first.'}
          </p>
        </div>
        {deletable && (
          <button type="button" className="danger" disabled={busy} onClick={handleDelete}>
            Delete funnel
          </button>
        )}
      </div>
    </SettingsSection>
  )
}
