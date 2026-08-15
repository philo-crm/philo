import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Db } from '../db/index.ts'
import {
  getEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  updateEmailTemplate,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  TEMPLATE_TRIGGERS,
  type TemplateResult,
} from '../email/templates.ts'
import {
  addLeadNote,
  createLead,
  getLead,
  listLeads,
  moveLeadStage,
  updateLeadContact,
  DEFAULT_PAGE_SIZE,
  MAX_CONTACT_FIELD_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  type LeadError,
} from '../leads/service.ts'
import type { Result } from '../result.ts'
import { listStages } from '../stages/service.ts'
import { VERSION } from '../version.ts'

export interface McpServerDeps {
  db: Db
  /** Builds `{{lead_url}}` in a template preview, as the send path does. */
  publicBaseUrl: string
}

/**
 * What the client is told this server is for. Read once, at connect time, so it
 * carries the things every tool description would otherwise have to repeat.
 */
const INSTRUCTIONS = `Philo is a single-tenant CRM for one business. Leads move through one funnel of
stages; every lead carries a timeline of what happened to it.

Two things worth knowing before you write anything:

- Philo is for pre-screening only. Never record government identifiers of any
  kind — no social security number, no driver's licence number, no date of
  birth. Contact details and qualification answers only.
- Email templates are live. Editing one changes what the business sends out
  under its own name from the next lead onwards.

Tools answer with JSON. A refused call comes back as an error result whose text
is a JSON object with an "error" code in it.`

/** The shape every tool answers with: JSON an agent can parse without guessing. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/**
 * A refusal. `isError` rather than a thrown exception, so the model sees the
 * code and can correct the call instead of the whole request failing.
 */
function failure(error: string, detail?: string | undefined): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error, ...(detail === undefined ? {} : { detail }) }) },
    ],
    isError: true,
  }
}

function leadResult(result: Result<unknown, LeadError>): CallToolResult {
  return result.ok ? json({ lead: result.value }) : failure(result.error)
}

function templateResult<T>(result: TemplateResult<T>, key: string): CallToolResult {
  return result.ok ? json({ [key]: result.value }) : failure(result.error, result.detail)
}

/**
 * Parsed the way the REST surface parses the same filter — `new Date(raw)`, so
 * `2026-01-01` and a full timestamp both work. Undefined means "no bound";
 * INVALID is a value that named a date and did not parse, which is refused
 * rather than dropped: a filter that quietly widens itself is how a quarantined
 * lead ends up in the funnel view.
 */
const INVALID_DATE = Symbol('invalid_date')

function parseDate(raw: string | undefined): Date | undefined | typeof INVALID_DATE {
  if (raw === undefined) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? INVALID_DATE : date
}

const TRIGGER = z
  .enum(TEMPLATE_TRIGGERS)
  .describe('Which email: new_lead_notify goes to the business, new_lead_ack to the lead.')

const LEAD_ID = z.number().int().positive().describe('The lead id.')

/**
 * Every tool, bound to one database and one actor — the timeline records who
 * moved a lead, and for MCP that is always the API key the request arrived with
 * (`api_key:<id>`), never a user.
 *
 * Validation lives in the service layer, not here. The schemas below are types
 * and bounds, so a client sees what a field will take; what a value *means* —
 * whether a stage exists, whether a template compiles, whether a lead is left
 * contactable — is decided in exactly one place for both surfaces.
 */
