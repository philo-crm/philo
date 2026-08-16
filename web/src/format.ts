import type { LeadEventRecord, LeadRecord } from './api.ts'

/**
 * A `fields` key as submitted, made readable: `years_experience`,
 * `years-experience` and `yearsExperience` all become `Years experience`. The
 * stored key is never rewritten — intake keeps the payload as sent (ADR-0003)
 * and this is presentation only.
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (words.length === 0) return key
  return words
    // An all-caps word is left alone: this funnel is full of acronyms, and
    // "Cdl class" is worse than the inconsistency of not lowercasing it.
    .map((word, index) => {
      if (word.length > 1 && word === word.toUpperCase()) return word
      const lower = word.toLowerCase()
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

/**
 * A `fields` value as text. The column is raw JSON, so a form can put anything
 * in it — an array from a multi-select, a boolean from a checkbox, an object
 * from a nested payload — and every one of them has to render as something a
 * person can read rather than as `[object Object]`.
 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.trim() === '' ? '—' : value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((entry) => formatFieldValue(entry)).join(', ')
  }
  return JSON.stringify(value)
}

/** Absolute, in the reader's own locale and zone. Timestamps arrive as ISO UTC. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** How a lead is named in a list or a heading when the form gave no name. */
export function leadTitle(lead: Pick<LeadRecord, 'id' | 'name' | 'email' | 'phone'>): string {
  return lead.name ?? lead.email ?? lead.phone ?? `Lead ${lead.id}`
}

/** Both ways to reach a lead on one line, for a row or a card. */
export function leadContact(lead: Pick<LeadRecord, 'email' | 'phone'>): string {
  const parts = [lead.email, lead.phone].filter((part): part is string => part !== null)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/**
 * Who did it. Intake writes `form:<form_key>` and that key is the unguessable
 * secret the public endpoint is addressed by (DESIGN.md, Intake endpoint), so
 * it is deliberately never rendered — the form is identified by the lead's
 * `source` instead, which is the form's name.
 */
export function actorLabel(actor: string, currentUserId: number): string {
  if (actor === `user:${currentUserId}`) return 'You'
  if (actor.startsWith('user:')) return 'A user'
  if (actor.startsWith('form:')) return 'Intake form'
  // What the REST and MCP surfaces write for a headless caller — see
  // actorOf in server/src/auth/middleware.ts and resolveActor in
  // server/src/mcp/routes.ts. Without the `oauth:` branch a connector's
  // writes fall through to 'System' and become indistinguishable from
  // Philo's own, which is the distinction `actor` exists to make.
  if (actor.startsWith('api_key:')) return 'API key'
  if (actor.startsWith('oauth:')) return 'Connected app'
  return 'System'
}

export interface EventSummary {
  /** The one-line heading for this entry. */
  label: string
  /** Optional supporting text — a stage transition, an email subject. */
  detail: string | undefined
  /** Free text the operator wrote, rendered as a block rather than inline. */
  body: string | undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stageName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return text((value as { name?: unknown }).name)
}

/**
 * A timeline entry in words. The four types are the contract in DESIGN.md
 * (Data model); an unrecognised one still renders, because the timeline is a
 * log and a reader is better served by a plain row than by a gap.
 */
export function describeEvent(event: LeadEventRecord): EventSummary {
  const payload = event.payload
  if (event.type === 'created') {
    const form = text(payload['form'])
    return {
      label: 'Lead created',
      detail: form === undefined ? undefined : `from ${form}`,
      body: undefined,
    }
  }
  if (event.type === 'stage_changed') {
    const from = stageName(payload['from'])
    const to = stageName(payload['to'])
    return {
      label: 'Stage changed',
      detail: to === undefined ? undefined : `${from ?? 'Unknown'} → ${to}`,
      body: undefined,
    }
  }
  if (event.type === 'note_added') {
    return {
      label: payload['system'] === true ? 'System note' : 'Note added',
      detail: undefined,
      body: text(payload['note']) ?? '',
    }
  }
  if (event.type === 'email_sent') {
    const subject = text(payload['subject'])
    return {
      label: 'Email sent',
      detail: subject === undefined ? text(payload['template']) : `“${subject}”`,
      body: undefined,
    }
  }
  return { label: humanizeKey(event.type), detail: undefined, body: undefined }
}
