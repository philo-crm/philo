import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { pushSubscriptions } from '../db/schema.ts'
import { err, ok, type Result } from '../result.ts'

/**
 * A `PushSubscription` as the browser serializes it, flattened. The two keys
 * come out of `subscription.getKey()` base64url-encoded by the client.
 */
export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
}

export interface StoredSubscription extends PushSubscriptionInput {
  id: number
}

/**
 * Push endpoints are long — FCM's carry a registration id — but they are URLs,
 * not payloads. Well past anything a real push service issues, and short enough
 * that the column cannot be used as storage.
 */
const MAX_ENDPOINT_LENGTH = 2_000

/** A P-256 point and a 16-byte secret, base64url. Both are far under this. */
const MAX_KEY_LENGTH = 200

export type SubscriptionError = 'invalid_subscription'

/** Base64url, as the Push API encodes both keys. No padding, no plain-base64 characters. */
const BASE64URL = /^[A-Za-z0-9_-]+$/

function readKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) return undefined
  return BASE64URL.test(value) ? value : undefined
}

/**
 * The endpoint the push service handed the browser. Required to be https: it is
 * a capability URL that this server will make outbound requests to, so a stored
 * `http://` or `file://` endpoint would be an authenticated user pointing the
 * process at a plaintext or local target. Every real push service issues https.
 */
function readEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  return url.protocol === 'https:' ? value : undefined
}

/**
 * Accepts either shape the client might send: the nested `keys` object of a
 * serialized `PushSubscription`, or the flat one this module stores. Nothing is
 * coerced — a field that is not what it should be refuses the whole thing,
 * because a subscription stored with a truncated key fails only at send time,
 * on the channel nothing reports.
 */
export function validateSubscription(
  body: Record<string, unknown>,
): Result<PushSubscriptionInput, SubscriptionError> {
  const endpoint = readEndpoint(body['endpoint'])
  if (endpoint === undefined) return err('invalid_subscription')

  const rawKeys = body['keys']
  const keys = typeof rawKeys === 'object' && rawKeys !== null ? (rawKeys as Record<string, unknown>) : body
  const p256dh = readKey(keys['p256dh'])
  const auth = readKey(keys['auth'])
  if (p256dh === undefined || auth === undefined) return err('invalid_subscription')

  return ok({ endpoint, p256dh, auth })
}

/**
 * Stores the subscription, replacing whatever was on that endpoint. Upsert
 * rather than insert because re-subscribing is the ordinary case — a browser
 * hands back the same endpoint when permission is re-granted, and the keys
 * rotate with it. Re-pointing `userId` is deliberate: the endpoint belongs to
 * the browser that presented it, and that is the account now using it.
 */
export function saveSubscription(db: Db, userId: number, input: PushSubscriptionInput): void {
  db.insert(pushSubscriptions)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: input.p256dh, auth: input.auth },
    })
    .run()
}

/**
 * Forgets an endpoint. Deliberately not scoped to the calling user: the
 * endpoint is an unguessable capability URL issued to one browser, so
 * presenting it is the claim, and a subscription whose row moved to another
 * account must still be removable by the browser it actually belongs to.
 */
export function deleteSubscription(db: Db, endpoint: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
}

/** Every browser to notify. Single-tenant: everyone who subscribed wants the lead. */
export function listSubscriptions(db: Db): StoredSubscription[] {
  return db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .all()
}

/** Used when a regenerated VAPID pair leaves every stored row undeliverable. */
export function deleteAllSubscriptions(db: Db): number {
  return db.delete(pushSubscriptions).run().changes
}
