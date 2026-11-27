import { eq } from 'drizzle-orm'
import { accessPolicyOf } from '../auth/access.ts'
import { normalizeEmail } from '../auth/credentials.ts'
import { loadConfig } from '../config.ts'
import { openDatabase } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { linkUrl } from '../users/links.ts'
import { issueResetLink } from '../users/service.ts'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = 'usage: philo reset-link <email>'

/**
 * The server's command — ADR-0012. `reset-link <email>` prints a password
 * reset link, for an admin who is the only one and has lost their password.
 * Whoever can run it where the data directory is can already read the
 * database, so it asks for nothing else. Returns the exit code.
 */
export function runCli(args: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  const [command, address, ...rest] = args
  if (command !== 'reset-link' || address === undefined || rest.length > 0) {
    io.err(USAGE)
    return 2
  }
  const config = loadConfig(env)
  if (config.externalIdp !== undefined) {
    io.err('Passwords are managed by the identity provider this instance signs in with; reset it there.')
    return 1
  }
  const email = normalizeEmail(address)
  if (email === undefined) {
    io.err(`Not an email address: ${address}`)
    return 2
  }
  const db = openDatabase(config.dataDir)
  try {
    const [row] = db.select({ id: users.id }).from(users).where(eq(users.email, email)).all()
    if (row === undefined) {
      io.err(`No account has the address ${email}.`)
      return 1
    }
    const mode = { policy: accessPolicyOf(undefined), builtIn: true }
    const result = issueResetLink(db, mode, row.id, null)
    if (!result.ok) {
      io.err(result.error === 'account_disabled' ? `${email} is deactivated; an admin can reactivate it.` : result.error)
      return 1
    }
    io.out(linkUrl(config.publicBaseUrl, result.value.token))
    io.err(`Valid until ${result.value.expiresAt.toISOString()}, once.`)
    return 0
  } finally {
    db.$client.close()
  }
}
