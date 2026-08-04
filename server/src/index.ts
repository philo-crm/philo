import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadOrCreateSessionKey } from './auth/session-key.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/index.ts'
import { createLeadEmailHook, sweepUnsentEmails } from './email/service.ts'
import { isEmailConfigured, readEmailSettings } from './email/settings.ts'
import { HONEYPOT_FIELD } from './intake/payload.ts'
import { intakeUrls } from './intake/routes.ts'
import { VERSION } from './version.ts'

const config = loadConfig()

// Creates the data dir, migrates, and seeds. Done before the server listens so
// an unusable data dir or a failed migration fails the boot, not a later write.
const db = openDatabase(config.dataDir)

// After openDatabase, which is what creates the data dir.
const sessionKey = loadOrCreateSessionKey(config.dataDir)

// A Secure cookie is never returned over plain http, so following the deployment's
// own base URL is what keeps localhost dev working without a special case.
const cookieSecure = config.publicBaseUrl.startsWith('https://')

const emailDeps = { db, publicBaseUrl: config.publicBaseUrl }

const app = createApp({
  db,
  sessionKey,
  cookieSecure,
  publicBaseUrl: config.publicBaseUrl,
  trustProxy: config.trustProxy,
  // Email is the guaranteed notification channel — ADR-0004. Push (#13) hangs
  // off the same hook when it lands.
  onLeadCreated: createLeadEmailHook(emailDeps),
})

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} listening on port ${config.port}`)
  console.log(`  public base url: ${config.publicBaseUrl}`)
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
  if (!cookieSecure) {
    // Easy to reach by accident: terminate TLS at a proxy but leave
    // PHILO_PUBLIC_BASE_URL unset, and the session cookie loses `Secure`
    // without anything else looking wrong.
    console.warn(
      '  warning: session cookies are not marked Secure because PHILO_PUBLIC_BASE_URL is not https. ' +
        'Set it to the https URL you serve on before exposing this instance.',
    )
  }
})
