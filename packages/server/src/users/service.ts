import { and, asc, eq, ne } from 'drizzle-orm'
import { ACCOUNT_COLUMNS, activeAdmins, hasAccess, type AccessPolicy, type AccountRow } from '../auth/access.ts'
import { hashPassword } from '../auth/password.ts'
import type { Role } from '../auth/session.ts'
import type { Db } from '../db/index.ts'
import {
  accessTokens,
  apiKeys,
  authorizationCodes,
  pushSubscriptions,
  refreshTokens,
  sessions,
  users,
} from '../db/schema.ts'
import { err, ok, type Result } from '../result.ts'
import { invitedAccountIds, issueLink, voidLinks, type IssuedLink } from './links.ts'
import { randomUUID } from 'node:crypto'

export type PersonStatus = 'active' | 'invited' | 'disabled' | 'no_access'

/** A person as `GET /api/v1/users` lists them — ADR-0012. */
export interface Person {
  id: number
  name: string | null
  email: string
  role: Role | null
  status: PersonStatus
}

/**
 * How this instance manages people. `builtIn`: the built-in IdP, which issues
 * invites and reset links. `policy.rolesFromIdp`: roles come from the external
 * IdP's scopes, so Philo never changes one.
 */
export interface PeopleMode {
  policy: AccessPolicy
  builtIn: boolean
}

function statusOf(row: AccountRow, mode: PeopleMode, invited: Set<number>, now: Date): PersonStatus {
  if (row.disabledAt !== null) return 'disabled'
  if (mode.builtIn && invited.has(row.id)) return 'invited'
  return hasAccess(row, mode.policy, now) ? 'active' : 'no_access'
}

function toPerson(row: AccountRow, mode: PeopleMode, invited: Set<number>, now: Date): Person {
  return { id: row.id, name: row.name, email: row.email, role: row.role, status: statusOf(row, mode, invited, now) }
}

export function listPeople(db: Db, mode: PeopleMode, now = new Date()): Person[] {
  const invited = invitedAccountIds(db)
  return db
    .select(ACCOUNT_COLUMNS)
    .from(users)
    .orderBy(asc(users.id))
    .all()
    .map((row) => toPerson(row, mode, invited, now))
}

export function getPerson(db: Pick<Db, 'select'>, mode: PeopleMode, id: number, now = new Date()): Person | undefined {
  const [row] = db.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, id)).all()
  return row === undefined ? undefined : toPerson(row, mode, invitedAccountIds(db), now)
}

/** No password anyone knows: an invited account can sign in only once its link set one. */
const unusablePassword = () => hashPassword(`invited:${randomUUID()}`)

export async function invitePerson(
  db: Db,
  mode: PeopleMode,
  input: { email: string; role: Role; name: string | null },
  createdBy: number,
): Promise<Result<{ person: Person; link: IssuedLink }, 'email_taken'>> {
  const passwordHash = await unusablePassword()
  const created = db.transaction((tx) => {
    if (tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).all().length > 0) return undefined
    const [row] = tx
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash, role: input.role, roleConfirmedAt: new Date() })
      .returning({ id: users.id })
      .all()
    return { id: row!.id, link: issueLink(tx, row!.id, 'invite', createdBy) }
  })
  if (created === undefined) return err('email_taken')
  return ok({ person: getPerson(db, mode, created.id)!, link: created.link })
}

export async function reinvitePerson(
  db: Db,
  mode: PeopleMode,
  id: number,
  createdBy: number,
): Promise<Result<{ person: Person; link: IssuedLink }, 'not_found' | 'not_invited' | 'account_disabled'>> {
  const person = getPerson(db, mode, id)
  if (person === undefined) return err('not_found')
  if (person.status === 'disabled') return err('account_disabled')
  if (person.status !== 'invited') return err('not_invited')
  return ok({ person, link: issueLink(db, id, 'invite', createdBy) })
}

/** For the API, refusing yourself; for the server's command, `actorId` is null. */
export function issueResetLink(
  db: Db,
  mode: PeopleMode,
  id: number,
  actorId: number | null,
): Result<IssuedLink, 'not_found' | 'cannot_change_self' | 'account_disabled'> {
  const person = getPerson(db, mode, id)
  if (person === undefined) return err('not_found')
  if (actorId === id) return err('cannot_change_self')
  if (person.status === 'disabled') return err('account_disabled')
  return ok(issueLink(db, id, 'reset', actorId))
}

