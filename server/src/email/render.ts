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
 * A render that worked, or the sentence Handlebars gave for why it did not.
 * That sentence is the whole value of the failure to someone editing a
 * template — "Parse error on line 3" is what tells them where the typo is —
 * so it is carried rather than flattened into a code.
 */
export type RenderResult = { ok: true; value: string } | { ok: false; message: string }

/** Enough of a Handlebars complaint to act on, without pasting a stack into a screen. */
export const MAX_RENDER_ERROR_LENGTH = 300

/**
 * Renders one template. Compilation and evaluation both throw on input this
 * cannot control — an unclosed block, a helper that does not exist — and the
 * answer to either is the same: no email rather than a crashed hook.
 *
 * `noEscape` is the caller's call because the two halves are different media.
 * A body is HTML and must escape what a stranger typed into a form; a subject
 * is a header, where `&amp;` would be shown literally to the reader.
 */
function render(source: string, context: TemplateContext, noEscape: boolean): RenderResult {
  try {
    return { ok: true, value: Handlebars.compile(source, { noEscape })(context) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const trimmed = message.trim()
    return {
      ok: false,
      message: (trimmed === '' ? 'the template could not be rendered' : trimmed).slice(
        0,
        MAX_RENDER_ERROR_LENGTH,
      ),
    }
  }
}

/** The body, or the complaint — for the editor, which has someone to show it to. */
export function renderBodyResult(source: string, context: TemplateContext): RenderResult {
  return render(source, context, false)
}

/** The same for the send path, where there is nobody to tell and the answer is silence. */
export function renderBody(source: string, context: TemplateContext): string | undefined {
  return swallow(renderBodyResult(source, context))
}

function swallow(result: RenderResult): string | undefined {
  if (result.ok) return result.value
  console.error('email template failed to render', result.message)
  return undefined
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
export function renderSubjectResult(source: string, context: TemplateContext): RenderResult {
  const rendered = render(source, context, true)
  if (!rendered.ok) return rendered
  const collapsed = rendered.value.replace(/[\r\n]+/g, ' ').trim()
  if (collapsed.length <= MAX_SUBJECT_LENGTH) return { ok: true, value: collapsed }
  return { ok: true, value: `${collapsed.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd()}…` }
}

export function renderSubject(source: string, context: TemplateContext): string | undefined {
  return swallow(renderSubjectResult(source, context))
}
