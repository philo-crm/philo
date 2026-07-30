import { createHash } from 'node:crypto'

/**
 * Hidden field the form renders and a human never sees. A bot that fills every
 * input fills this one too, and DESIGN.md (Intake endpoint) says the answer is
 * to accept the submission and mark it spam rather than reject it, so the bot
 * learns nothing. Underscore-prefixed because a real form field named `website`
 * is entirely plausible for the later sales use case.
 */
export const HONEYPOT_FIELD = '_hp'

/**
 * Keys that mean something to the schema. Everything else is preserved verbatim
 * in `fields` — DESIGN.md (Intake endpoint): a renamed or added form field can
 * never drop a submission.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['name', 'first_name', 'last_name', 'email', 'phone'])

/**
 * How deep a JSON payload may nest. The FTS trigger walks `fields` with
 * `json_tree`, and SQLite's parser has its own depth limit — a payload past it
 * would turn every later insert into a failed write. Nothing a real form
 * produces is close to this.
 */
export const MAX_FIELD_DEPTH = 8

export interface Submission {
  name: string | null
  email: string | null
  phone: string | null
  /** The non-reserved keys, untouched. */
  fields: Record<string, unknown>
  isSpam: boolean
}

/** A scalar the reserved columns can hold. Anything else stays in `fields`. */
function asScalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** True for a honeypot value a bot actually filled in. */
function isFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isFilled)
  const scalar = asScalarString(value)
  return scalar !== undefined && scalar.trim().length > 0
}

/**
 * Stops at the limit rather than measuring the true depth, so the recursion here
 * is bounded by the limit and not by the payload — otherwise checking a
 * thousand-deep body would overflow the stack on the way to rejecting it.
 */
function exceedsDepth(value: unknown, remaining: number): boolean {
  if (remaining <= 0) return true
  if (Array.isArray(value)) return value.some((item) => exceedsDepth(item, remaining - 1))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => exceedsDepth(item, remaining - 1))
  }
  return false
}

export function isWithinDepthLimit(payload: Record<string, unknown>): boolean {
  return !exceedsDepth(payload, MAX_FIELD_DEPTH)
}

/**
 * A map to collect submitted keys into. Null-prototyped because a submission may
 * contain any key at all: assigning `__proto__` onto an ordinary object sets the
 * prototype instead of a property, and the field would vanish from the stored
 * JSON — a dropped submission, which is the one thing intake must never do.
 */
function emptyPayload(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/**
 * Form encoding has no types and no objects: every value is a string, and a
 * repeated key (checkbox groups, multi-selects) is a list. Both survive into
 * `fields` as-is.
 */
export function parseFormEncoded(body: string): Record<string, unknown> {
  const payload = emptyPayload()
  for (const [key, value] of new URLSearchParams(body)) {
    const existing = payload[key]
    if (existing === undefined) {
      payload[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      payload[key] = [existing, value]
    }
  }
  return payload
}

/**
 * Reserved names to columns, everything else to `fields`. A reserved key whose
 * value is not a scalar — `email: {…}` from a hand-rolled JSON client — is left
 * in `fields` rather than coerced or dropped, so the submission still arrives
 * whole and a human can see what was sent.
 */
export function mapSubmission(payload: Record<string, unknown>): Submission {
  const fields = emptyPayload()
  const reserved: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries(payload)) {
    // The honeypot is machinery, not an answer: it is never persisted, and
    // keeping it out of `fields` keeps it out of the search index too.
    if (key === HONEYPOT_FIELD) continue
    if (!RESERVED_FIELDS.has(key)) {
      fields[key] = value
      continue
    }
    const scalar = asScalarString(value)
    if (scalar === undefined) {
      fields[key] = value
      continue
    }
    reserved[key] = scalar
  }

  const name =
    trimmedOrNull(reserved['name']) ??
    trimmedOrNull(
      [trimmedOrNull(reserved['first_name']), trimmedOrNull(reserved['last_name'])]
        .filter((part) => part !== null)
        .join(' '),
    )

  return {
    name,
    // Lowercased to match the rest of the codebase's treatment of addresses;
    // no format validation, because the only real test is sending to it.
    email: trimmedOrNull(reserved['email'])?.toLowerCase() ?? null,
    phone: trimmedOrNull(reserved['phone']),
    fields,
    isSpam: isFilled(payload[HONEYPOT_FIELD]),
  }
}

/** DESIGN.md (Intake endpoint): the only validation is that we can reply somehow. */
export function isContactable(submission: Submission): boolean {
  return submission.email !== null || submission.phone !== null
}

/**
 * Key for the dedupe window. Built from the mapped submission rather than the
 * raw body so the same answers submitted twice collide even if the second POST
 * ordered its keys differently or arrived form-encoded instead of as JSON.
 */
export function submissionHash(formKey: string, submission: Submission): string {
  return createHash('sha256')
    .update(
      canonicalize([
        formKey,
        submission.name,
        submission.email,
        submission.phone,
        submission.isSpam,
        submission.fields,
      ]),
    )
    .digest('hex')
}

/** JSON with object keys in a stable order, at any depth. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