export type PersonPatch = { role?: Role; disabled?: boolean }
export type PersonPatchError = 'not_found' | 'cannot_change_self' | 'last_admin' | 'role_managed_by_idp'

/**
 * Changes a role or deactivates — ADR-0012. One transaction, so two admins
 * demoting each other at once cannot both pass the last-admin check.
 */
export function updatePerson(
  db: Db,
  mode: PeopleMode,
  actorId: number,
  id: number,
  patch: PersonPatch,
  now = new Date(),
): Result<Person, PersonPatchError> {
  return db.transaction((tx) => {
    const [row] = tx.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, id)).all()
    if (row === undefined) return err('not_found')
    if (id === actorId) return err('cannot_change_self')
    const roleChanges = patch.role !== undefined && patch.role !== row.role
    if (patch.role !== undefined && mode.policy.rolesFromIdp) return err('role_managed_by_idp')

    const deactivating = patch.disabled === true && row.disabledAt === null
    const losesAdmin = (deactivating || (roleChanges && patch.role !== 'admin')) && row.role === 'admin'
    if (losesAdmin && hasAccess(row, mode.policy, now)) {
      const others = activeAdmins(tx as unknown as Db, mode.policy, now).filter((admin) => admin.id !== id)
      if (others.length === 0) return err('last_admin')
    }

    if (roleChanges) tx.update(users).set({ role: patch.role }).where(eq(users.id, id)).run()
    if (deactivating) deactivate(tx, id, now)
    if (patch.disabled === false && row.disabledAt !== null) {
      // Restores sign-in, never the credentials deactivation revoked.
      tx.update(users).set({ disabledAt: null }).where(eq(users.id, id)).run()
    }
    return ok(getPerson(tx, mode, id, now)!)
  })
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Deactivation — ADR-0012: the account stays, so the timeline keeps naming
 * it, and every credential it holds goes with the same write.
 */
function deactivate(tx: Tx, id: number, now: Date): void {
  tx.update(users).set({ disabledAt: now }).where(eq(users.id, id)).run()
  tx.delete(apiKeys).where(eq(apiKeys.userId, id)).run()
  revokeGrants(tx, id)
  tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, id)).run()
  voidLinks(tx, id, now)
}

/** Every OAuth grant the account holds: access and refresh tokens and unredeemed codes. */
export function revokeGrants(tx: Pick<Db, 'delete'>, id: number): void {
  tx.delete(accessTokens).where(eq(accessTokens.userId, id)).run()
  tx.delete(refreshTokens).where(eq(refreshTokens.userId, id)).run()
  tx.delete(authorizationCodes).where(eq(authorizationCodes.userId, id)).run()
  tx.delete(sessions).where(eq(sessions.userId, id)).run()
}

/**
 * A password change, in one transaction: the new hash, every pending link
 * voided (an unused reset link is a way in the person means to close), and
 * every grant revoked but the one in hand — the access token making the
 * request and the refresh token issued with it. `issueTokens` writes a pair
 * with one timestamp, which is what ties them together; another pair issued
 * to the same client in the same millisecond would survive too.
 */
export function changePassword(db: Db, id: number, passwordHash: string, currentTokenHash: string | undefined): void {
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, id)).run()
    voidLinks(tx, id)
    const current =
      currentTokenHash === undefined
        ? undefined
        : tx.select().from(accessTokens).where(eq(accessTokens.tokenHash, currentTokenHash)).all()[0]
    if (current === undefined || current.userId !== id) {
      revokeGrants(tx, id)
      return
    }
    tx.delete(accessTokens).where(and(eq(accessTokens.userId, id), ne(accessTokens.tokenHash, current.tokenHash))).run()
    for (const row of tx.select().from(refreshTokens).where(eq(refreshTokens.userId, id)).all()) {
      const pair = row.clientId === current.clientId && row.createdAt.getTime() === current.createdAt.getTime()
      if (!pair) tx.delete(refreshTokens).where(eq(refreshTokens.tokenHash, row.tokenHash)).run()
    }
    tx.delete(authorizationCodes).where(eq(authorizationCodes.userId, id)).run()
    tx.delete(sessions).where(eq(sessions.userId, id)).run()
  })
}
