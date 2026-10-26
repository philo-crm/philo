import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware.ts'
import { parseFunnelParam } from '../funnels/service.ts'
import { eventStream, type LiveTuning } from '../sse.ts'
import { touchesFunnel, type ChangeFeed } from './feed.ts'

export interface EventRoutesDeps {
  changes: ChangeFeed
  liveTuning?: LiveTuning | undefined
}

/**
 * Every change as Server-Sent Events, named by type — ADR-0010. `?funnel=<id>`
 * narrows it to one funnel, a lead moved out of it included.
 */
export function createEventRoutes(deps: EventRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  routes.get('/', (c) => {
    const funnelId = parseFunnelParam(c.req.query('funnel'))
    if (funnelId === null) return c.json({ error: 'invalid_request' }, 400)
    return eventStream(
      (send) =>
        deps.changes.listen((event) => {
          if (funnelId === undefined || touchesFunnel(event, funnelId)) send(event.type, event)
        }),
      deps.liveTuning,
    )
  })

  return routes
}
