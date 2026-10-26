import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.ts'
import { seed } from './seed.ts'

/** The SQLite file, inside PHILO_DATA_DIR. Backup is a copy of that directory. */
export const DB_FILENAME = 'philo.db'

/**
 * Committed SQL migrations. Resolved relative to this module so it holds from
 * `src/` (dev, tests) and `dist/` (build, container) alike — both sit two
 * levels under `server/`.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

export type Db = ReturnType<typeof drizzle<typeof schema>>

const BUSY_TIMEOUT_MS = 5000

/**
 * Migrations applied once 0009 (FTS5 secure-delete) is in. A database that had
 * fewer was written without `secure_delete`, so its free space may still hold
 * old values — see `openDatabase`.
 */
const ERASURE_MIGRATION_COUNT = 10

function appliedMigrations(sqlite: Database.Database): number {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get()
  if (table === undefined) return 0
  return sqlite.prepare<[], { c: number }>('SELECT count(*) AS c FROM __drizzle_migrations').get()?.c ?? 0
}

/**
 * Copies the WAL into the file and empties it, so old page images stop being
 * readable from it — DESIGN.md (Erasure). Never waits: a reader holding the WAL
 * (an online backup) would otherwise block the event loop for the whole busy
 * timeout. Answers whether it completed.
 */
export function truncateWal(db: Db): boolean {
  const sqlite = db.$client
  sqlite.pragma('busy_timeout = 0')
  try {
    const [result] = sqlite.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    return result !== undefined && result.busy === 0
  } finally {
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  }
}

/**
 * Opens the database, brings it up to the current schema, and applies
 * first-boot seeds. Safe to call against a fresh directory or an existing
 * database; both land in the same state.
 */
export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, DB_FILENAME))
  // WAL keeps readers off the writer's back; NORMAL is the durability the
  // SQLite docs pair with it (a crash can lose the last commits, not the file).
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  // Freed space is zeroed rather than left holding what was there, so a deleted
  // lead or attachment cannot be read back out of the file — DESIGN.md (Erasure).
  sqlite.pragma('secure_delete = ON')

  const db = drizzle(sqlite, { schema })
  // SQLite cannot alter most of a table in place, so drizzle-kit migrates by
  // rebuilding it — and a DROP with foreign keys on cascades rows out of every
  // referencing table. `PRAGMA foreign_keys` is a no-op inside a transaction
  // and the migrator runs in one, so the only place to hold it off is here.
  sqlite.pragma('foreign_keys = OFF')
  const before = appliedMigrations(sqlite)
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  // Cascades and restrictions in the schema are inert without this.
  sqlite.pragma('foreign_keys = ON')
  assertReferentialIntegrity(sqlite)

  // Once, on the boot that upgrades a database written before `secure_delete`:
  // what it freed back then was never zeroed, and VACUUM rebuilds the file
  // without it. It cannot run inside the migrator's transaction, hence here.
  if (before > 0 && before < ERASURE_MIGRATION_COUNT) {
    console.log('scrubbing free space left by earlier versions (one-time VACUUM)…')
    sqlite.exec('VACUUM')
  }
  // Picks up a checkpoint that a deletion could not finish before the last shutdown.
  truncateWal(db)

  seed(db)
  return db
}

/**
 * Migrating with foreign keys off means nothing checked the result. A migration
 * that left dangling references would otherwise produce a database claiming an
 * integrity it does not have, and every write after that compounds it — so make
 * it a failed boot instead.
 */
function assertReferentialIntegrity(sqlite: Database.Database): void {
  const violations = sqlite.pragma('foreign_key_check') as unknown[]
  if (violations.length === 0) return
  throw new Error(
    `Database has ${violations.length} foreign key violation(s) after migrating: ${JSON.stringify(violations.slice(0, 5))}`,
  )
}
