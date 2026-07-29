import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.ts'
import { DB_FILENAME, MIGRATIONS_DIR, openDatabase } from '../src/db/index.ts'
import { DEFAULT_EMAIL_TEMPLATES, SEEDED_AT_KEY } from '../src/db/seed.ts'
import { emailTemplates, leads, pipelines, settings, stages } from '../src/db/schema.ts'

interface Journal {
  entries: { idx: number; tag: string }[]
}

const tempDirs: string[] = []
const open: Db[] = []

afterEach(() => {
  for (const db of open.splice(0)) db.$client.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function openTracked(dataDir: string): Db {
  const db = openDatabase(dataDir)
  open.push(db)
  return db
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as Journal

/** A copy of the migrations folder truncated to its first `count` migrations. */
function partialMigrationsDir(count: number): string {
  const dir = tempDir('philo-migrations-')
  mkdirSync(join(dir, 'meta'))
  const entries = journal.entries.slice(0, count)
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  }
  return dir
}

/**
 * A database left at the first migration, already seeded and then worked in —
 * what an operator upgrading an installed instance actually hands the new
 * build. Its stage was renamed and its pipeline is not the seeded default, so
 * anything that re-seeds over an existing install shows up here.
 */
function seedSchemaDatabase(dataDir: string): void {
  const sqlite = new Database(join(dataDir, DB_FILENAME))
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: partialMigrationsDir(1) })

  const now = new Date()
  const [pipeline] = db
    .insert(pipelines)
    .values({ name: 'Recruiting', createdAt: now })
    .returning({ id: pipelines.id })
    .all()
  const [stage] = db
    .insert(stages)
    .values({ pipelineId: pipeline!.id, name: 'Applied', position: 0 })
    .returning({ id: stages.id })
    .all()
  db.insert(leads)
    .values({
      name: 'Dana Rivers',
      email: 'dana@example.com',
      currentStageId: stage!.id,
      fields: JSON.stringify({ endorsements: 'hazmat' }),
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(emailTemplates)
    .values(DEFAULT_EMAIL_TEMPLATES.map((template) => ({ ...template, updatedAt: now })))
    .run()
  db.insert(settings).values({ key: SEEDED_AT_KEY, value: now.toISOString(), updatedAt: now }).run()

  // Guards the fixture: if the first migration ever grows a search index, these
  // upgrade tests would silently stop exercising an upgrade at all.
  const fts = sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'leads_fts'").get()
  if (fts !== undefined) throw new Error('the seed schema already has leads_fts')
  sqlite.close()
}

/** Ids of the leads matching an FTS5 query. */
function search(db: Db, query: string): number[] {
  return db.$client
    .prepare<[string], { id: number }>(
      'SELECT l.id AS id FROM leads_fts JOIN leads l ON l.id = leads_fts.rowid WHERE leads_fts MATCH ?',
    )
    .all(query)
    .map((row) => row.id)
}

function appliedMigrations(db: Db): number {
  const row = db.$client
    .prepare<[], { count: number }>('SELECT count(*) AS count FROM __drizzle_migrations')
    .get()
  return row?.count ?? 0
}

describe('upgrading an existing database', () => {
  it('applies the migrations the old database is missing', () => {
    const dataDir = tempDir('philo-upgrade-')
    seedSchemaDatabase(dataDir)
    const db = openTracked(dataDir)
    expect(appliedMigrations(db)).toBe(journal.entries.length)
  })

  it('keeps the rows written before the upgrade', () => {
    const dataDir = tempDir('philo-upgrade-')
    seedSchemaDatabase(dataDir)
    const db = openTracked(dataDir)
    expect(db.select().from(leads).all()).toMatchObject([
      { name: 'Dana Rivers', email: 'dana@example.com' },
    ])
    expect(db.select().from(stages).all()).toMatchObject([{ name: 'Applied' }])
  })

  it('backfills pre-existing leads into the search index', () => {
    const dataDir = tempDir('philo-upgrade-')
    seedSchemaDatabase(dataDir)
    expect(search(openTracked(dataDir), 'hazmat')).toHaveLength(1)
  })

  it('indexes leads written after the upgrade', () => {
    const dataDir = tempDir('philo-upgrade-')
    seedSchemaDatabase(dataDir)
    const db = openTracked(dataDir)
    const [stage] = db.select().from(stages).limit(1).all()
    db.insert(leads).values({ name: 'Sam Brooks', currentStageId: stage!.id }).run()
    expect(search(db, 'Brooks')).toHaveLength(1)
  })

  it('does not re-seed an install that was already seeded', () => {
    const dataDir = tempDir('philo-upgrade-')
    seedSchemaDatabase(dataDir)
    const db = openTracked(dataDir)
    expect(db.select().from(pipelines).all()).toMatchObject([{ name: 'Recruiting' }])
    expect(db.select().from(stages).all()).toMatchObject([{ name: 'Applied' }])
    expect(db.select().from(emailTemplates).all()).toHaveLength(DEFAULT_EMAIL_TEMPLATES.length)
  })
})

describe('re-running migrations', () => {
  it('is a no-op on an already current database', () => {
    const dataDir = tempDir('philo-upgrade-')
    const first = openTracked(dataDir)
    const applied = appliedMigrations(first)
    first.$client.close()

    const second = openTracked(dataDir)
    expect(appliedMigrations(second)).toBe(applied)
    expect(second.select().from(pipelines).all()).toHaveLength(1)
  })

  it('applies every migration in the journal on a fresh database', () => {
    const db = openTracked(tempDir('philo-fresh-'))
    expect(appliedMigrations(db)).toBe(journal.entries.length)
    expect(journal.entries.length).toBeGreaterThan(1)
  })
})
