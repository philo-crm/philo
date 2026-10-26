import { useCallback, useState, type FormEvent } from 'react'
import {
  apiErrorMessage,
  createLead,
  fetchStages,
  MAX_CONTACT_FIELD_LENGTH,
  MAX_EMAIL_LENGTH,
} from './api.ts'
import { FunnelPicker, useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { firstFailure } from './http.ts'
import { Link, navigate } from './router.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface NewLeadProps {
  onSessionExpired: () => void
}

/**
 * A lead entered by hand — a phone call, a walk-in, a referral. DESIGN.md
 * (Email): it sends neither email, since nobody submitted anything, and the
 * screen says so rather than leave the operator wondering.
 */
export function NewLead({ onSessionExpired }: NewLeadProps) {
  const funnels = useFunnels()
  const [funnelId, selectFunnel] = useSelectedFunnel(funnels.data)
  const loadStages = useCallback(
    (signal: AbortSignal) => (funnelId === undefined ? Promise.resolve([]) : fetchStages(signal, funnelId)),
    [funnelId],
  )
  const stages = useResource(loadStages)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState('')
  const [stageId, setStageId] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<unknown>(undefined)
  const [missingContact, setMissingContact] = useState(false)

  const error = firstFailure(funnels.error, stages.error, actionError)
  useSessionGuard(error, onSessionExpired)

  const stageList = stages.data ?? []
  // A stage picked under another funnel is not one of these; fall back to the first.
  const chosenStage = stageList.some((stage) => stage.id === stageId) ? stageId : stageList[0]?.id

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    // The rule the server applies, checked first so the form can say which
    // fields it means instead of relaying a code.
    if (email.trim() === '' && phone.trim() === '') {
      setMissingContact(true)
      return
    }
    setMissingContact(false)
    setBusy(true)
    setActionError(undefined)
    try {
      const lead = await createLead({
        name: name.trim() === '' ? undefined : name.trim(),
        email: email.trim() === '' ? undefined : email.trim(),
        phone: phone.trim() === '' ? undefined : phone.trim(),
        source: source.trim() === '' ? undefined : source.trim(),
        funnelId,
        stageId: chosenStage,
      })
      navigate(`/leads/${lead.id}`)
    } catch (caught) {
      setActionError(caught)
      setBusy(false)
    }
  }

  return (
    <section className="screen screen-narrow">
      <p className="breadcrumb">
        <Link to="/">← Leads</Link>
      </p>
      <header className="screen-head">
        <h1>New lead</h1>
      </header>
      <p className="hint">For someone who got in touch some other way. No email is sent to them or to you.</p>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {apiErrorMessage(error)}
        </p>
      )}
      {missingContact && (
        <p className="notice notice-error" role="alert">
          Add an email address or a phone number, so there is a way to reach them.
        </p>
      )}

      <form className="panel settings-cards new-lead-form" aria-label="New lead" onSubmit={(event) => void handleSubmit(event)}>
        <div className="fields fields-2">
          <FunnelPicker funnels={funnels.data ?? []} selected={funnelId} onChange={selectFunnel} disabled={busy} />
          <label className="field">
            <span className="field-label">Name</span>
            <input
              value={name}
              autoComplete="off"
              maxLength={MAX_CONTACT_FIELD_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={email}
              autoComplete="off"
              maxLength={MAX_EMAIL_LENGTH}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Phone</span>
            <input
              type="tel"
              value={phone}
              autoComplete="off"
              maxLength={MAX_CONTACT_FIELD_LENGTH}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Source</span>
            <input
              value={source}
              placeholder="Phone call, referral…"
              maxLength={MAX_CONTACT_FIELD_LENGTH}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Stage</span>
            <select
              value={chosenStage === undefined ? '' : String(chosenStage)}
              disabled={busy || stageList.length === 0}
              onChange={(event) => setStageId(Number(event.target.value))}
            >
              {stageList.map((stage) => (
                <option key={stage.id} value={String(stage.id)}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-footer">
          <button type="submit" disabled={busy || funnelId === undefined}>
            {busy ? 'Adding…' : 'Add lead'}
          </button>
        </div>
      </form>
    </section>
  )
}
