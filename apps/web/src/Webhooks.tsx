import { useCallback, useState, type FormEvent } from 'react'
import {
  CHANGE_TYPES,
  createWebhook,
  deleteWebhook,
  fetchWebhooks,
  testWebhook,
  webhookErrorMessage,
  type ChangeType,
  type WebhookDelivery,
  type WebhookRecord,
} from './api.ts'
import { formatDateTime } from './format.ts'
import { useFunnels } from './FunnelPicker.tsx'
import { CopyButton } from './IntakeDetails.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface WebhooksProps {
  onSessionExpired: () => void
}

const ALL_FUNNELS = 'all'

/** What each change type means, in the words of someone wiring up an automation. */
const CHANGE_LABELS: Record<ChangeType, string> = {
  'lead.created': 'A lead arrives or is added',
  'lead.updated': 'A lead is edited, noted or given a file',
  'lead.stage_changed': 'A lead moves stage',
  'lead.deleted': 'A lead is deleted',
  'funnel.changed': 'A funnel or its stages change',
}

function describeDelivery(delivery: WebhookDelivery | null): string {
  if (delivery === null) return 'Not yet'
  const outcome = delivery.ok ? `OK (${delivery.status})` : (delivery.error ?? 'Failed')
  return `${outcome}, ${formatDateTime(delivery.at)}`
}

/**
 * Webhooks — ADR-0010: each change posted to a URL as it happens, for every
 * funnel or one, signed with a secret shown once.
 */
export function Webhooks({ onSessionExpired }: WebhooksProps) {
  const load = useCallback((signal: AbortSignal) => fetchWebhooks(signal), [])
  const hooks = useResource(load)
  const funnels = useFunnels()

  const [url, setUrl] = useState('')
  const [scope, setScope] = useState(ALL_FUNNELS)
  const [events, setEvents] = useState<ChangeType[]>([])
  const [secret, setSecret] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<number | undefined>(undefined)
  const [tested, setTested] = useState<{ id: number; delivery: WebhookDelivery } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  useSessionGuard(hooks.error ?? funnels.error ?? error, onSessionExpired)

  const funnelNames = new Map((funnels.data ?? []).map((funnel) => [funnel.id, funnel.name]))

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

  function toggle(type: ChangeType, on: boolean) {
    setEvents((current) => (on ? [...current, type] : current.filter((value) => value !== type)))
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (url.trim() === '') return
    void run(async () => {
      const created = await createWebhook({
        url: url.trim(),
        funnelId: scope === ALL_FUNNELS ? null : Number(scope),
        events,
      })
      setSecret(created.secret)
      setUrl('')
      setEvents([])
      hooks.reload()
    })
  }

  function handleDelete(hook: WebhookRecord) {
    if (confirming !== hook.id) {
      setConfirming(hook.id)
      return
    }
    setConfirming(undefined)
    void run(async () => {
      await deleteWebhook(hook.id)
      hooks.reload()
    })
  }

  function handleTest(hook: WebhookRecord) {
    void run(async () => {
      setTested({ id: hook.id, delivery: await testWebhook(hook.id) })
      hooks.refresh()
    })
  }

  return (
    <section className="screen">
      <header className="screen-head">
        <h2>Webhooks</h2>
      </header>
      <p className="hint">
        Philo posts each change to these addresses as it happens, as JSON — for an automation tool or an
        agent that should react without polling. Every request carries{' '}
        <code>X-Philo-Signature: sha256=…</code>, an HMAC of <code>X-Philo-Timestamp</code>, a dot and
        the body, keyed with the webhook&rsquo;s secret. A failed delivery is retried twice.
      </p>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {webhookErrorMessage(error)}
        </p>
      )}

      {secret !== undefined && (
        <div className="notice notice-ok new-key" role="status">
          <p>Copy this signing secret now. It is not shown again.</p>
          <label className="field">
            <span className="field-label">Signing secret</span>
            <input className="new-key-secret" readOnly value={secret} onFocus={(event) => event.target.select()} />
          </label>
          <div className="settings-actions">
            <CopyButton text={secret} label="Copy the signing secret" />
            <button type="button" onClick={() => setSecret(undefined)}>
              Done
            </button>
          </div>
        </div>
      )}

      <form className="panel" aria-label="Add a webhook" onSubmit={handleCreate}>
        <div className="fields">
          <label className="field">
            <span className="field-label">Post to</span>
            <input
              type="url"
              value={url}
              autoComplete="off"
              placeholder="https://automation.example.com/hooks/philo"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">For</span>
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value={ALL_FUNNELS}>Every funnel</option>
              {(funnels.data ?? []).map((funnel) => (
                <option key={funnel.id} value={String(funnel.id)}>
                  {funnel.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="field">
            <legend className="field-label">When</legend>
            {CHANGE_TYPES.map((type) => (
              <label key={type} className="check">
                <input
                  type="checkbox"
                  checked={events.includes(type)}
                  onChange={(event) => toggle(type, event.target.checked)}
                />
                <span>{CHANGE_LABELS[type]}</span>
              </label>
            ))}
            <span className="hint">Tick none for every change.</span>
          </fieldset>
        </div>
        <div className="settings-actions">
          <button type="submit" disabled={busy || url.trim() === ''}>
            {busy ? 'Working…' : 'Add webhook'}
          </button>
        </div>
      </form>

      {hooks.data === undefined ? (
        hooks.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {webhookErrorMessage(hooks.error)}
          </p>
        )
      ) : hooks.data.length === 0 ? (
        <p className="empty">No webhooks yet.</p>
      ) : (
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">For</th>
                <th scope="col">When</th>
                <th scope="col">Last delivery</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {hooks.data.map((hook) => {
                const delivery = tested?.id === hook.id ? tested.delivery : hook.lastDelivery
                return (
                  <tr key={hook.id}>
                    <td>
                      <code className="intake-url">{hook.url}</code>
                    </td>
                    <td>
                      {hook.funnelId === null ? 'Every funnel' : (funnelNames.get(hook.funnelId) ?? 'A funnel')}
                    </td>
                    <td>{hook.events.length === 0 ? 'Every change' : hook.events.join(', ')}</td>
                    <td>{describeDelivery(delivery)}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        aria-label={`Send a test to ${hook.url}`}
                        disabled={busy}
                        onClick={() => handleTest(hook)}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        aria-label={confirming === hook.id ? `Confirm deleting ${hook.url}` : `Delete ${hook.url}`}
                        disabled={busy}
                        onClick={() => handleDelete(hook)}
                      >
                        {confirming === hook.id ? 'Confirm delete' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
