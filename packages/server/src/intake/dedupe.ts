/** Above this many tracked hashes, recording one also sweeps the expired ones. */
const PRUNE_THRESHOLD = 4096

/**
 * Remembers recently accepted submissions so a double-submit — a second click, a
 * retried POST, a browser replaying a form on back-navigation — answers the same
 * way the first did and creates nothing.
 *
 * In-process, like every other limit here: DESIGN.md makes single-instance a
 * permanent property, and a table would trade a restart's worth of forgiveness
 * for a write on the hot path. A restart inside the window is the one case where
 * a duplicate gets through, and a duplicate lead is a visible, fixable annoyance
 * rather than a correctness problem.
 */
export class DedupeWindow {
  readonly #windowMs: number
  /** hash → [expiresAt, the lead it created]. */
  readonly #seen = new Map<string, [number, number]>()

  constructor(windowMs: number) {
    this.#windowMs = windowMs
  }

  /** The lead an identical submission created inside the window, if any. */
  leadFor(hash: string, now = Date.now()): number | undefined {
    const entry = this.#seen.get(hash)
    if (entry === undefined) return undefined
    if (entry[0] > now) return entry[1]
    this.#seen.delete(hash)
    return undefined
  }

  record(hash: string, leadId: number, now = Date.now()): void {
    this.#pruneIfCrowded(now)
    this.#seen.set(hash, [now + this.#windowMs, leadId])
  }

  #pruneIfCrowded(now: number): void {
    if (this.#seen.size < PRUNE_THRESHOLD) return
    for (const [hash, [expiresAt]] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(hash)
    }
    // Map iteration is insertion-ordered, so this drops the oldest entries.
    // Forgetting a hash only ever admits a duplicate; it never rejects a lead.
    for (const hash of this.#seen.keys()) {
      if (this.#seen.size <= PRUNE_THRESHOLD) break
      this.#seen.delete(hash)
    }
  }
}
