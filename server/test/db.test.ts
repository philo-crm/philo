import { asc, eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.ts'
import { DB_FILENAME, openDatabase } from '../src/db/index.ts'
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_PIPELINE_NAME, DEFAULT_STAGES } from '../src/db/seed.ts'
import { emailTemplates, leadEvents, leads, pipelines, stages } from '../src/db/schema.ts'

const dataDirs: string[] = []
const open: Db[] = []

afterEach(() => {
  for (const db of open.splice(0)) db.$client.close()
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-db-'))
  dataDirs.push(dir)
  return dir
}

function openTracked(dataDir: string): Db {
  const db = openDatabase(dataDir)
  open.push(db)
  return db
}

function firstStageId(db: Db): number {
  const [stage] = db.select().from(stages).orderBy(asc(stages.position)).limit(1).all()
  if (stage === undefined) throw new Error('no seeded stages')
  return stage.id
}

/** Ids of the leads matching an FTS5 query. */
function search(db: Db, query: string): number[] {
  const rows = db.$client
    .prepare<[string], { id: number }>(
      'SELECT l.id AS id FROM leads_fts JOIN leads l ON l.id = leads_fts.rowid WHERE leads_fts MATCH ?',
    )
    .all(query)
  return rows.map((row) => row.id)
}

describe('openDatabase', () => {
  it('creates the database file inside the data dir', () => {
    const dataDir = tempDataDir()
    openTracked(dataDir)
    expect(existsSync(join(dataDir, DB_FILENAME))).toBe(true)
  })

  it('creates a data dir that does not exist yet', () => {
    const dataDir = join(tempDataDir(), 'nested', 'state')
    openTracked(dataDir)
    expect(existsSync(join(dataDir, DB_FILENAME))).toBe(true)
  })

  it('enables WAL and foreign key enforcement', () => {
    const db = openTracked(tempDataDir())
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('first-boot seeds', () => {
  it('seeds one default pipeline', () => {
    const db = openTracked(tempDataDir())
    expect(db.select().from(pipelines).all()).toMatchObject([{ name: DEFAULT_PIPELINE_NAME }])
  })

  it('seeds the default stages in order, with only the last one terminal', () => {
    const db = openTracked(tempDataDir())
    const seeded = db.select().from(stages).orderBy(asc(stages.position)).all()
    expect(seeded.map((stage) => stage.name)).toEqual(['New', 'Contacted', 'Qualified', 'Closed'])
    expect(seeded.map((stage) => stage.position)).toEqual([0, 1, 2, 3])
    expect(seeded.map((stage) => stage.isTerminal)).toEqual([false, false, false, true])
    expect(seeded).toHaveLength(DEFAULT_STAGES.length)
  })

  it('attaches every seeded stage to the default pipeline', () => {
    const db = openTracked(tempDataDir())
    const [pipeline] = db.select().from(pipelines).all()
    expect(pipeline).toBeDefined()
    for (const stage of db.select().from(stages).all()) {
      expect(stage.pipelineId).toBe(pipeline?.id)
    }
  })

  it('seeds an enabled notify and ack email template', () => {
    const db = openTracked(tempDataDir())
    const seeded = db.select().from(emailTemplates).orderBy(asc(emailTemplates.id)).all()
    expect(seeded.map((template) => template.trigger)).toEqual(
      DEFAULT_EMAIL_TEMPLATES.map((template) => template.trigger),
    )
    expect(seeded.every((template) => template.enabled)).toBe(true)
    expect(seeded.every((template) => template.subject !== '' && template.body !== '')).toBe(true)
  })
})

describe('reboot', () => {
  it('does not duplicate seeds', () => {
    const dataDir = tempDataDir()
    openTracked(dataDir).$client.close()
    const db = openTracked(dataDir)
    expect(db.select().from(pipelines).all()).toHaveLength(1)
    expect(db.select().from(stages).all()).toHaveLength(DEFAULT_STAGES.length)
    expect(db.select().from(emailTemplates).all()).toHaveLength(DEFAULT_EMAIL_TEMPLATES.length)
  })

  it('keeps operator edits to seeded rows', () => {
    const dataDir = tempDataDir()
    const first = openTracked(dataDir)
    first.update(stages).set({ name: 'Screening' }).where(eq(stages.position, 0)).run()
    first.$client.close()

    const second = openTracked(dataDir)
    expect(second.select().from(stages).orderBy(asc(stages.position)).all()[0]?.name).toBe(
      'Screening',
    )
  })

  it('does not resurrect a stage the operator deleted', () => {
    const dataDir = tempDataDir()
    const first = openTracked(dataDir)
    first.delete(stages).where(eq(stages.name, 'Contacted')).run()
    first.$client.close()

    const second = openTracked(dataDir)
    expect(second.select().from(stages).all().map((stage) => stage.name)).toEqual([
      'New',
      'Qualified',
      'Closed',
    ])
  })

  it('does not resurrect email templates the operator deleted outright', () => {
    const dataDir = tempDataDir()
    const first = openTracked(dataDir)
    first.delete(emailTemplates).run()
    first.$client.close()

    expect(openTracked(dataDir).select().from(emailTemplates).all()).toEqual([])
  })

  it('preserves rows written before the restart', () => {
    const dataDir = tempDataDir()
    const first = openTracked(dataDir)
    first.insert(leads).values({ name: 'Dana Rivers', currentStageId: firstStageId(first) }).run()
    first.$client.close()

    const second = openTracked(dataDir)
    expect(second.select().from(leads).all()).toMatchObject([{ name: 'Dana Rivers' }])
  })
})

describe('lead constraints', () => {
  it('cascades lead events when a lead is deleted', () => {
    const db = openTracked(tempDataDir())
    const [lead] = db
      .insert(leads)
      .values({ name: 'Dana Rivers', currentStageId: firstStageId(db) })
      .returning({ id: leads.id })
      .all()
    db.insert(leadEvents).values({ leadId: lead!.id, type: 'created', actor: 'system' }).run()

    db.delete(leads).where(eq(leads.id, lead!.id)).run()
    expect(db.select().from(leadEvents).all()).toEqual([])
  })

  it('refuses to delete a stage that still holds leads', () => {
    const db = openTracked(tempDataDir())
    const stageId = firstStageId(db)
    db.insert(leads).values({ name: 'Dana Rivers', currentStageId: stageId }).run()
    expect(() => db.delete(stages).where(eq(stages.id, stageId)).run()).toThrow(/FOREIGN KEY/i)
  })

  it('rejects a fields payload that is not valid JSON', () => {
    const db = openTracked(tempDataDir())
    expect(() =>
      db.insert(leads).values({ currentStageId: firstStageId(db), fields: 'nope' }).run(),
    ).toThrow(/CHECK constraint/i)
  })

  it('defaults fields to an empty object and is_spam to false', () => {
    const db = openTracked(tempDataDir())
    db.insert(leads).values({ email: 'dana@example.com', currentStageId: firstStageId(db) }).run()
    expect(db.select().from(leads).all()).toMatchObject([{ fields: '{}', isSpam: false }])
  })
})

describe('full-text search', () => {
  // A migration that rebuilds `leads` — drizzle-kit's strategy for most SQLite
  // column changes — drops its triggers along with it, and search then goes
  // quietly stale instead of failing. This is the assertion that catches it.
  it('keeps all three sync triggers installed', () => {
    const db = openTracked(tempDataDir())
    const triggers = db.$client
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'leads' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(triggers).toEqual(['leads_fts_delete', 'leads_fts_insert', 'leads_fts_update'])
  })

  it('indexes name, email, phone, and the values in fields', () => {
    const db = openTracked(tempDataDir())
    const [lead] = db
      .insert(leads)
      .values({
        name: 'Dana Rivers',
        email: 'dana@example.com',
        phone: '5550100',
        currentStageId: firstStageId(db),
        fields: JSON.stringify({ endorsements: 'hazmat tanker', equipment: 'dry van' }),
      })
      .returning({ id: leads.id })
      .all()

    for (const term of ['Rivers', 'dana', '5550100', 'hazmat', '"dry van"']) {
      expect(search(db, term), `expected ${term} to match`).toEqual([lead!.id])
    }
  })

  it('does not index the field keys, only their values', () => {
    const db = openTracked(tempDataDir())
    db.insert(leads)
      .values({
        name: 'Dana Rivers',
        currentStageId: firstStageId(db),
        fields: JSON.stringify({ endorsements: 'hazmat' }),
      })
      .run()
    expect(search(db, 'endorsements')).toEqual([])
  })

  it('reaches values nested inside fields without indexing their keys', () => {
    const db = openTracked(tempDataDir())
    const [lead] = db
      .insert(leads)
      .values({
        name: 'Dana Rivers',
        currentStageId: firstStageId(db),
        fields: JSON.stringify({
          endorsements: ['hazmat', 'tanker'],
          availability: { earliest_start: 'immediately' },
        }),
      })
      .returning({ id: leads.id })
      .all()

    expect(search(db, 'tanker')).toEqual([lead!.id])
    expect(search(db, 'immediately')).toEqual([lead!.id])
    expect(search(db, 'earliest')).toEqual([])
  })

  it('follows updates', () => {
    const db = openTracked(tempDataDir())
    const [lead] = db
      .insert(leads)
      .values({ name: 'Dana Rivers', currentStageId: firstStageId(db) })
      .returning({ id: leads.id })
      .all()

    db.update(leads).set({ name: 'Dana Brooks' }).where(eq(leads.id, lead!.id)).run()
    expect(search(db, 'Rivers')).toEqual([])
    expect(search(db, 'Brooks')).toEqual([lead!.id])
  })

  it('drops deleted leads from the index', () => {
    const db = openTracked(tempDataDir())
    const [lead] = db
      .insert(leads)
      .values({ name: 'Dana Rivers', currentStageId: firstStageId(db) })
      .returning({ id: leads.id })
      .all()

    db.delete(leads).where(eq(leads.id, lead!.id)).run()
    expect(search(db, 'Rivers')).toEqual([])
  })

  it('matches only the lead that has the term', () => {
    const db = openTracked(tempDataDir())
    const stageId = firstStageId(db)
    const [match] = db
      .insert(leads)
      .values({ name: 'Dana Rivers', currentStageId: stageId })
      .returning({ id: leads.id })
      .all()
    db.insert(leads).values({ name: 'Sam Brooks', currentStageId: stageId }).run()
    expect(search(db, 'Rivers')).toEqual([match!.id])
  })
})
