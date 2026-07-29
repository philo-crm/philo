import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/index.ts'
import { VERSION } from './version.ts'

const config = loadConfig()

// Creates the data dir, migrates, and seeds. Done before the server listens so
// an unusable data dir or a failed migration fails the boot, not a later write.
const db = openDatabase(config.dataDir)

serve({ fetch: createApp().fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} listening on port ${config.port}`)
  console.log(`  public base url: ${config.publicBaseUrl}`)
  console.log(`  data dir:        ${config.dataDir}`)
  console.log(`  database:        ${db.$client.name}`)
})
