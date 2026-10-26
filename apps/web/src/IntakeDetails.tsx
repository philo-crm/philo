import { useState } from 'react'
import { HONEYPOT_FIELD, type FunnelForm } from './api.ts'

/** A form a website can paste in as-is, posting straight to this funnel. */
export function sampleForm(intakeUrl: string): string {
  return `<form method="post" action="${intakeUrl}">
  <input name="name" placeholder="Your name">
  <input name="email" type="email" placeholder="Email">
  <input name="phone" type="tel" placeholder="Phone">
  <!-- Any other field is kept with the lead, under its own name. -->
  <textarea name="message"></textarea>
  <!-- Spam trap: hidden from people, filled in by bots. Leave it empty. -->
  <input name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off" style="display:none">
  <button type="submit">Send</button>
</form>`
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    // Absent on http origins other than localhost, which is a deployment
    // DESIGN.md allows — so the text stays selectable beside the button.
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <button type="button" aria-label={label} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * Everything a website needs to send leads into one funnel: its form's URL,
 * what to post there, and a form to start from. The URL alone says which
 * funnel — each funnel has a form key of its own (ADR-0009).
 */
export function IntakeDetails({ form }: { form: FunnelForm }) {
  const sample = sampleForm(form.intakeUrl)
  return (
    <div className="intake">
      <div className="field">
        <span className="field-label">Intake URL</span>
        <div className="copy-row">
          <code className="intake-url">{form.intakeUrl}</code>
          <CopyButton text={form.intakeUrl} label={`Copy the ${form.name} intake URL`} />
        </div>
      </div>
      <p className="hint">
        Point a website form at this URL with <code>POST</code>, as a plain HTML form or as JSON. Philo
        reads <code>name</code> (or <code>first_name</code> and <code>last_name</code>),{' '}
        <code>email</code> and <code>phone</code>, needs at least one of the last two, and keeps every
        other field with the lead. A filled-in <code>{HONEYPOT_FIELD}</code> field marks it as spam.
      </p>
      <details>
        <summary>Sample form</summary>
        <pre className="intake-sample">{sample}</pre>
        <CopyButton text={sample} label={`Copy the ${form.name} sample form`} />
      </details>
    </div>
  )
}
