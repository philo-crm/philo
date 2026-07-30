import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadOrCreateSessionKey } from './auth/session-key.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/index.ts'
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

const app = createApp({ db, sessionKey, cookieSecure })

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} listening on port ${config.port}`)
  console.log(`  public base url: ${config.publicBaseUrl}`)
  console.log(`  data dir:        ${config.dataDir}`)
  console.log(`  database:        ${db.$client.name}`)
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
