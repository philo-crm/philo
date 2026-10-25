import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiErrorMessage,
  fetchLeads,
  fetchStages,
  promoteLead,
  PAGE_SIZE,
} from './api.ts'
import { formatDateTime, leadContact, leadTitle } from './format.ts'
import { firstFailure } from './http.ts'
import { Link } from './router.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface LeadListProps {
  /** The spam view is the same list over the quarantine — see DESIGN.md (Intake endpoint). */
  isSpam: boolean
  onSessionExpired: () => void
}

/** Long enough that typing a name is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250

const ALL_STAGES = 'all'

export function LeadList({ isSpam, onSessionExpired }: LeadListProps) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [stageId, setStageId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const [actionError, setActionError] = useState<unknown>(undefined)
  const [promotingId, setPromotingId] = useState<number | undefined>(undefined)

  /**
   * The search that is actually applied. Compared against before scheduling
   * anything, so the effect is inert on mount and on a StrictMode re-run —
   * without that, a timer fires 250ms after the list appears and resets the
   * page, throwing anyone who paged quickly back to the first one.
   */
  const applied = useRef(search)
  useEffect(() => {
    const next = searchInput.trim()
    if (next === applied.current) return
    const timer = window.setTimeout(() => {
      applied.current = next
      setSearch(next)
      // A narrowed result set has no page three; staying on it would show an
      // empty table for a search that matched plenty.
      setOffset(0)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const loadLeads = useCallback(
    (signal: AbortSignal) =>
      fetchLeads({ isSpam, stageId, search, limit: PAGE_SIZE, offset }, signal),
    [isSpam, stageId, search, offset],
  )
  const page = useResource(loadLeads)

  // Not fetched in the spam view, which shows no stage filter — a request whose
  // answer nothing renders is one more thing that can fail for no reason.
  const loadStages = useCallback(
    (signal: AbortSignal) => (isSpam ? Promise.resolve([]) : fetchStages(signal)),
    [isSpam],
  )
  const stages = useResource(loadStages)

  // One error for the screen. A failed funnel load counts: it leaves the stage
  // filter with nothing in it, and a filter that silently cannot filter is
  // worse than one that says why.
  const error = firstFailure(page.error, stages.error, actionError)
  useSessionGuard(error, onSessionExpired)

  // Promoting the last lead on a page leaves the caller looking at nothing;
  // step back rather than make them find the pagination control themselves.
  const pageData = page.data
  useEffect(() => {
    if (pageData !== undefined && pageData.leads.length === 0 && pageData.offset > 0) {
      setOffset(Math.max(0, pageData.offset - PAGE_SIZE))
    }
  }, [pageData])

  async function handlePromote(id: number) {
    setPromotingId(id)
    setActionError(undefined)
    try {
      await promoteLead(id)
      // The lead leaves this list on success, so the page has to be refetched
      // rather than patched in place.
      page.reload()
    } catch (caught) {
      setActionError(caught)
    } finally {
      setPromotingId(undefined)
    }
  }

  const leads = page.data?.leads ?? []
  const total = page.data?.total ?? 0
  // The offset that produced the rows on screen, not the one being requested —
  // during an in-flight page change those differ, and the label describes what
  // the reader can actually see.
  const shown = page.data?.offset ?? offset
  const first = leads.length === 0 ? 0 : shown + 1
  const last = shown + leads.length

  return (
    <section className="screen">
      <header className="screen-head">
        <h1>{isSpam ? 'Spam' : 'Leads'}</h1>
        <p className="count" aria-live="polite">
          {page.loading && page.data === undefined
            ? 'Loading…'
            : `${total} ${total === 1 ? 'lead' : 'leads'}`}
        </p>
      </header>

      <div className="toolbar">
        <label className="field">
          <span className="field-label">Search</span>
          <input
            type="search"
            value={searchInput}
            placeholder="Name, email, phone, answers"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>

        {!isSpam && (
          <label className="field">
            <span className="field-label">Stage</span>
            <select
              value={stageId === undefined ? ALL_STAGES : String(stageId)}
              onChange={(event) => {
                const value = event.target.value
                setStageId(value === ALL_STAGES ? undefined : Number(value))
                setOffset(0)
              }}
            >
              <option value={ALL_STAGES}>All stages</option>
              {(stages.data ?? []).map((stage) => (
                <option key={stage.id} value={String(stage.id)}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {apiErrorMessage(error)}
        </p>
      )}

      {leads.length === 0 && !page.loading ? (
        <p className="empty">
          {isSpam
            ? 'Nothing is quarantined.'
            : search !== '' || stageId !== undefined
              ? 'No leads match those filters.'
              : 'No leads yet. They appear here as the intake form is submitted.'}
        </p>
      ) : (
        // Wrapped so a narrow screen scrolls the grid rather than the page.
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Lead</th>
                <th scope="col">Contact</th>
                {!isSpam && <th scope="col">Stage</th>}
                <th scope="col">Source</th>
                <th scope="col">Received</th>
                {isSpam && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <Link to={`/leads/${lead.id}`}>{leadTitle(lead)}</Link>
                  </td>
                  <td className="muted">{leadContact(lead)}</td>
                  {!isSpam && (
                    <td>
                      <span className="tag">{lead.stageName}</span>
                    </td>
                  )}
                  <td className="muted">{lead.source ?? '—'}</td>
                  <td className="muted numeric">{formatDateTime(lead.createdAt)}</td>
                  {isSpam && (
                    <td>
                      <button
                        type="button"
                        disabled={promotingId === lead.id}
                        onClick={() => void handlePromote(lead.id)}
                      >
                        {promotingId === lead.id ? 'Promoting…' : 'Not spam'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <nav className="pager" aria-label="Pagination">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>
          <span className="muted numeric">
            {first}–{last} of {total}
          </span>
          <button type="button" disabled={last >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </button>
        </nav>
      )}
    </section>
  )
}
