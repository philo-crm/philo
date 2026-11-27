import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { accountLinks } from '../db/schema.ts'

/**
 * One-time links into the built-in IdP — ADR-0012. An invite lasts a week,
 * long enough to reach someone by whatever channel the admin uses; a reset a
 * day, because whoever holds it can take over the account.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 24 * 60 * 60 * 1000

export type LinkPurpose = 'invite' | 'reset'

/** Where a link opens: an IdP dialog, so it lives beside `/oauth/authorize`. */
export const LINK_PATH = '/oauth/link'

const LINK_PREFIX = 'philo_link_'
const TOKEN_BYTES = 32

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The URL a person opens, on the IdP's origin. */
export function linkUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}${LINK_PATH}/${token}`
}

export interface IssuedLink {
  token: string
  expiresAt: Date
}

type Tx = Pick<Db, 'select' | 'insert' | 'update'>

/**
 * Issues a link, voiding the account's earlier unused ones of the same
 * purpose, so only the newest link an admin handed out works. Run inside the
 * caller's transaction when it decides anything else.
 */
export function issueLink(
  db: Tx,
  userId: number,
  purpose: LinkPurpose,
  createdBy: number | null,
  now = new Date(),
): IssuedLink {
  voidLinks(db, userId, now, purpose)
  const token = `${LINK_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
  const expiresAt = new Date(now.getTime() + (purpose === 'invite' ? INVITE_TTL_MS : RESET_TTL_MS))
  db.insert(accountLinks)
    .values({ userId, purpose, tokenHash: hashLinkToken(token), expiresAt, createdBy, createdAt: now })
    .run()
  return { token, expiresAt }
}

/**
 * Voids the account's pending links, by expiring them rather than marking
 * them used: an unused invite still says the person never set a password,
 * which is what `invited` means.
 */
export function voidLinks(db: Tx, userId: number, now = new Date(), purpose?: LinkPurpose): void {
  db.update(accountLinks)
    .set({ expiresAt: now })
    .where(
      and(
        eq(accountLinks.userId, userId),
        isNull(accountLinks.usedAt),
        gt(accountLinks.expiresAt, now),
        purpose === undefined ? undefined : eq(accountLinks.purpose, purpose),
      ),
    )
    .run()
}

export interface UsableLink {
  id: number
  userId: number
  purpose: LinkPurpose
}

/** The link behind a token, while it is unused and unexpired. */
export function findUsableLink(db: Pick<Db, 'select'>, token: string, now = new Date()): UsableLink | undefined {
  if (!token.startsWith(LINK_PREFIX)) return undefined
  const [row] = db
    .select({ id: accountLinks.id, userId: accountLinks.userId, purpose: accountLinks.purpose })
    .from(accountLinks)
    .where(
      and(eq(accountLinks.tokenHash, hashLinkToken(token)), isNull(accountLinks.usedAt), gt(accountLinks.expiresAt, now)),
    )
    .all()
  return row
}

/**
 * Ids of accounts that were invited and never used a link of any purpose: no
 * password of their own yet. A reset link sets a password too, so using one
 * ends an invitation just as using the invite does.
 */
export function invitedAccountIds(db: Pick<Db, 'select'>): Set<number> {
  const invited = new Set<number>()
  const used = new Set<number>()
  for (const row of db
    .select({ userId: accountLinks.userId, purpose: accountLinks.purpose, usedAt: accountLinks.usedAt })
    .from(accountLinks)
    .all()) {
    if (row.purpose === 'invite') invited.add(row.userId)
    if (row.usedAt !== null) used.add(row.userId)
  }
  for (const id of used) invited.delete(id)
  return invited
}
