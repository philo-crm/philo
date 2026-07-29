import { eq } from 'drizzle-orm'
import type { Db } from './index.ts'
import { emailTemplates, pipelines, settings, stages } from './schema.ts'

export const DEFAULT_PIPELINE_NAME = 'Default'

/** DESIGN.md (Data model): the operator renames these in-app to their real funnel. */
export const DEFAULT_STAGES = [
  { name: 'New', isTerminal: false },
  { name: 'Contacted', isTerminal: false },
  { name: 'Qualified', isTerminal: false },
  { name: 'Closed', isTerminal: true },
] as const

/** Handlebars, rendered against the variables listed in DESIGN.md (Email). */
export const DEFAULT_EMAIL_TEMPLATES = [
  {
    trigger: 'new_lead_notify',
    subject: 'New lead: {{lead.name}}',
    body: [
      '<p>A new lead just came in.</p>',
      '<ul>',
      '  <li><strong>Name:</strong> {{lead.name}}</li>',
      '  <li><strong>Email:</strong> {{lead.email}}</li>',
      '  <li><strong>Phone:</strong> {{lead.phone}}</li>',
      '  <li><strong>Source:</strong> {{lead.source}}</li>',
      '</ul>',
      '<p><a href="{{lead_url}}">Open the lead</a></p>',
    ].join('\n'),
  },
  {
    trigger: 'new_lead_ack',
    subject: 'Thanks for getting in touch',
    body: [
      '<p>Hi {{lead.name}},</p>',
      '<p>Thanks for reaching out to {{business.name}}. We have your details and',
      'someone will be in touch shortly.</p>',
      '<p>&mdash; {{business.name}}</p>',
    ].join('\n'),
  },
] as const

/** Settings key recording that first-boot seeding has happened. */
export const SEEDED_AT_KEY = 'seeded_at'

/**
 * First-boot seeds, run exactly once per database and never again — an
 * operator who deletes every seeded stage or template has decided something,
 * and re-creating it on the next restart is a bug, not a repair. Checking the
 * marker rather than whether the tables are empty is what makes that hold: an
 * emptiness check resurrects a wholesale deletion on the next boot.
 *
 * Seeded data added after this point belongs in a migration, which has its own
 * once-per-database guarantee.
 */
export function seed(db: Db): void {
  db.transaction((tx) => {
    const seeded = tx
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, SEEDED_AT_KEY))
      .limit(1)
      .all()
    if (seeded.length > 0) return

    const [pipeline] = tx
      .insert(pipelines)
      .values({ name: DEFAULT_PIPELINE_NAME })
      .returning({ id: pipelines.id })
      .all()
    if (pipeline === undefined) throw new Error('Failed to seed the default pipeline')

    tx.insert(stages)
      .values(
        DEFAULT_STAGES.map((stage, position) => ({
          pipelineId: pipeline.id,
          name: stage.name,
          position,
          isTerminal: stage.isTerminal,
        })),
      )
      .run()

    tx.insert(emailTemplates)
      .values(DEFAULT_EMAIL_TEMPLATES.map((template) => ({ ...template })))
      .run()

    tx.insert(settings).values({ key: SEEDED_AT_KEY, value: new Date().toISOString() }).run()
  })
}