export function createMcpServer(deps: McpServerDeps, actor: string): McpServer {
  const { db, publicBaseUrl } = deps
  const server = new McpServer(
    { name: 'philo', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'list_leads',
    {
      title: 'List leads',
      description:
        'Leads newest first, with a total for paging. Filters combine. `search` is a ' +
        'full-text search over name, email, phone and the answers in `fields`; it matches ' +
        'whole words and word prefixes, and is not a query language — type the words, not operators.',
      inputSchema: {
        stageId: z.number().int().positive().optional().describe('Only leads in this stage.'),
        formId: z.number().int().positive().optional().describe('Only leads from this intake form.'),
        spam: z
          .boolean()
          .optional()
          .describe('Return the spam quarantine instead of the funnel. Defaults to false.'),
        search: z.string().max(MAX_SEARCH_LENGTH).optional().describe('Words to search for.'),
        createdAfter: z.string().optional().describe('ISO date or timestamp, inclusive lower bound.'),
        createdBefore: z.string().optional().describe('ISO date or timestamp, inclusive upper bound.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Page size, up to ${MAX_PAGE_SIZE}. Defaults to ${DEFAULT_PAGE_SIZE}.`),
        offset: z.number().int().min(0).optional().describe('How many leads to skip.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const createdAfter = parseDate(args.createdAfter)
      const createdBefore = parseDate(args.createdBefore)
      if (createdAfter === INVALID_DATE || createdBefore === INVALID_DATE) {
        return failure('invalid_date', 'createdAfter and createdBefore must parse as dates')
      }
      return json(
        listLeads(db, {
          stageId: args.stageId,
          formId: args.formId,
          isSpam: args.spam ?? false,
          search: args.search,
          createdAfter,
          createdBefore,
          limit: args.limit ?? DEFAULT_PAGE_SIZE,
          offset: args.offset ?? 0,
        }),
      )
    },
  )

  server.registerTool(
    'get_lead',
    {
      title: 'Get a lead',
      description: 'One lead in full, with its whole timeline: creation, stage moves, notes, emails sent.',
      inputSchema: { leadId: LEAD_ID },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const lead = getLead(db, args.leadId)
      return lead === undefined ? failure('not_found') : json({ lead })
    },
  )

  server.registerTool(
    'create_lead',
    {
      title: 'Create a lead',
      description:
        'Files a lead that was not submitted through an intake form — a phone screen you took, ' +
        'a referral. At least one of email or phone is required, because the point of a lead is ' +
        'that someone can answer it. Sends no email: the acknowledgment template thanks a person ' +
        'for a submission, and there was none.',
      inputSchema: {
        name: z.string().max(MAX_CONTACT_FIELD_LENGTH).optional(),
        email: z.string().max(MAX_EMAIL_LENGTH).optional(),
        phone: z.string().max(MAX_CONTACT_FIELD_LENGTH).optional(),
        source: z
          .string()
          .max(MAX_CONTACT_FIELD_LENGTH)
          .optional()
          .describe('Where it came from, in your own words — e.g. "Phone screen", "Referral".'),
        stageId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Stage to file it under. Defaults to the first stage of the funnel.'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Pre-screening answers, as free-form key/value pairs — the same place intake stores ' +
              'what a form asked. No government identifiers.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => leadResult(createLead(db, args, actor)),
  )

  server.registerTool(
    'update_lead',
    {
      title: 'Update a lead',
      description:
        'Corrects contact details. A field you leave out is unchanged; null clears it. The lead ' +
        'must still have an email or a phone afterwards. The submitted answers in `fields` are ' +
        'not editable — they are the record of what the applicant actually sent.',
      inputSchema: {
        leadId: LEAD_ID,
        name: z.string().max(MAX_CONTACT_FIELD_LENGTH).nullable().optional(),
        email: z.string().max(MAX_EMAIL_LENGTH).nullable().optional(),
        phone: z.string().max(MAX_CONTACT_FIELD_LENGTH).nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ leadId, ...patch }) => leadResult(updateLeadContact(db, leadId, patch)),
  )

  server.registerTool(
    'move_lead_stage',
    {
      title: 'Move a lead to a stage',
      description:
        'Moves a lead to any stage — transitions are unrestricted. Recorded on the timeline. ' +
        'Moving a lead to the stage it is already in changes nothing and records nothing. ' +
        'Call list_stages for the ids.',
      inputSchema: { leadId: LEAD_ID, stageId: z.number().int().positive().describe('Stage to move to.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) => leadResult(moveLeadStage(db, args.leadId, args.stageId, actor)),
  )

  server.registerTool(
    'add_lead_note',
    {
      title: 'Add a note to a lead',
      description:
        'Appends a note to the lead\'s timeline. The timeline is append-only: a note cannot be ' +
        'edited or removed afterwards.',
      inputSchema: {
        leadId: LEAD_ID,
        note: z.string().min(1).max(MAX_NOTE_LENGTH).describe('The note, as plain text.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => leadResult(addLeadNote(db, args.leadId, args.note, actor)),
  )

  server.registerTool(
    'list_stages',
    {
      title: 'List funnel stages',
      description:
        'The funnel in order, with how many leads sit in each stage. Stage names are the ' +
        'operator\'s and can be anything — read them rather than assuming the defaults.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => json({ stages: listStages(db) }),
  )

  server.registerTool(
    'list_email_templates',
    {
      title: 'List email templates',
      description:
        'Both templates with their Handlebars source. Philo sends on lead creation only: ' +
        'new_lead_notify to the business, new_lead_ack to the lead who submitted.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => json({ templates: listEmailTemplates(db) }),
  )

  server.registerTool(
    'get_email_template',
    {
      title: 'Get an email template',
      description: 'One template, with its Handlebars source and whether it is enabled.',
      inputSchema: { trigger: TRIGGER },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const template = getEmailTemplate(db, args.trigger)
      return template === undefined ? failure('not_found') : json({ template })
    },
  )

  server.registerTool(
    'update_email_template',
    {
      title: 'Update an email template',
      description:
        'Saves a template. A field you leave out is unchanged. Handlebars source, HTML-escaped ' +
        'by default; available variables are {{lead.name}}, {{lead.email}}, {{lead.phone}}, ' +
        '{{lead.source}}, {{lead.fields.*}}, {{business.name}} and {{lead_url}}. Source that ' +
        'does not compile is refused with the message Handlebars gave, and nothing is saved. ' +
        'This changes what real leads are sent from the next one onwards — preview first.',
      inputSchema: {
        trigger: TRIGGER,
        subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
        body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH).optional().describe('HTML body.'),
        enabled: z.boolean().optional().describe('False stops this email being sent at all.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ trigger, ...patch }) =>
      templateResult(updateEmailTemplate(db, publicBaseUrl, trigger, patch), 'template'),
  )

  server.registerTool(
    'preview_email_template',
    {
      title: 'Preview an email template',
      description:
        'Renders a template and saves nothing, so you can iterate without sending anything. ' +
        'Pass subject and body to preview a draft; leave them out to render what is stored. ' +
        'Without leadId it renders against a built-in sample lead, so it works on an instance ' +
        'that has no leads yet.',
      inputSchema: {
        trigger: TRIGGER,
        subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
        body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH).optional(),
        leadId: z.number().int().positive().optional().describe('Render against this real lead.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ trigger, ...input }) =>
      templateResult(previewEmailTemplate(db, publicBaseUrl, trigger, input), 'preview'),
  )

  return server
}
