import { useCallback, useState, type FormEvent } from 'react'
import {
  fetchEmailTemplates,
  previewEmailTemplate,
  sendTemplateTestEmail,
  settingsErrorMessage,
  updateEmailTemplate,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  type EmailTemplate,
  type EmailTemplateDraft,
  type EmailTemplatePreview,
} from './api.ts'
import { useResource, useSessionGuard } from './useResource.ts'

/**
 * What each trigger is, in the words of someone who has to decide whether to
 * switch it off. The enum grows to `stage_changed:<stage>` post-MVP — DESIGN.md
 * (Email) — so an unknown trigger falls back to its own name rather than
 * vanishing from the screen.
 */
const TEMPLATE_LABELS: Record<string, { title: string; when: string }> = {
  new_lead_notify: {
    title: 'New lead notification',
    when: 'Sent to everyone who can sign in, as soon as a lead arrives.',
  },
  new_lead_ack: {
    title: 'Applicant acknowledgment',
    when: 'Sent to the lead, when they left an email address. Replies go to your reply-to address.',
  },
}

/** The variables a template may use — DESIGN.md (Email). Anything else renders empty. */
const VARIABLES = [
  '{{lead.name}}',
  '{{lead.email}}',
  '{{lead.phone}}',
  '{{lead.source}}',
  '{{lead.fields.<answer>}}',
  '{{business.name}}',
  '{{lead_url}}',
]

export interface EmailTemplatesProps {
  onSessionExpired: () => void
}

export function EmailTemplates({ onSessionExpired }: EmailTemplatesProps) {
  const load = useCallback((signal: AbortSignal) => fetchEmailTemplates(signal), [])
  const templates = useResource(load)
  useSessionGuard(templates.error, onSessionExpired)

  return (
    <section className="screen">
      {/* h2 rather than h1: this sits under the Settings screen's own heading. */}
      <header className="screen-head">
        <h2>Email templates</h2>
      </header>

      {templates.data === undefined ? (
        templates.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {settingsErrorMessage(templates.error)}
          </p>
        )
      ) : (
        <>
          <p className="hint">
            Handlebars, rendered per lead. Available variables:{' '}
            {VARIABLES.map((variable, index) => (
              <span key={variable}>
                {index === 0 ? '' : ', '}
                <code>{variable}</code>
              </span>
            ))}
            . A variable that does not exist renders as nothing.
          </p>
          {templates.data.map((template) => (
            <TemplateEditor key={template.trigger} template={template} />
          ))}
        </>
      )}
    </section>
  )
}

interface TemplateEditorProps {
  /** Read once, at mount. Everything after that is the editor's own state. */
  template: EmailTemplate
}

function TemplateEditor({ template }: TemplateEditorProps) {
  const [subject, setSubject] = useState(template.subject)
  const [body, setBody] = useState(template.body)
  const [enabled, setEnabled] = useState(template.enabled)
  /** Empty means the server's sample lead. A string, so a half-typed id is not a number. */
  const [leadId, setLeadId] = useState('')
  const [preview, setPreview] = useState<EmailTemplatePreview | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)

  const label = TEMPLATE_LABELS[template.trigger] ?? { title: template.trigger, when: '' }

  /** The boxes as they stand, so preview and test-send never need a save first. */
  function draft(): EmailTemplateDraft {
    const id = Number(leadId)
    return {
      subject,
      body,
      ...(leadId.trim() !== '' && Number.isInteger(id) && id > 0 ? { leadId: id } : {}),
    }
  }

  async function run(action: () => Promise<string>) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      setStatus(await action())
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(async () => {
      const saved = await updateEmailTemplate(template.trigger, { subject, body, enabled })
      // Answered with what was stored, so the boxes show the trimmed subject the
      // server actually kept rather than what was typed at it.
      setSubject(saved.subject)
      setBody(saved.body)
      setEnabled(saved.enabled)
      return 'Template saved.'
    })
  }

  function handlePreview() {
    void run(async () => {
      setPreview(await previewEmailTemplate(template.trigger, draft()))
      return 'Preview updated.'
    })
  }

  function handleTest() {
    void run(async () => `Test email sent to ${await sendTemplateTestEmail(template.trigger, draft())}.`)
  }

  return (
    <form className="panel template-editor" aria-label={label.title} onSubmit={handleSave}>
      <h3>{label.title}</h3>
      {label.when !== '' && <p className="hint">{label.when}</p>}

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {settingsErrorMessage(error)}
        </p>
      )}
      {status !== undefined && (
        <p className="notice notice-ok" role="status">
          {status}
        </p>
      )}

      <div className="fields">
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Send this email</span>
        </label>
        <label className="field">
          <span className="field-label">Subject</span>
          <input
            value={subject}
            maxLength={MAX_TEMPLATE_SUBJECT_LENGTH}
            autoComplete="off"
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Body (HTML)</span>
          <textarea
            className="template-body"
            value={body}
            rows={10}
            maxLength={MAX_TEMPLATE_BODY_LENGTH}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <label className="field template-lead">
          <span className="field-label">Preview against lead</span>
          <input
            type="number"
            min={1}
            value={leadId}
            placeholder="Sample lead"
            onChange={(event) => setLeadId(event.target.value)}
          />
        </label>
      </div>

      <div className="settings-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Save template'}
        </button>
        <button type="button" disabled={busy} onClick={handlePreview}>
          Preview
        </button>
        <button type="button" disabled={busy} onClick={handleTest}>
          Send test to me
        </button>
        <span className="hint">Preview and test-send use the boxes above, saved or not.</span>
      </div>

      {preview !== undefined && <Preview preview={preview} title={label.title} />}
    </form>
  )
}

function Preview({ preview, title }: { preview: EmailTemplatePreview; title: string }) {
  return (
    <div className="template-preview">
      <p className="field-label">Subject</p>
      <p className="preview-subject">{preview.subject}</p>
      <p className="field-label">Body</p>
      {/*
        Sandboxed, and with no `allow-` tokens: the body is HTML an operator
        wrote and a lead's answers were rendered into, and a preview must not be
        able to run either of them against this origin's session.
      */}
      <iframe className="preview-body" title={`${title} preview`} sandbox="" srcDoc={preview.body} />
      <p className="hint">
        {preview.leadId === null
          ? 'Rendered against a sample lead.'
          : `Rendered against lead #${preview.leadId}.`}
      </p>
    </div>
  )
}
