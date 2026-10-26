import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_LENGTH,
  MAX_CONTACT_FIELD_LENGTH,
  MAX_DETAIL_KEY_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_FUNNEL_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_NOTIFY_RECIPIENTS,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  MAX_SETTINGS_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  TEMPLATE_TRIGGERS,
  type PhiloClient,
} from '@philo/sdk'
import { z } from 'zod'
import { VERSION } from './version.ts'

/**
 * What the client is told this server is for. Read once, at connect time, so it
 * carries the things every tool description would otherwise have to repeat.
 */
const INSTRUCTIONS = `Philo is a single-tenant CRM for one business. The business may run several
funnels — one per intake flow — each with its own stages, intake forms, email
templates and sender settings; call list_funnels first. Every lead sits in one
funnel's stage and carries a timeline of what happened to it. Stage and template
tools take an optional funnelId; left out, they act on the default funnel.

Two things worth knowing before you write anything:

- What a lead submitted is in \`fields\` and never changes. What you learn
  afterwards goes in \`details\` (update_lead) or as a file (add_lead_attachment).
  Both may hold sensitive personal data when the business needs it; the
  timeline records which detail keys changed, never their values.
- Email templates are live. Editing one changes what the business sends out
  under its own name from the next lead onwards.

Tools answer with JSON. A call the CRM refuses comes back as an error result
whose text is a JSON object with an "error" code in it. A call whose arguments
do not match the schema is refused before it gets that far, and comes back as an
error result carrying a plain sentence about what is wrong — so read the text
before assuming it parses.`

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

/**
 * Runs one API call and answers with its result — under `key`, or as it came
 * when `key` is null. A refusal from
 * the API becomes an error result carrying the API's own code, so the model
 * sees exactly what a REST client would and can correct the call. Anything
 * else — the API unreachable — is a protocol failure, because there is nothing
 * the model could change in its arguments to fix it.
 */
async function call(key: string | null, request: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await request()
    return json(key === null ? value : { [key]: value })
  } catch (error) {
    if (error instanceof ApiError) return failure(error.code === '' ? `http_${error.status}` : error.code, error.detail)
    throw error
  }
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

const STAGE_ID = z.number().int().positive().describe('The stage id.')

const ATTACHMENT_ID = z.number().int().positive().describe('The attachment id, from get_lead.')

const FUNNEL_ID = z
  .number()
  .int()
  .positive()
  .describe('The funnel id, from list_funnels.')

const SCOPE = FUNNEL_ID.optional().describe('Which funnel, from list_funnels. Defaults to the default funnel.')

const STAGE_NAME = z.string().min(1).max(MAX_STAGE_NAME_LENGTH).describe('The stage name, as the board shows it.')

/**
 * Every tool, bound to one API client carrying the caller's own token — so the
 * API decides what the caller may do and the timeline records the caller, not
 * this server. MCP is a client of the API like any other (ADR-0006).
 *
 * Validation lives in the API, not here. The schemas below are types and
 * bounds, so a client sees what a field will take; what a value *means* —
 * whether a stage exists, whether a template compiles, whether a lead is left
 * contactable — is decided in exactly one place for every client.
 */
