import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { VERSION } from './version.ts'

const config = loadConfig()

// Fail fast at boot rather than on the first write if the data dir is unusable.
mkdirSync(config.dataDir, { recursive: true })

serve({ fetch: createApp().fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} listening on port ${config.port}`)
  console.log(`  public base url: ${config.publicBaseUrl}`)
  console.log(`  data dir:        ${config.dataDir}`)
})
