import { serve } from '@hono/node-server'
import { createMcpApp } from '@philo/mcp'
import { bootServer, loadConfig, VERSION } from '@philo/server'
import { createStandaloneApp } from './app.ts'

const config = loadConfig()
const server = bootServer(config)

// In-process: the MCP app's SDK calls go through the server's own request
// handling, auth included, without a socket in between.
const mcp = createMcpApp({
  apiBaseUrl: config.publicBaseUrl,
  publicUrl: config.mcpUrl,
  fetch: (input, init) => server.app.request(input, init),
})

const app = createStandaloneApp({ server: server.app, mcp })

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`philo ${VERSION} (standalone: API, MCP and app) listening on port ${config.port}`)
  server.onListening()
  // The only place the agent surface is surfaced. A connector client pointed
  // here finds the authorization server from the 401 and registers itself;
  // Claude Code and scripts use an API key from Settings instead.
  console.log(`  mcp endpoint:    ${config.mcpUrl} (an API key from Settings, or OAuth for a connector)`)
})
