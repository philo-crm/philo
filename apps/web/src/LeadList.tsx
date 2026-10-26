import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiErrorMessage,
  fetchLeads,
  fetchStages,
  promoteLead,
  PAGE_SIZE,
} from './api.ts'
import { formatDateTime, leadContact, leadTitle } from './format.ts'
import { useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { useLiveChanges } from './live.ts'
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
const ALL_FUNNELS = 'all'

export function LeadList({ isSpam, onSessionExpired }: LeadListProps) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  /** Whether to look past the selected funnel, at every funnel's leads at once. */
  const [acrossFunnels, setAcrossFunnels] = useState(false)
  const [stageFilter, setStageFilter] = useState<{ funnelId: number | undefined; stageId: number | undefined }>({
    funnelId: undefined,
    stageId: undefined,
  })
  const [paging, setPaging] = useState<{ funnelId: number | undefined; offset: number }>({ funnelId: undefined, offset: 0 })
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
      setPaging((previous) => ({ ...previous, offset: 0 }))
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const funnels = useFunnels()
  const [selectedFunnel, selectFunnel] = useSelectedFunnel(funnels.data)
  const multiFunnel = (funnels.data?.length ?? 0) > 1
  // The list follows the funnel chosen in the top bar, like the board — unless
  // it was asked to look across all of them. The spam view has no funnels.
  const funnelId = isSpam || !multiFunnel || acrossFunnels ? undefined : selectedFunnel
  // A stage filter or a page belongs to the funnel it was set under; switching
  // funnels, from here or from the top bar, starts both over.
  const stageId = stageFilter.funnelId === funnelId ? stageFilter.stageId : undefined
  const offset = paging.funnelId === funnelId ? paging.offset : 0
  const setStageId = (id: number | undefined) => setStageFilter({ funnelId, stageId: id })
  const setOffset = useCallback((next: number) => setPaging({ funnelId, offset: next }), [funnelId])
  // Until the funnels are known, so the list does not flash every funnel's
  // leads before narrowing to the selected one.
  const ready = isSpam || funnels.data !== undefined || funnels.error !== undefined

  const loadLeads = useCallback(
    (signal: AbortSignal) =>
      ready
        ? fetchLeads({ isSpam, funnelId, stageId, search, limit: PAGE_SIZE, offset }, signal)
        : new Promise<never>(() => undefined),
    [ready, isSpam, funnelId, stageId, search, offset],
  )
  const page = useResource(loadLeads)
  // Stages belong to a funnel (ADR-0009), so the stage filter offers one
  // funnel's: the one chosen, or the only one there is. Across several funnels
  // it is hidden rather than a list of same-named stages nobody can tell apart.
  const showStageFilter = !isSpam && (!multiFunnel || funnelId !== undefined)

  // Not fetched in the spam view, which shows no stage filter — a request whose
  // answer nothing renders is one more thing that can fail for no reason.
  const loadStages = useCallback(
    (signal: AbortSignal) => (showStageFilter ? fetchStages(signal, funnelId) : Promise.resolve([])),
    [showStageFilter, funnelId],
  )
  const stages = useResource(loadStages)
  // Anything that changes a lead can change which page it is on, so the page is
  // refetched; a funnel renamed or restaged changes the labels and the filter.
  useLiveChanges((events) => {
    page.refresh()
    if (events.some((event) => event.type === 'funnel.changed')) {
      funnels.refresh()
      stages.refresh()
    }
  }, funnelId)
  const funnelNames = new Map((funnels.data ?? []).map((funnel) => [funnel.id, funnel.name]))

  // One error for the screen. A failed funnel load counts: it leaves the stage
  // filter with nothing in it, and a filter that silently cannot filter is
  // worse than one that says why.
  const error = firstFailure(page.error, funnels.error, stages.error, actionError)
  useSessionGuard(error, onSessionExpired)

  // Promoting the last lead on a page leaves the caller looking at nothing;
  // step back rather than make them find the pagination control themselves.
  const pageData = page.data
  useEffect(() => {
    if (pageData !== undefined && pageData.leads.length === 0 && pageData.offset > 0) {
      setOffset(Math.max(0, pageData.offset - PAGE_SIZE))
    }
  }, [pageData, setOffset])

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
        <div className="screen-title">
          <h1>{isSpam ? 'Spam' : 'Leads'}</h1>
          <p className="count" aria-live="polite">
            {page.loading && page.data === undefined
              ? 'Loading…'
              : `${total} ${total === 1 ? 'lead' : 'leads'}`}
          </p>
        </div>
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

        {!isSpam && multiFunnel && (
          <label className="field">
            <span className="field-label">Funnel</span>
            <select
              value={funnelId === undefined ? ALL_FUNNELS : String(funnelId)}
              onChange={(event) => {
                const value = event.target.value
                setAcrossFunnels(value === ALL_FUNNELS)
                if (value !== ALL_FUNNELS) selectFunnel(Number(value))
              }}
            >
              <option value={ALL_FUNNELS}>All funnels</option>
              {(funnels.data ?? []).map((funnel) => (
                <option key={funnel.id} value={String(funnel.id)}>
                  {funnel.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {showStageFilter && (
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
            : search !== '' || stageId !== undefined || funnelId !== undefined
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
                      <span className="tag">
                        {multiFunnel && funnelId === undefined
                          ? `${funnelNames.get(lead.funnelId) ?? 'Funnel'} · ${lead.stageName}`
                          : lead.stageName}
                      </span>
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
