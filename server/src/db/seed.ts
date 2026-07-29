import type { Db } from './index.ts'
import { emailTemplates, pipelines, stages } from './schema.ts'

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

/**
 * First-boot seeds. Each block runs only when its table is empty, so an
 * operator who deletes a seeded stage or template does not get it back on the
 * next restart — re-seeding a deliberate deletion is a bug, not a repair.
 */
export function seed(db: Db): void {
  db.transaction((tx) => {
    if (tx.select({ id: pipelines.id }).from(pipelines).limit(1).all().length === 0) {
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
    }

    if (tx.select({ id: emailTemplates.id }).from(emailTemplates).limit(1).all().length === 0) {
      tx.insert(emailTemplates)
        .values(DEFAULT_EMAIL_TEMPLATES.map((template) => ({ ...template })))
        .run()
    }
  })
}
