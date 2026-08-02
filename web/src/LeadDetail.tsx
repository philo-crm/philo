import { useCallback, useState, type FormEvent } from 'react'
import {
  addLeadNote,
  apiErrorMessage,
  fetchLead,
  fetchStages,
  moveLeadStage,
  promoteLead,
  MAX_NOTE_LENGTH,
  type LeadDetail as LeadDetailRecord,
} from './api.ts'
import { ApiError } from './http.ts'
import { actorLabel, describeEvent, formatDateTime, formatFieldValue, humanizeKey, leadTitle } from './format.ts'
import { Link } from './router.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface LeadDetailProps {
  leadId: number
  /** Timeline entries by this user read as "You" — see actorLabel. */
  currentUserId: number
  onSessionExpired: () => void
}

export function LeadDetail({ leadId, currentUserId, onSessionExpired }: LeadDetailProps) {
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)

  const loadLead = useCallback((signal: AbortSignal) => fetchLead(leadId, signal), [leadId])
  const lead = useResource(loadLead)

  const loadStages = useCallback((signal: AbortSignal) => fetchStages(signal), [])
  const stages = useResource(loadStages)

  useSessionGuard(lead.error ?? stages.error ?? actionError, onSessionExpired)

  /** Every mutation answers with the whole lead, so the screen updates from the response. */
  async function run(action: () => Promise<LeadDetailRecord>) {
    setBusy(true)
    setActionError(undefined)
    try {
      lead.set(await action())
      return true
    } catch (error) {
      setActionError(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = note.trim()
    if (busy || trimmed === '') return
    // Cleared only on success, so a failed send does not lose what was typed.
    if (await run(() => addLeadNote(leadId, trimmed))) setNote('')
  }

  const record = lead.data

  if (record === undefined) {
    if (lead.error !== undefined) {
      const missing = lead.error instanceof ApiError && lead.error.status === 404
      return (
        <section className="screen">
          <p className="notice notice-error" role="alert">
            {apiErrorMessage(lead.error)}
          </p>
          <p>
            <Link to={missing ? '/' : `/leads/${leadId}`}>{missing ? 'Back to leads' : 'Try again'}</Link>
          </p>
        </section>
      )
    }
    return (
      <section className="screen">
        <p className="empty">Loading…</p>
      </section>
    )
  }

  const fieldEntries = Object.entries(record.fields)
  // Newest first: the reason to open a lead is almost always what just happened.
  const events = record.events.toReversed()
  const error = actionError

  return (
    <section className="screen">
      <p className="breadcrumb">
        <Link to={record.isSpam ? '/spam' : '/'}>← {record.isSpam ? 'Spam' : 'Leads'}</Link>
      </p>

      <header className="screen-head">
        <h1>{leadTitle(record)}</h1>
        {!record.isSpam && (
          <label className="field">
            <span className="field-label">Stage</span>
            <select
              value={String(record.stageId)}
              disabled={busy}
              onChange={(event) => void run(() => moveLeadStage(leadId, Number(event.target.value)))}
            >
              {/* Until the funnel loads, the only option is where the lead already is. */}
              {stages.data === undefined ? (
                <option value={String(record.stageId)}>{record.stageName}</option>
              ) : (
                stages.data.map((stage) => (
                  <option key={stage.id} value={String(stage.id)}>
                    {stage.name}
                  </option>
                ))
              )}
            </select>
          </label>
        )}
      </header>

      {record.isSpam && (
        <div className="notice notice-warn">
          <p>Quarantined as spam. Nothing was emailed and nobody was notified.</p>
          <button type="button" disabled={busy} onClick={() => void run(() => promoteLead(leadId))}>
            Not spam
          </button>
        </div>
      )}

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {apiErrorMessage(error)}
        </p>
      )}

      <div className="panels">
        <div className="panel">
          <h2>Contact</h2>
          <dl className="pairs">
            <dt>Email</dt>
            <dd>{record.email === null ? '—' : <a href={`mailto:${record.email}`}>{record.email}</a>}</dd>
            <dt>Phone</dt>
            <dd>{record.phone === null ? '—' : <a href={`tel:${record.phone}`}>{record.phone}</a>}</dd>
            <dt>Source</dt>
            <dd>{record.source ?? '—'}</dd>
            <dt>Received</dt>
            <dd className="numeric">{formatDateTime(record.createdAt)}</dd>
            <dt>Updated</dt>
            <dd className="numeric">{formatDateTime(record.updatedAt)}</dd>
          </dl>
        </div>

        <div className="panel">
          <h2>Submitted answers</h2>
          {fieldEntries.length === 0 ? (
            <p className="empty">The form sent nothing beyond the contact details.</p>
          ) : (
            <dl className="pairs">
              {fieldEntries.map(([key, value]) => (
                // The key is the raw submitted one; React needs it unique, and
                // Object.entries guarantees that.
                <div key={key} className="pair">
                  <dt>{humanizeKey(key)}</dt>
                  <dd>{formatFieldValue(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Timeline</h2>
        <form className="note-form" onSubmit={handleNote}>
          <label className="field">
            <span className="field-label">Add a note</span>
            <textarea
              value={note}
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              placeholder="What happened on the call?"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || note.trim() === ''}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
        </form>

        <ol className="timeline">
          {events.map((event) => {
            const summary = describeEvent(event)
            return (
              <li key={event.id}>
                <p className="timeline-head">
                  <span className="timeline-label">{summary.label}</span>
                  {summary.detail !== undefined && <span className="muted"> {summary.detail}</span>}
                </p>
                {summary.body !== undefined && <p className="timeline-body">{summary.body}</p>}
                <p className="timeline-meta muted">
                  <span className="numeric">{formatDateTime(event.createdAt)}</span>
                  {' · '}
                  <span>{actorLabel(event.actor, currentUserId)}</span>
                </p>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
