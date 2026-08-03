import Handlebars from 'handlebars'
import type { LeadRecord } from '../leads/service.ts'

/**
 * The variables a template may use — DESIGN.md (Email). Anything else renders
 * empty rather than erroring: a template is operator-authored text, and a typo
 * in it must not be able to stop a lead's email from going out.
 */
export interface TemplateContext {
  lead: {
    name: string | null
    email: string | null
    phone: string | null
    source: string | null
    fields: Record<string, unknown>
  }
  business: { name: string }
  lead_url: string
}

/**
 * `{{business.name}}` falls back to the sender's display name, so the seeded
 * acknowledgment ("Thanks for reaching out to {{business.name}}") still reads
 * as a sentence on an instance that filled in one field and not the other.
 */
export function buildContext(
  lead: Pick<LeadRecord, 'id' | 'name' | 'email' | 'phone' | 'source' | 'fields'>,
  options: { businessName: string; fromName: string; publicBaseUrl: string },
): TemplateContext {
  return {
    lead: {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      fields: lead.fields,
    },
    business: { name: options.businessName || options.fromName },
    lead_url: `${options.publicBaseUrl.replace(/\/+$/, '')}/leads/${lead.id}`,
  }
}

/**
 * Renders one template. Compilation and evaluation both throw on input this
 * cannot control — an unclosed block, a helper that does not exist — and the
 * answer to either is the same: no email rather than a crashed hook.
 *
 * `noEscape` is the caller's call because the two halves are different media.
 * A body is HTML and must escape what a stranger typed into a form; a subject
 * is a header, where `&amp;` would be shown literally to the reader.
 */
function render(source: string, context: TemplateContext, noEscape: boolean): string | undefined {
  try {
    return Handlebars.compile(source, { noEscape })(context)
  } catch (error: unknown) {
    console.error('email template failed to render', error)
    return undefined
  }
}

export function renderBody(source: string, context: TemplateContext): string | undefined {
  return render(source, context, false)
}

/**
 * Longest subject this will emit. Well past RFC 5322's recommended 78 and well
 * short of anything a receiver will fold into hundreds of lines — intake caps
 * only the body it accepts, not the name inside it, so `{{lead.name}}` can carry
 * tens of kilobytes into this header if nothing stops it.
 */
export const MAX_SUBJECT_LENGTH = 200

/**
 * A subject is a single header field, so every newline the rendered value
 * carries is collapsed. Without this a lead who types a CRLF into the name
 * field of a public form writes headers into the operator's notification.
 */
export function renderSubject(source: string, context: TemplateContext): string | undefined {
  const rendered = render(source, context, true)
  if (rendered === undefined) return undefined
  const collapsed = rendered.replace(/[\r\n]+/g, ' ').trim()
  if (collapsed.length <= MAX_SUBJECT_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd()}…`
}
