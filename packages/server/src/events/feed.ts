/*
 * What changed, for anyone listening — ADR-0010. Routes publish one event after
 * each committed change; the live stream and the webhook dispatcher consume
 * them. In memory, like the notification feed: one instance per business is one
 * process, and nothing here is the record of anything — the database is.
 */

import { randomUUID } from 'node:crypto'
import type { Principal } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { findLead, type LeadRecord } from '../leads/service.ts'

export const CHANGE_TYPES = [
  'lead.created',
  'lead.updated',
  'lead.stage_changed',
  'lead.deleted',
  'funnel.changed',
] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]

/**
 * Who made the change, in the timeline's words: the credential behind the
 * request (`user:<id>`, `api_key:<id>`, `oauth:<client_id>`), or the form a
 * submission came through (`form:<form_key>`).
 */
export type ChangeActor = Principal['actor'] | `form:${string}`

export interface StageRef {
  id: number
  name: string
  funnelId: number
}

export interface ChangeEvent {
  /** Unique per event, so a receiver can drop a retried delivery it already handled. */
  id: string
  type: ChangeType
  occurredAt: string
  /**
   * Who made it — so a receiver that writes back can recognise its own
   * changes, and an integration can tell a person from an agent.
   */
  actor: ChangeActor
  /** The funnel the change happened in — for a moved lead, the one it is in now. */
  funnelId: number
  data: {
    /** Every lead event but `lead.deleted`, which carries only `leadId`. */
    lead?: LeadRecord
    leadId?: number
    /** `lead.stage_changed` only: where it was. May be in another funnel. */
    from?: StageRef
  }
}

/** True when the event is about `funnelId` — including a lead leaving it. */
export function touchesFunnel(event: ChangeEvent, funnelId: number): boolean {
  return event.funnelId === funnelId || event.data.from?.funnelId === funnelId
}

type Listener = (event: ChangeEvent) => void

export class ChangeFeed {
  readonly #listeners = new Set<Listener>()

  /** Returns the unsubscribe. */
  listen(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(type: ChangeType, funnelId: number, actor: ChangeActor, data: ChangeEvent['data'] = {}): void {
    const event: ChangeEvent = { id: randomUUID(), type, occurredAt: new Date().toISOString(), actor, funnelId, data }
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (error: unknown) {
        console.error('change feed listener failed', error)
      }
    }
  }

  /**
   * A lead event, with the lead as it now stands. Quarantined leads are not
   * announced — ADR-0010 — and neither is one that vanished in between.
   */
  publishLead(
    db: Db,
    type: Exclude<ChangeType, 'lead.deleted' | 'funnel.changed'>,
    leadId: number,
    actor: ChangeActor,
    from?: StageRef,
  ) {
    const lead = findLead(db, leadId)
    if (lead === undefined || lead.isSpam) return
    this.publish(type, lead.funnelId, actor, from === undefined ? { lead } : { lead, from })
  }

  get listenerCount(): number {
    return this.#listeners.size
  }
}
