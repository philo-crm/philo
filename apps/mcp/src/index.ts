import { serve } from '@hono/node-server'
import { createMcpApp, MCP_PATH } from './app.ts'
import { VERSION } from './version.ts'

/**
 * The MCP app on its own, for a deployment that runs it apart from the server.
 * apps/standalone hosts it in-process instead, which is the default install.
 */
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`${name} is required`)
    process.exit(1)
  }
  return value.replace(/\/+$/, '')
}

const port = Number(process.env['PHILO_MCP_PORT'] ?? '3001')
const apiBaseUrl = required('PHILO_API_URL')
const publicUrl = process.env['PHILO_MCP_URL']?.replace(/\/+$/, '') || `http://localhost:${port}${MCP_PATH}`

const app = createMcpApp({ apiBaseUrl, publicUrl })

serve({ fetch: app.fetch, port }, () => {
  console.log(`philo-mcp ${VERSION} listening on port ${port}`)
  console.log(`  endpoint: ${publicUrl}`)
  console.log(`  api:      ${apiBaseUrl}`)
})
