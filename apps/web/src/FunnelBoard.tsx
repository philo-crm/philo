import { useCallback, useRef, useState, type FormEvent } from 'react'
import {
  createStage,
  deleteStage,
  fetchBoard,
  moveLeadStage,
  type BoardColumn,
  reorderStages,
  stageErrorMessage,
  updateStage,
  MAX_STAGE_NAME_LENGTH,
} from './api.ts'
import { FunnelPicker, useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { IntakeDetails } from './IntakeDetails.tsx'
import { firstFailure } from './http.ts'
import { useLiveChanges } from './live.ts'
import { Link } from './router.tsx'
import { StageColumn } from './StageColumn.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface FunnelBoardProps {
  onSessionExpired: () => void
}

export function FunnelBoard({ onSessionExpired }: FunnelBoardProps) {
  const funnels = useFunnels()
  const [funnelId, selectFunnel] = useSelectedFunnel(funnels.data)
  // Waits for the funnel list, so the board never flashes the default funnel's
  // columns before switching to the one this browser last looked at.
  const loadBoard = useCallback(
    (signal: AbortSignal) => (funnelId === undefined ? Promise.resolve([]) : fetchBoard(signal, funnelId)),
    [funnelId],
  )
  const board = useResource(loadBoard)

  const [actionError, setActionError] = useState<unknown>(undefined)
  const [pending, setPending] = useState(false)
  const [draggingId, setDraggingId] = useState<number | undefined>(undefined)
  const [touchOverId, setTouchOverId] = useState<number | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newTerminal, setNewTerminal] = useState(false)

  // Somebody else's change. Skipped while this screen's own action is in flight:
  // that action refetches when it settles, and a refetch landing mid-move would
  // put the card back where it was for a moment.
  const pendingRef = useRef(false)
  pendingRef.current = pending
  useLiveChanges((events) => {
    if (!pendingRef.current) board.refresh()
    if (events.some((event) => event.type === 'funnel.changed')) funnels.refresh()
  }, funnelId)

  const error = firstFailure(funnels.error, board.error, actionError)
  useSessionGuard(error, onSessionExpired)

  const columns = board.data ?? []
  const intakeForms = funnels.data?.find((funnel) => funnel.id === funnelId)?.forms ?? []
  const stages = columns.map((column) => column.stage)
  // Still busy while the refetch below is in flight: re-enabling the controls
  // over stale counts invites a second edit against a funnel that just moved.
  const busy = pending || board.loading || funnels.loading

  /**
   * Every action here changes a count, a position, or which column a card is in
   * — several of those at once for a move — so the board is refetched rather
   * than patched from the response. One round trip against four shapes to keep
   * in step by hand.
   */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setPending(true)
    setActionError(undefined)
    try {
      await action()
      board.reload()
      return true
    } catch (caught) {
      setActionError(caught)
      return false
    } finally {
      setPending(false)
    }
  }

  function handleMoveLead(leadId: number, stageId: number) {
    setDraggingId(undefined)
    setTouchOverId(undefined)
    // The empty option of a card's "Move to…" select, chosen by a keyboard
    // walking the list. Nothing to do, and Number('') is not a stage.
    if (!Number.isSafeInteger(stageId) || stageId <= 0) return
    // The card lands where it was dropped at once; the refetch after confirms
    // it, and a refused move refetches too, which puts it back.
    if (board.data !== undefined) board.set(withCardMoved(board.data, leadId, stageId))
    void run(() => moveLeadStage(leadId, stageId)).then((moved) => {
      if (!moved) board.reload()
    })
  }

  function handleReorderStage(id: number, offset: -1 | 1) {
    // The server takes the complete funnel in its new order and refuses a
    // partial one, so the swap is computed here and sent whole.
    const order = columns.map((column) => column.stage.id)
    const from = order.indexOf(id)
    const moved = order[from]
    const displaced = order[from + offset]
    if (moved === undefined || displaced === undefined) return
    const next = [...order]
    next[from] = displaced
    next[from + offset] = moved
    void run(() => reorderStages(next, funnelId))
  }

  async function handleCreateStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    if (busy || name === '') return
    // Cleared only on success, so a rejected name is still there to fix.
    if (await run(() => createStage(name, newTerminal, funnelId))) {
      setNewName('')
      setNewTerminal(false)
    }
  }

  return (
    <section className="screen screen-wide">
      <header className="screen-head">
        <h1>Funnel</h1>
        <FunnelPicker funnels={funnels.data ?? []} selected={funnelId} onChange={selectFunnel} disabled={busy} />
        <Link to="/leads/new" className="button-link">
          New lead
        </Link>
        <p className="count" aria-live="polite">
          {board.loading && board.data === undefined ? 'Loading…' : `${stages.length} stages`}
        </p>
      </header>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {stageErrorMessage(error)}
        </p>
      )}

      {/* Where this funnel's leads come from, for whoever is wiring up the website. */}
      {intakeForms.length > 0 && (
        <details className="panel board-intake">
          <summary>Connect a website form</summary>
          {intakeForms.map((form) => (
            <IntakeDetails key={form.id} form={form} />
          ))}
        </details>
      )}

      <div className="board">
        {columns.map((column, index) => (
          <StageColumn
            key={column.stage.id}
            column={column}
            stages={stages}
            index={index}
            columnCount={columns.length}
            busy={busy}
            draggingId={draggingId}
            touchOverId={touchOverId}
            onDragLead={setDraggingId}
            onTouchOver={setTouchOverId}
            onMoveLead={handleMoveLead}
            onEditStage={(id, patch) => run(() => updateStage(id, patch))}
            onReorderStage={handleReorderStage}
            onDeleteStage={(id) => void run(() => deleteStage(id))}
          />
        ))}

        {/* A column of its own, at the end, so adding a stage is where the
            stage will land rather than somewhere in the page furniture. */}
        <section className="board-column board-add" aria-label="Add a stage">
          <form className="stage-form" onSubmit={(event) => void handleCreateStage(event)}>
            <label className="field">
              <span className="field-label">New stage</span>
              <input
                value={newName}
                placeholder="Stage name"
                maxLength={MAX_STAGE_NAME_LENGTH}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={newTerminal}
                onChange={(event) => setNewTerminal(event.target.checked)}
              />
              <span>Terminal stage</span>
            </label>
            <div className="stage-form-actions">
              <button type="submit" disabled={busy || newName.trim() === ''}>
                Add stage
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  )
}

/** The board as it will be once the move lands: the card on top of its new column. */
export function withCardMoved(columns: BoardColumn[], leadId: number, stageId: number): BoardColumn[] {
  const lead = columns.flatMap((column) => column.leads).find((card) => card.id === leadId)
  const target = columns.find((column) => column.stage.id === stageId)
  if (lead === undefined || target === undefined || lead.stageId === stageId) return columns
  const moved = { ...lead, stageId, stageName: target.stage.name }
  return columns.map((column) => {
    if (column.stage.id === lead.stageId) {
      return { ...column, leads: column.leads.filter((card) => card.id !== leadId), total: column.total - 1 }
    }
    if (column.stage.id === stageId) return { ...column, leads: [moved, ...column.leads], total: column.total + 1 }
    return column
  })
}
