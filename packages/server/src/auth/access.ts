import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import type { ExternalIdpConfig } from '../config.ts'
import type { Role, SessionUser } from './session.ts'

/**
 * How long an externally-managed role stays good without a PWA token
 * confirming it — ADR-0012. API keys, push and email never see the IdP, so this
 * is how a person removed there stops reaching Philo through them.
 */
export const EXTERNAL_ROLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How often an admitted token rewrites `role_confirmed_at` when nothing else
 * about the account changed. A confirmation is only compared against a 30-day
 * window, so refreshing it on every request would buy nothing but writes.
 */
export const ROLE_CONFIRMATION_INTERVAL_MS = 60 * 60 * 1000

/**
 * Where roles are decided. `rolesFromIdp` means the accounts are externally
 * managed: an external IdP with both the user and the admin scope configured,
 * so the stored role is only a cache of what tokens said, and it expires. In
 * every other mode — the built-in IdP, or an external one without the scopes —
 * the role lives on the account and the 30-day rule does not apply.
 */
export interface AccessPolicy {
  rolesFromIdp: boolean
}

export const ROLES_ON_ACCOUNTS: AccessPolicy = { rolesFromIdp: false }

/** The policy an identity setup implies: externally managed exactly when both role scopes are set. */
export function accessPolicyOf(externalIdp: Pick<ExternalIdpConfig, 'roles'> | undefined): AccessPolicy {
  return { rolesFromIdp: externalIdp?.roles !== undefined }
}

/** The account columns access is decided on. Select these wherever an account is resolved. */
export const ACCOUNT_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  roleConfirmedAt: users.roleConfirmedAt,
  disabledAt: users.disabledAt,
}

export interface AccountRow {
  id: number
  email: string
  name: string | null
  role: Role | null
  roleConfirmedAt: Date | null
  disabledAt: Date | null
}

/**
 * **Has access** — ADR-0012, the one rule for every consumer that does not
 * hold a fresh token: API keys, push delivery, the admin fallback for
 * new-lead email, the VAPID contact, the last-admin guard. Active, holding a
 * role, and — when roles come from the IdP — confirmed within the window.
 * Nothing reads `users.role` without it.
 */
export function hasAccess(
  account: Pick<AccountRow, 'role' | 'roleConfirmedAt' | 'disabledAt'>,
  policy: AccessPolicy,
  now: Date = new Date(),
): boolean {
  if (account.disabledAt !== null || account.role === null) return false
  if (!policy.rolesFromIdp) return true
  return (
    account.roleConfirmedAt !== null && now.getTime() - account.roleConfirmedAt.getTime() <= EXTERNAL_ROLE_MAX_AGE_MS
  )
}

/** The person an account row acts as, or undefined when it has no access. */
export function sessionUserOf(
  row: AccountRow | undefined,
  policy: AccessPolicy,
  now: Date = new Date(),
): SessionUser | undefined {
  if (row === undefined || row.role === null || !hasAccess(row, policy, now)) return undefined
  return { id: row.id, email: row.email, name: row.name, role: row.role }
}

/** The person behind an account id — a grant, a key, a code — or undefined when it has no access. */
export function userWithAccess(
  db: Db,
  userId: number,
  policy: AccessPolicy,
  now: Date = new Date(),
): SessionUser | undefined {
  const [row] = db.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, userId)).all()
  return sessionUserOf(row, policy, now)
}

/** Accounts with access as an admin, earliest first: "active admins" in ADR-0012. */
export function activeAdmins(db: Db, policy: AccessPolicy, now: Date = new Date()): AccountRow[] {
  return db
    .select(ACCOUNT_COLUMNS)
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .all()
    .filter((row) => hasAccess(row, policy, now))
}

/** Ids of every account with access — whose devices a push may reach. */
export function accountIdsWithAccess(db: Db, policy: AccessPolicy, now: Date = new Date()): Set<number> {
  return new Set(
    db
      .select(ACCOUNT_COLUMNS)
      .from(users)
      .all()
      .filter((row) => hasAccess(row, policy, now))
      .map((row) => row.id),
  )
}

/**
 * Ids of externally-managed accounts whose last confirmation is older than
 * the window: active, so it is the lapse and not a deactivation that took
 * their access. Empty unless roles come from the IdP.
 */
export function lapsedAccountIds(db: Db, policy: AccessPolicy, now: Date = new Date()): number[] {
  if (!policy.rolesFromIdp) return []
  return db
    .select(ACCOUNT_COLUMNS)
    .from(users)
    .where(isNull(users.disabledAt))
    .all()
    .filter((row) => row.role !== null && !hasAccess(row, policy, now))
    .map((row) => row.id)
}
