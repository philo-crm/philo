import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  addLeadNote,
  apiErrorMessage,
  deleteLead,
  downloadAttachment,
  fetchLead,
  fetchStages,
  moveLeadStage,
  promoteLead,
  removeAttachment,
  updateLeadDetails,
  uploadAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_DETAIL_KEY_LENGTH,
  MAX_NOTE_LENGTH,
  type LeadAttachmentRecord,
  type LeadDetail as LeadDetailRecord,
} from './api.ts'
import { ApiError, firstFailure } from './http.ts'
import {
  actorLabel,
  describeEvent,
  formatBytes,
  formatDateTime,
  formatFieldValue,
  humanizeKey,
  leadTitle,
} from './format.ts'
import { Link, navigate } from './router.tsx'
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

  // A 401 anywhere wins over an earlier non-401, so a blip on the funnel
  // request cannot leave the reader stranded on an authenticated screen.
  const error = firstFailure(lead.error, stages.error, actionError)
  useSessionGuard(error, onSessionExpired)

  /** Every mutation answers with the whole lead, so the screen updates from the response. */
  async function run(action: () => Promise<LeadDetailRecord>) {
    setBusy(true)
    setActionError(undefined)
    try {
      lead.set(await action())
      return true
    } catch (caught) {
      setActionError(caught)
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

      <div className="panels">
        <DetailsPanel
          details={record.details}
          busy={busy}
          onChange={(details) => run(() => updateLeadDetails(leadId, details))}
        />
        <AttachmentsPanel
          attachments={record.attachments}
          busy={busy}
          onUpload={(file) => run(() => uploadAttachment(leadId, file))}
          onDownload={async (attachment) => {
            setActionError(undefined)
            try {
              saveBlob(await downloadAttachment(leadId, attachment.id), attachment.filename)
            } catch (caught) {
              setActionError(caught)
            }
          }}
          onRemove={(attachment) => run(() => removeAttachment(leadId, attachment.id))}
          onRejected={(message) => setActionError(new Error(message))}
        />
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

      <DeletePanel
        busy={busy}
        onDelete={async () => {
          setBusy(true)
          setActionError(undefined)
          try {
            await deleteLead(leadId)
            navigate(record.isSpam ? '/spam' : '/')
          } catch (caught) {
            setActionError(caught)
            setBusy(false)
          }
        }}
      />
    </section>
  )
}

/** What has to be typed before a lead is erased. */
const DELETE_CONFIRMATION = 'delete'

/**
 * Erasure, behind a typed confirmation: unlike moving a lead to a closing stage,
 * nothing about it can be undone, and a stray click must not be enough.
 */
function DeletePanel({ busy, onDelete }: { busy: boolean; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')

  if (!open) {
    return (
      <div className="panel">
        <h2>Delete lead</h2>
        <p className="muted">Erases this lead and everything held about it. To close it out instead, move it to a final stage.</p>
        <button type="button" className="danger" disabled={busy} onClick={() => setOpen(true)}>
          Delete lead…
        </button>
      </div>
    )
  }

  return (
    <form
      className="panel delete-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (typed.trim().toLowerCase() === DELETE_CONFIRMATION) void onDelete()
      }}
    >
      <h2>Delete lead</h2>
      <p className="notice notice-error">
        This erases the contact details, answers, details, timeline and files for good. It cannot be undone,
        and backups taken before now still hold them.
      </p>
      <label className="field">
        <span className="field-label">Type {DELETE_CONFIRMATION} to confirm</span>
        <input value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
      </label>
      <div className="delete-actions">
        <button
          type="submit"
          className="danger"
          disabled={busy || typed.trim().toLowerCase() !== DELETE_CONFIRMATION}
        >
          {busy ? 'Deleting…' : 'Delete for good'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setTyped('')
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Hands a fetched file to the browser as a download, under its stored name.
 *
 * Retyped as octet-stream first: an object URL lives in this app's origin
 * without the server's sandboxing headers, so an uploaded HTML or SVG file kept
 * at its own type would run as the app in any browser that navigates to the
 * link instead of honouring `download`.
 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Revoked on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

interface DetailsPanelProps {
  details: Record<string, unknown>
  busy: boolean
  onChange: (details: Record<string, unknown>) => Promise<boolean>
}

/** What was learned after intake — ADR-0008. Saving a name that exists replaces its value. */
function DetailsPanel({ details, busy, onChange }: DetailsPanelProps) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const entries = Object.entries(details)

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = key.trim()
    if (busy || name === '' || value.trim() === '') return
    // Cleared only on success, so a failed save does not lose what was typed.
    if (await onChange({ [name]: value.trim() })) {
      setKey('')
      setValue('')
    }
  }

  return (
    <div className="panel">
      <h2>Details</h2>
      {entries.length === 0 ? (
        <p className="empty">Nothing added since the lead came in.</p>
      ) : (
        <dl className="pairs">
          {entries.map(([name, stored]) => (
            <div key={name} className="pair">
              <dt>{humanizeKey(name)}</dt>
              <dd className="pair-value">
                <span>{formatFieldValue(stored)}</span>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  aria-label={`Remove ${humanizeKey(name)}`}
                  onClick={() => void onChange({ [name]: null })}
                >
                  Remove
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <form className="detail-form" onSubmit={handleAdd}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            value={key}
            maxLength={MAX_DETAIL_KEY_LENGTH}
            placeholder="start_date"
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Value</span>
          <input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <button type="submit" disabled={busy || key.trim() === '' || value.trim() === ''}>
          Save detail
        </button>
      </form>
    </div>
  )
}

interface AttachmentsPanelProps {
  attachments: LeadAttachmentRecord[]
  busy: boolean
  onUpload: (file: File) => Promise<boolean>
  onDownload: (attachment: LeadAttachmentRecord) => Promise<void>
  onRemove: (attachment: LeadAttachmentRecord) => Promise<boolean>
  onRejected: (message: string) => void
}

function AttachmentsPanel({ attachments, busy, onUpload, onDownload, onRemove, onRejected }: AttachmentsPanelProps) {
  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target
    const file = input.files?.[0]
    // Reset so choosing the same file again still fires a change.
    input.value = ''
    if (file === undefined) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onRejected(`${file.name} is ${formatBytes(file.size)}; a file can be at most ${formatBytes(MAX_ATTACHMENT_BYTES)}.`)
      return
    }
    void onUpload(file)
  }

  function handleRemove(attachment: LeadAttachmentRecord) {
    // Removal deletes the bytes for good, so it asks first.
    if (window.confirm(`Remove ${attachment.filename}? The file cannot be recovered.`)) void onRemove(attachment)
  }

  return (
    <div className="panel">
      <h2>Files</h2>
      {attachments.length === 0 ? (
        <p className="empty">No files attached.</p>
      ) : (
        <ul className="attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button type="button" className="link-button" onClick={() => void onDownload(attachment)}>
                {attachment.filename}
              </button>
              <span className="muted numeric"> {formatBytes(attachment.size)}</span>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => handleRemove(attachment)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span className="field-label">Attach a file</span>
        <input type="file" disabled={busy} onChange={handleFile} />
      </label>
    </div>
  )
}
