import { serve } from '@hono/node-server'
import { bootServer, loadConfig, VERSION } from './boot.ts'

const config = loadConfig()
const { app, onListening } = bootServer(config)

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} (headless API) listening on port ${config.port}`)
  onListening()
})