export function createMcpServer(philo: PhiloClient): McpServer {
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
        'full-text search over name, email, phone and the values in `fields` and `details`; it matches ' +
        'whole words and word prefixes, and is not a query language — type the words, not operators.',
      inputSchema: {
        funnelId: FUNNEL_ID.optional().describe('Only leads in this funnel. Defaults to every funnel.'),
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
    async (args) => {
      const createdAfter = parseDate(args.createdAfter)
      const createdBefore = parseDate(args.createdBefore)
      if (createdAfter === INVALID_DATE || createdBefore === INVALID_DATE) {
        return failure('invalid_date', 'createdAfter and createdBefore must parse as dates')
      }
      return call(null, () =>
        philo.leads.list({
          funnelId: args.funnelId,
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
      description:
        'One lead in full: contact details, submitted `fields`, added `details`, the list of ' +
        'attachments (metadata only — get_lead_attachment fetches one), and the whole timeline.',
      inputSchema: { leadId: LEAD_ID },
      annotations: { readOnlyHint: true },
    },
    (args) => call('lead', () => philo.leads.get(args.leadId)),
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
        funnelId: FUNNEL_ID.optional().describe(
          'Funnel to file it in, at its first stage, when stageId is left out. Defaults to the default funnel.',
        ),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Answers as a form would have submitted them, as free-form key/value pairs — the same ' +
              'place intake stores what a form asked. Fixed once filed; later additions go in `details`.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => call('lead', () => philo.leads.create(args)),
  )

  server.registerTool(
    'update_lead',
    {
      title: 'Update a lead',
      description:
        'Corrects contact details and adds to `details`. A field you leave out is unchanged; null ' +
        'clears it. The lead must still have an email or a phone afterwards. `details` merges by ' +
        'key: name only the keys you are setting, or null to remove one. The submitted answers in ' +
        '`fields` are not editable — they are the record of what the lead actually sent.',
      inputSchema: {
        leadId: LEAD_ID,
        name: z.string().max(MAX_CONTACT_FIELD_LENGTH).nullable().optional(),
        email: z.string().max(MAX_EMAIL_LENGTH).nullable().optional(),
        phone: z.string().max(MAX_CONTACT_FIELD_LENGTH).nullable().optional(),
        details: z
          .record(z.string().min(1).max(MAX_DETAIL_KEY_LENGTH), z.unknown())
          .optional()
          .describe('Keys to set (any JSON value) or remove (null), e.g. {"start_date": "2026-11-02"}.'),
      },
      // Destructive by the spec's meaning, which is "not additive": the old
      // name, email, phone and detail values are overwritten in place and no
      // timeline event records what they were. A client deciding what to auto-approve is
      // reading this, so it has to say so. Same at update_email_template.
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ leadId, ...patch }) => call('lead', () => philo.leads.update(leadId, patch)),
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
    (args) => call('lead', () => philo.leads.moveStage(args.leadId, args.stageId)),
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
    (args) => call('lead', () => philo.leads.addNote(args.leadId, args.note)),
  )

  server.registerTool(
    'add_lead_attachment',
    {
      title: 'Attach a file to a lead',
      description:
        `Stores a file on the lead, up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, and records it on ` +
        'the timeline. Answers with the whole lead; the new file is last in `attachments`.',
      inputSchema: {
        leadId: LEAD_ID,
        filename: z.string().min(1).max(MAX_ATTACHMENT_FILENAME_LENGTH).describe('e.g. "resume.pdf".'),
        contentType: z.string().optional().describe('MIME type, e.g. "application/pdf". Defaults to a generic one.'),
        data: z.base64().describe('The file content, base64-encoded.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) =>
      call('lead', () =>
        philo.leads.attachments.upload(args.leadId, {
          data: Uint8Array.from(Buffer.from(args.data, 'base64')),
          filename: args.filename,
          contentType: args.contentType,
        }),
      ),
  )

  server.registerTool(
    'get_lead_attachment',
    {
      title: 'Fetch a lead attachment',
      description: 'The content of one file on a lead, as an embedded resource. get_lead lists the ids.',
      inputSchema: { leadId: LEAD_ID, attachmentId: ATTACHMENT_ID },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const blob = await philo.leads.attachments.download(args.leadId, args.attachmentId)
        const data = Buffer.from(await blob.arrayBuffer())
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `philo://leads/${args.leadId}/attachments/${args.attachmentId}`,
                mimeType: blob.type === '' ? 'application/octet-stream' : blob.type,
                blob: data.toString('base64'),
              },
            },
          ],
        }
      } catch (error) {
        if (error instanceof ApiError) return failure(error.code === '' ? `http_${error.status}` : error.code)
        throw error
      }
    },
  )

  server.registerTool(
    'remove_lead_attachment',
    {
      title: 'Remove a lead attachment',
      description:
        'Deletes a file from the lead for good — the bytes are gone, not hidden. The timeline keeps ' +
        'a record that it was removed, with its name and size.',
      inputSchema: { leadId: LEAD_ID, attachmentId: ATTACHMENT_ID },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (args) => call('lead', () => philo.leads.attachments.remove(args.leadId, args.attachmentId)),
  )

  server.registerTool(
    'delete_lead',
    {
      title: 'Delete a lead',
      description:
        'Permanently erases a lead and everything held about it: contact, answers, details, ' +
        'timeline and files. This cannot be undone, and nothing records that the lead existed. ' +
        'Only call it when the user has explicitly asked for this lead to be deleted. To take a ' +
        'lead out of the funnel without erasing it, move it to a terminal stage instead.',
      inputSchema: { leadId: LEAD_ID },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (args) =>
      call(null, async () => {
        await philo.leads.delete(args.leadId)
        return { deleted: args.leadId }
      }),
  )

  server.registerTool(
    'list_stages',
    {
      title: 'List funnel stages',
      description:
        'The funnel in order, with how many leads sit in each stage. Stage names are the ' +
        'operator\'s and can be anything — read them rather than assuming the defaults.',
      inputSchema: { funnelId: SCOPE },
      annotations: { readOnlyHint: true },
    },
    (args) => call('stages', () => philo.stages.list(undefined, args.funnelId)),
  )

  server.registerTool(
    'create_stage',
    {
      title: 'Create a funnel stage',
      description:
        'Appends a stage to the end of the funnel; call reorder_stages to place it elsewhere. ' +
        'Names need not be unique. A terminal stage is one a lead finishes in, such as Hired or ' +
        'Rejected. A funnel already at the stage limit refuses with too_many_stages.',
      inputSchema: {
        funnelId: SCOPE,
        name: STAGE_NAME,
        isTerminal: z.boolean().optional().describe('Whether leads finish here. Defaults to false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => call('stage', () => philo.stages.create(args.name, args.isTerminal ?? false, args.funnelId)),
  )

  server.registerTool(
    'update_stage',
    {
      title: 'Update a funnel stage',
      description:
        'Renames a stage or changes whether it is terminal. A field you leave out is unchanged. ' +
        'Leads in the stage stay where they are.',
      inputSchema: {
        stageId: STAGE_ID,
        name: STAGE_NAME.optional(),
        isTerminal: z.boolean().optional().describe('Whether leads finish here.'),
      },
      // The old name is overwritten and nothing records what it was. Not additive.
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ stageId, ...patch }) => call('stage', () => philo.stages.update(stageId, patch)),
  )

  server.registerTool(
    'reorder_stages',
    {
      title: 'Reorder the funnel',
      description:
        'Sets the order of the whole funnel. Pass every stage id, each exactly once, in the new ' +
        'order. A partial list or a repeated id is refused with invalid_order and nothing moves. Call list_stages ' +
        'for the ids.',
      inputSchema: {
        funnelId: SCOPE,
        stageIds: z.array(STAGE_ID).min(1).describe('Every stage id of that funnel, first stage first.'),
      },
      // Replaces the previous order wholesale. Not additive.
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (args) => call('stages', () => philo.stages.reorder(args.stageIds, args.funnelId)),
  )

  server.registerTool(
    'delete_stage',
    {
      title: 'Delete a funnel stage',
      description:
        'Deletes an empty stage and answers with the funnel that remains. A stage that still ' +
        'holds leads, spam included, is refused with stage_not_empty: move them first. The last ' +
        'stage is refused with last_stage, because intake files every new lead under the first.',
      inputSchema: { stageId: STAGE_ID },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (args) => call('stages', () => philo.stages.delete(args.stageId)),
  )

  server.registerTool(
    'list_email_templates',
    {
      title: 'List email templates',
      description:
        'Both templates with their Handlebars source. Philo sends on lead creation only: ' +
        'new_lead_notify to the business, new_lead_ack to the lead who submitted.',
      inputSchema: { funnelId: SCOPE },
      annotations: { readOnlyHint: true },
    },
    (args) => call('templates', () => philo.emailTemplates.list(undefined, args.funnelId)),
  )

  server.registerTool(
    'get_email_template',
    {
      title: 'Get an email template',
      description: 'One template, with its Handlebars source and whether it is enabled.',
      inputSchema: { funnelId: SCOPE, trigger: TRIGGER },
      annotations: { readOnlyHint: true },
    },
    (args) => call('template', () => philo.emailTemplates.get(args.trigger, undefined, args.funnelId)),
  )

  server.registerTool(
    'update_email_template',
    {
      title: 'Update an email template',
      description:
        'Saves a template. A field you leave out is unchanged. Handlebars source, HTML-escaped ' +
        'by default; available variables are {{lead.name}}, {{lead.email}}, {{lead.phone}}, ' +
        '{{lead.source}}, {{lead.fields.*}}, {{business.name}}, {{funnel.name}} and {{lead_url}}. Source that ' +
        'does not compile is refused with the message Handlebars gave, and nothing is saved. ' +
        'This changes what real leads are sent from the next one onwards — preview first.',
      inputSchema: {
        funnelId: SCOPE,
        trigger: TRIGGER,
        subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
        body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH).optional().describe('HTML body.'),
        enabled: z.boolean().optional().describe('False stops this email being sent at all.'),
      },
      // The previous source is gone, there is no version history, and
      // `enabled: false` switches off the channel ADR-0004 makes the guaranteed
      // one. Not additive, so not `destructiveHint: false`.
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ trigger, funnelId, ...patch }) =>
      call('template', () => philo.emailTemplates.update(trigger, patch, funnelId)),
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
        funnelId: SCOPE,
        trigger: TRIGGER,
        subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
        body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH).optional(),
        leadId: z.number().int().positive().optional().describe('Render against this real lead.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ trigger, funnelId, ...input }) =>
      call('preview', () => philo.emailTemplates.preview(trigger, input, funnelId)),
  )

  registerFunnelTools(server, philo)

  return server
}

const FUNNEL_SETTINGS = {
  fromName: z
    .string()
    .max(MAX_SETTINGS_NAME_LENGTH)
    .optional()
    .describe("Sender display name for this funnel's email. Empty inherits the instance's."),
  replyTo: z
    .string()
    .max(MAX_EMAIL_LENGTH)
    .optional()
    .describe("Where replies to this funnel's acknowledgment go. Empty inherits the instance's."),
  notifyRecipients: z
    .array(z.string().max(MAX_EMAIL_LENGTH))
    .max(MAX_NOTIFY_RECIPIENTS)
    .optional()
    .describe('Who gets the new-lead notification. Empty: everyone who can sign in.'),
}

/** Funnels — ADR-0009: each intake flow with its own stages, forms, templates and senders. */
function registerFunnelTools(server: McpServer, philo: PhiloClient): void {
  server.registerTool(
    'list_funnels',
    {
      title: 'List funnels',
      description:
        "Every funnel: its name, whether it is the default, its sender settings, how many leads it " +
        "holds, and its intake forms with the URL a website posts to. The mail server, From address " +
        'and business name are instance-wide; a funnel overrides only what it names.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => call('funnels', () => philo.funnels.list()),
  )

  server.registerTool(
    'create_funnel',
    {
      title: 'Create a funnel',
      description:
        'A new intake flow, born with the default stages, both email templates and one intake ' +
        'form. Rename its stages and edit its templates afterwards.',
      inputSchema: { name: z.string().min(1).max(MAX_FUNNEL_NAME_LENGTH) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => call('funnel', () => philo.funnels.create(args.name)),
  )

  server.registerTool(
    'update_funnel',
    {
      title: 'Update a funnel',
      description:
        'Renames a funnel or changes its sender settings. A field you leave out is unchanged; an ' +
        'empty value clears the override so the instance setting applies again.',
      inputSchema: {
        funnelId: FUNNEL_ID,
        name: z.string().min(1).max(MAX_FUNNEL_NAME_LENGTH).optional(),
        ...FUNNEL_SETTINGS,
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ funnelId, ...patch }) => call('funnel', () => philo.funnels.update(funnelId, patch)),
  )

  server.registerTool(
    'delete_funnel',
    {
      title: 'Delete a funnel',
      description:
        'Deletes an empty funnel with its stages, templates and intake forms — its form URLs stop ' +
        'working. A funnel holding leads is refused with funnel_not_empty; the last funnel with last_funnel.',
      inputSchema: { funnelId: FUNNEL_ID },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (args) => call('funnels', () => philo.funnels.delete(args.funnelId)),
  )
}
