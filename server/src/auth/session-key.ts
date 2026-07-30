import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** Lives in PHILO_DATA_DIR alongside the database, so a backup carries it. */
export const SESSION_KEY_FILENAME = 'session-key'

const KEY_BYTES = 32

function readKey(path: string): string | undefined {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const key = contents.trim()
  return key.length > 0 ? key : undefined
}

/**
 * The HMAC key that signs session cookies. DESIGN.md (Architecture): secrets
 * Philo can generate itself are generated, persisted in the data dir, and never
 * asked of the operator.
 *
 * Losing the file logs everyone out — it does not lock anyone out — because the
 * session rows it authenticates are worthless without it.
 */
export function loadOrCreateSessionKey(dataDir: string): string {
  const path = join(dataDir, SESSION_KEY_FILENAME)
  const existing = readKey(path)
  if (existing !== undefined) return existing

  const key = randomBytes(KEY_BYTES).toString('hex')
  writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  // `mode` above only applies when the write creates the file; an empty or
  // truncated key file left over from a crash gets its permissions fixed here.
  chmodSync(path, 0o600)
  return key
}
