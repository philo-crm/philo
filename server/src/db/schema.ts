import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Integer primary keys are rowid aliases, so they survive `VACUUM` — the
 * `leads_fts` index is keyed on them (see the FTS migration). AUTOINCREMENT
 * additionally stops a deleted row's id from being handed to a later row,
 * which would silently repoint links and events at the wrong record.
 */
function id() {
  return integer('id').primaryKey({ autoIncrement: true })
}

function timestamp(name: string) {
  return integer(name, { mode: 'timestamp_ms' })
}

function createdAt() {
  return timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date())
}

function updatedAt() {
  return timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
}

/** One row, seeded at first boot. No pipeline-management UI in the MVP. */
export const pipelines = sqliteTable('pipelines', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const stages = sqliteTable(
  'stages',
  {
    id: id(),
    pipelineId: integer('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Sort order within the pipeline. Not unique: reordering swaps positions. */
    position: integer('position').notNull(),
    isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [index('stages_pipeline_position_idx').on(table.pipelineId, table.position)],
)

export const intakeForms = sqliteTable('intake_forms', {
  id: id(),
  name: text('name').notNull(),
  /** Unguessable slug in the public POST URL. Identifies a form; never authenticates. */
  formKey: text('form_key').notNull().unique(),
  /** JSON array of origins echoed on CORS preflight. */
  allowedOrigins: text('allowed_origins').notNull().default('[]'),
  createdAt: createdAt(),
})

export const leads = sqliteTable(
  'leads',
  {
    id: id(),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    source: text('source'),
    /** Null for leads created through REST or MCP rather than an intake form. */
    formId: integer('form_id').references(() => intakeForms.id, { onDelete: 'set null' }),
    currentStageId: integer('current_stage_id')
      .notNull()
      .references(() => stages.id, { onDelete: 'restrict' }),
    /** Raw intake payload minus the reserved keys — see ADR-0003. */
    fields: text('fields').notNull().default('{}'),
    isSpam: integer('is_spam', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('leads_current_stage_idx').on(table.currentStageId),
    index('leads_created_at_idx').on(table.createdAt),
    index('leads_email_idx').on(table.email),
    index('leads_is_spam_idx').on(table.isSpam),
    // The FTS trigger runs `json_each(fields)`, which errors on malformed
    // input; rejecting it at write time keeps a bad write from wedging inserts.
    check('leads_fields_json', sql`json_valid(${table.fields})`),
  ],
)

/**
 * Append-only timeline. A log, never the source of truth — nothing replays it,
 * and on disagreement the row it describes wins.
 */
export const leadEvents = sqliteTable(
  'lead_events',
  {
    id: id(),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['created', 'stage_changed', 'note_added', 'email_sent'],
    }).notNull(),
    payload: text('payload').notNull().default('{}'),
    /** Who caused it: `user:<id>`, `api_key:<id>`, `form:<form_key>`, `system`. */
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('lead_events_lead_created_idx').on(table.leadId, table.createdAt),
    check('lead_events_payload_json', sql`json_valid(${table.payload})`),
  ],
)

export const emailTemplates = sqliteTable('email_templates', {
  id: id(),
  /** Enum grows to `stage_changed:<stage>` post-MVP — see DESIGN.md (Email). */
  trigger: text('trigger', { enum: ['new_lead_notify', 'new_lead_ack'] })
    .notNull()
    .unique(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: updatedAt(),
})

/** Everything configurable that the process does not need before it can serve. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: updatedAt(),
})

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  /** argon2id. */
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const sessions = sqliteTable(
  'sessions',
  {
    /** The session token itself, hashed — a stolen DB must not yield live sessions. */
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
)

export const apiKeys = sqliteTable('api_keys', {
  id: id(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  /** Leading `philo_…` characters, so the UI can label a key it can never show again. */
  keyPrefix: text('key_prefix').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at'),
})

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpoint)],
)
