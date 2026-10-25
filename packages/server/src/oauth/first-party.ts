import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { oauthClients } from '../db/schema.ts'

/**
 * The PWA's client id at the built-in IdP. Fixed rather than registered: the
 * PWA ships knowing it, and its grants are the person themself on the
 * timeline (`user:<id>`) rather than an agent acting for them — ADR-0007. Not a UUID, so it can never collide with a dynamic registration.
 */
export const FIRST_PARTY_CLIENT_ID = 'philo-web'

/** Where the PWA receives the authorization response. Mirrored in apps/web. */
export const FIRST_PARTY_CALLBACK_PATH = '/auth/callback'

export function firstPartyRedirectUri(appUrl: string): string {
  return `${appUrl}${FIRST_PARTY_CALLBACK_PATH}`
}

/**
 * Writes the first-party client's row, or corrects its redirect URI after
 * `PHILO_APP_URL` changed. A real row rather than a special case in the
 * lookup, because every grant references its client and cascades from it.
 *
 * Public (`none`): the PWA cannot keep a secret, and PKCE is what protects it.
 */
export function ensureFirstPartyClient(db: Db, appUrl: string): void {
  const values = {
    clientSecretHash: null,
    clientName: 'Philo',
    clientUri: appUrl,
    redirectUris: JSON.stringify([firstPartyRedirectUri(appUrl)]),
    tokenEndpointAuthMethod: 'none',
  }
  const [existing] = db
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, FIRST_PARTY_CLIENT_ID))
    .all()
  if (existing === undefined) {
    db.insert(oauthClients).values({ clientId: FIRST_PARTY_CLIENT_ID, ...values }).run()
  } else {
    db.update(oauthClients).set(values).where(eq(oauthClients.clientId, FIRST_PARTY_CLIENT_ID)).run()
  }
}
