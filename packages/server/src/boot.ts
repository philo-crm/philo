import { createApp } from './app.ts'
import { createExternalIdp } from './auth/external-idp.ts'
import type { Config } from './config.ts'
import { openDatabase, type Db } from './db/index.ts'
import { createLeadEmailHook, sweepUnsentEmails, type EmailDeps } from './email/service.ts'
import { isEmailConfigured, readEmailSettings } from './email/settings.ts'
import { createSmtpSender, smtpGreetingName } from './email/transport.ts'
import { HONEYPOT_FIELD } from './intake/payload.ts'
import { intakeUrls } from './intake/routes.ts'
import { combineLeadCreatedHooks } from './notify.ts'
import { loadOrCreateSigningKey } from './oauth/signing-key.ts'
import { loadOrCreateVapidKeys } from './push/keys.ts'
import { createLeadPushHook, resetSubscriptionsForNewKeys } from './push/service.ts'

export { loadConfig, type Config } from './config.ts'
export { VERSION } from './version.ts'

export interface BootedServer {
  app: ReturnType<typeof createApp>
  /**
   * Call once the socket is listening: prints what the operator needs to know
   * and starts the work that must not hold up serving.
   */
  onListening(): void
}

/**
 * Everything the headless server needs before it can answer a request — the
 * data dir, the database, the generated secrets, the notification hooks — in
 * one place, so its own entrypoint and apps/standalone boot it identically.
 */
export function bootServer(config: Config): BootedServer {
  // Creates the data dir, migrates, and seeds. Done before the server listens so
  // an unusable data dir or a failed migration fails the boot, not a later write.
  const db = openDatabase(config.dataDir)

  // After openDatabase, which is what creates the data dir.
  const signingKey = loadOrCreateSigningKey(config.dataDir)

  // Links in emails and notifications open the PWA, wherever it is served.
  const createSender = createSmtpSender(smtpGreetingName(config.publicBaseUrl))
  const emailDeps: EmailDeps = { db, appUrl: config.appUrl, createSender }

  // Also after openDatabase, for the data dir.
  const vapid = loadOrCreateVapidKeys(config.dataDir)
  resetSubscriptionsForNewKeys(db, vapid)

  const pushDeps = { db, appUrl: config.appUrl, vapidKeys: vapid.keys }

  const app = createApp({
    db,
    publicBaseUrl: config.publicBaseUrl,
    appUrl: config.appUrl,
    mcpUrl: config.mcpUrl,
    signingKey,
    externalIdp: config.externalIdp === undefined ? undefined : createExternalIdp(config.externalIdp),
    vapidPublicKey: vapid.keys.publicKey,
    trustProxy: config.trustProxy,
    createEmailSender: createSender,
    // Email is the guaranteed notification channel and push is the fast one —
    // ADR-0004. Independent by construction: each is isolated from the other.
    onLeadCreated: combineLeadCreatedHooks(createLeadEmailHook(emailDeps), createLeadPushHook(pushDeps)),
  })

  return { app, onListening: () => onListening(config, db, emailDeps) }
}

function onListening(config: Config, db: Db, emailDeps: EmailDeps): void {
  console.log(`  public base url: ${config.publicBaseUrl}`)
  console.log(`  app url:         ${config.appUrl}`)
  console.log(
    config.externalIdp === undefined
      ? `  identity:        built-in IdP at ${config.publicBaseUrl}/oauth`
      : `  identity:        external IdP ${config.externalIdp.issuer} (operator client ${config.externalIdp.clientId})`,
  )
  console.log(`  data dir:        ${config.dataDir}`)
  console.log(`  database:        ${db.$client.name}`)
  // The only place a form key is surfaced until there is a forms UI. Printed
  // every boot rather than once, so it survives a lost log — and it is an
  // identifier, not a credential: DESIGN.md (Intake endpoint) makes it public by
  // construction, since the form that posts to it lives in a visitor's browser.
  for (const url of intakeUrls(db, config.publicBaseUrl)) {
    console.log(`  intake form:     ${url}`)
  }
  console.log(`  honeypot field:  ${HONEYPOT_FIELD} (render it hidden; a filled one is filed as spam)`)
  // Email is the channel a missed lead is missed through, and an unconfigured
  // instance looks identical to a working one from the outside — every send is
  // best-effort and nothing upstream reports it. So say so at boot.
  const emailSettings = readEmailSettings(db)
  if (isEmailConfigured(emailSettings)) {
    console.log(`  email:           ${emailSettings.smtpHost}:${emailSettings.smtpPort} as ${emailSettings.fromAddress}`)
  } else {
    console.warn('  note: SMTP is not configured, so no lead notifications or acknowledgments are sent. Set it up in Settings.')
  }
  // Push is best-effort by design (ADR-0004), but a browser will not subscribe
  // at all outside a secure context — so on a plain-http base URL the toggle in
  // Settings simply never works, with nothing on screen saying why.
  if (config.publicBaseUrl.startsWith('https://')) {
    console.log('  push:            enabled (turn it on per device in Settings)')
  } else {
    console.warn(
      '  note: browsers only allow push notifications over https, so the Settings toggle will not ' +
        'work until PHILO_PUBLIC_BASE_URL is an https URL. Email is unaffected.',
    )
  }
  // After the socket is up, and deliberately not awaited: retry schedules live
  // in memory, so this is what carries the guarantee across a restart — but a
  // mail server that is down must not hold up serving.
  void sweepUnsentEmails(emailDeps)
  if (config.trustProxy) {
    // Worth stating positively: this is the setting that decides whether a header
    // a stranger can write is allowed to name the caller.
    console.log('  rate limits:     per caller, from X-Forwarded-For (PHILO_TRUSTED_PROXY=true)')
    console.log(
      '                   requires that only the proxy can reach this port — publish it on ' +
        'localhost (-p 127.0.0.1:PORT:PORT) or a private network, not 0.0.0.0',
    )
  } else {
    // Silent by default and easy to leave that way: nothing looks broken, but
    // behind a proxy every rate limit collapses onto that one address, so one
    // flood spends the budget for every real caller.
    console.warn(
      '  note: rate limits key on the socket address. If a reverse proxy sits in front, ' +
        'set PHILO_TRUSTED_PROXY=true so limits apply per caller instead of per deployment.',
    )
  }
}
