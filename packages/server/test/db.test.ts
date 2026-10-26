import Database from 'better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.ts'
import { DB_FILENAME, MIGRATIONS_DIR, openDatabase } from '../src/db/index.ts'
import * as schema from '../src/db/schema.ts'
import {
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_PIPELINE_NAME,
  DEFAULT_STAGES,
  SEEDED_AT_KEY,
  seed,
} from '../src/db/seed.ts'
import { emailTemplates, leadEvents, leads, pipelines, settings, stages } from '../src/db/schema.ts'

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

/** Migrated but not seeded — `openDatabase` always seeds, so build it by hand. */
function openUnseeded(dataDir: string): Db {
  const db = drizzle(new Database(join(dataDir, DB_FILENAME)), { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  open.push(db)
  return db
}

/** Rows in the search index. Must always equal the number of leads. */
function indexedCount(db: Db): number {
  return db.$client.prepare<[], { c: number }>('SELECT count(*) AS c FROM leads_fts').get()?.c ?? -1
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

  // Migrations run with foreign keys off, so this check is the only thing
  // between a migration that drops referenced rows and a database that claims
  // an integrity it does not have.
  it('refuses to boot a database holding a dangling reference', () => {
    const dataDir = tempDataDir()
    openTracked(dataDir).$client.close()

    const raw = new Database(join(dataDir, DB_FILENAME))
    raw.pragma('foreign_keys = OFF')
    raw
      .prepare(
        'INSERT INTO leads (current_stage_id, fields, created_at, updated_at) VALUES (99999, ?, 0, 0)',
      )
      .run('{}')
    raw.close()

    expect(() => openDatabase(dataDir)).toThrow(/foreign key violation/i)
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

  // The marker is written last, inside the same transaction as the rows. A seed
  // that failed partway and still left the marker would lock in a half-seeded
  // database that no later boot would repair.
  it('rolls the whole seed back when any part of it fails', () => {
    const db = openUnseeded(tempDataDir())
    // A template already holding the first funnel's slot, so the seed's own
    // insert collides with it. Foreign keys off to plant it ahead of its funnel.
    db.$client.pragma('foreign_keys = OFF')
    db.insert(emailTemplates)
      .values({ pipelineId: 1, trigger: 'new_lead_notify', subject: 'taken', body: 'taken' })
      .run()
    db.$client.pragma('foreign_keys = ON')

    expect(() => seed(db)).toThrow()
    expect(db.select().from(pipelines).all()).toEqual([])
    expect(db.select().from(stages).all()).toEqual([])
    expect(db.select().from(settings).where(eq(settings.key, SEEDED_AT_KEY)).all()).toEqual([])
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

  // DESIGN.md (Erasure): an older database freed space without zeroing it, and
  // the boot that upgrades it has to scrub that, or deleting a lead after the
  // upgrade still leaves what an earlier edit overwrote.
  it('scrubs free space once when upgrading a database written before secure_delete', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dataDir = tempDataDir()
    const olderMigrations = join(tempDataDir(), 'drizzle')
    cpSync(MIGRATIONS_DIR, olderMigrations, { recursive: true })
    // The database as the release before 0009 left it: that migration and every
    // later one are not applied yet.
    const journalPath = join(olderMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] }
    const cut = journal.entries.findIndex((entry) => entry.tag === '0009_leads_fts_secure_delete')
    for (const entry of journal.entries.slice(cut)) rmSync(join(olderMigrations, `${entry.tag}.sql`))
    journal.entries = journal.entries.slice(0, cut)
    writeFileSync(journalPath, JSON.stringify(journal))

    const sqlite = new Database(join(dataDir, DB_FILENAME))
    sqlite.pragma('journal_mode = WAL')
    const older = drizzle(sqlite, { schema })
    migrate(older, { migrationsFolder: olderMigrations })
    // Raw SQL: today's schema names funnel columns this one does not have yet.
    const pipelineId = sqlite.prepare("INSERT INTO pipelines (name, created_at) VALUES ('Default', 0)").run().lastInsertRowid
    const stageId = Number(
      sqlite.prepare("INSERT INTO stages (pipeline_id, name, position) VALUES (?, 'New', 0)").run(pipelineId).lastInsertRowid,
    )
    const [lead] = older
      .insert(leads)
      .values({ email: 'oldsecret-a-much-longer-address@example.com', currentStageId: stageId, fields: '{}' })
      .returning({ id: leads.id })
      .all()
    older.update(leads).set({ email: 'nv@example.com' }).where(eq(leads.id, lead!.id)).run()
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    sqlite.close()
    expect(readFileSync(join(dataDir, DB_FILENAME)).includes('oldsecret')).toBe(true)

    openTracked(dataDir)

    expect(readFileSync(join(dataDir, DB_FILENAME)).includes('oldsecret')).toBe(false)
    vi.restoreAllMocks()
  })

  // DESIGN.md (Erasure): both are needed for a deleted lead to leave no bytes.
  it('zeroes freed space, in the file and in the search index', () => {
    const db = openTracked(tempDataDir())
    expect(db.$client.pragma('secure_delete', { simple: true })).toBe(1)
    const option = db.$client
      .prepare<[], { v: number }>("SELECT v FROM leads_fts_config WHERE k = 'secure-delete'")
      .get()
    expect(option?.v).toBe(1)
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

  // A migration that re-runs the backfill without clearing the index first
  // leaves two index rows per lead, and every search then returns duplicates.
  it('holds exactly one index row per lead through inserts, updates, and deletes', () => {
    const db = openTracked(tempDataDir())
    const stageId = firstStageId(db)
    const [first] = db
      .insert(leads)
      .values({ name: 'Dana Rivers', currentStageId: stageId })
      .returning({ id: leads.id })
      .all()
    db.insert(leads).values({ name: 'Sam Brooks', currentStageId: stageId }).run()
    expect(indexedCount(db)).toBe(2)

    db.update(leads).set({ name: 'Dana Brooks' }).where(eq(leads.id, first!.id)).run()
    expect(indexedCount(db)).toBe(2)
    expect(search(db, 'Brooks')).toHaveLength(2)

    db.delete(leads).where(eq(leads.id, first!.id)).run()
    expect(indexedCount(db)).toBe(1)
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
