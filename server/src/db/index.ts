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
  sqlite.pragma('busy_timeout = 5000')

  const db = drizzle(sqlite, { schema })
  // SQLite cannot alter most of a table in place, so drizzle-kit migrates by
  // rebuilding it — and a DROP with foreign keys on cascades rows out of every
  // referencing table. `PRAGMA foreign_keys` is a no-op inside a transaction
  // and the migrator runs in one, so the only place to hold it off is here.
  sqlite.pragma('foreign_keys = OFF')
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  // Cascades and restrictions in the schema are inert without this.
  sqlite.pragma('foreign_keys = ON')

  seed(db)
  return db
}
