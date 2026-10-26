import { useCallback, useRef, useState, type FormEvent } from 'react'
import {
  createLead,
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
import { useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { firstFailure } from './http.ts'
import { PlusIcon, SettingsIcon } from './icons.tsx'
import { useLiveChanges } from './live.ts'
import { Link } from './router.tsx'
import { StageColumn, type QuickLead } from './StageColumn.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface FunnelBoardProps {
  onSessionExpired: () => void
}

export function FunnelBoard({ onSessionExpired }: FunnelBoardProps) {
  const funnels = useFunnels()
  const [funnelId] = useSelectedFunnel(funnels.data)
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
  const [draggingStageId, setDraggingStageId] = useState<number | undefined>(undefined)
  const [touchOverId, setTouchOverId] = useState<number | undefined>(undefined)
  const [addingStage, setAddingStage] = useState(false)
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
  const funnel = funnels.data?.find((candidate) => candidate.id === funnelId)
  const leadTotal = columns.reduce((sum, column) => sum + column.total, 0)
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

  /**
   * The server takes the complete funnel in its new order and refuses a
   * partial one, so the new order is computed here and sent whole. The columns
   * move at once; a refused order refetches, which puts them back.
   */
  function handlePlaceStage(id: number, targetId: number) {
    const order = withStagePlaced(columns.map((column) => column.stage.id), id, targetId)
    if (order === undefined || board.data === undefined) return
    const byId = new Map(board.data.map((column) => [column.stage.id, column]))
    board.set(order.flatMap((stageId) => byId.get(stageId) ?? []))
    void run(() => reorderStages(order, funnelId)).then((placed) => {
      if (!placed) board.reload()
    })
  }

  function handleReorderStage(id: number, offset: -1 | 1) {
    const order = columns.map((column) => column.stage.id)
    const target = order[order.indexOf(id) + offset]
    if (target !== undefined) handlePlaceStage(id, target)
  }

  function handleCreateLead(stageId: number, lead: QuickLead): Promise<boolean> {
    return run(() =>
      createLead({
        name: lead.name === '' ? undefined : lead.name,
        email: lead.email === '' ? undefined : lead.email,
        phone: lead.phone === '' ? undefined : lead.phone,
        funnelId,
        stageId,
      }),
    )
  }

  async function handleCreateStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    if (busy || name === '') return
    // Cleared only on success, so a rejected name is still there to fix.
    if (await run(() => createStage(name, newTerminal, funnelId))) {
      setNewName('')
      setNewTerminal(false)
      setAddingStage(false)
    }
  }

  return (
    <section className="screen screen-wide">
      <header className="screen-head">
        <div className="screen-title">
          <h1>{funnel?.name ?? 'Board'}</h1>
          <p className="count" aria-live="polite">
            {board.loading && board.data === undefined
              ? 'Loading…'
              : `${leadTotal} ${leadTotal === 1 ? 'lead' : 'leads'} in ${stages.length} ${stages.length === 1 ? 'stage' : 'stages'}`}
          </p>
        </div>
        <Link to="/funnel" className="button-link button-quiet">
          <SettingsIcon />
          <span>Funnel settings</span>
        </Link>
      </header>

      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {stageErrorMessage(error)}
        </p>
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
            draggingStageId={draggingStageId}
            touchOverId={touchOverId}
            onDragLead={setDraggingId}
            onDragStage={setDraggingStageId}
            onTouchOver={setTouchOverId}
            onMoveLead={handleMoveLead}
            onCreateLead={handleCreateLead}
            onEditStage={(id, patch) => run(() => updateStage(id, patch))}
            onReorderStage={handleReorderStage}
            onPlaceStage={handlePlaceStage}
            onDeleteStage={(id) => void run(() => deleteStage(id))}
          />
        ))}

        {/* A column of its own, at the end, so adding a stage is where the
            stage will land rather than somewhere in the page furniture. */}
        <section className="board-column board-add" aria-label="Add a stage">
          {addingStage ? (
            <form className="stage-form" onSubmit={(event) => void handleCreateStage(event)}>
              <label className="field">
                <span className="field-label">New stage</span>
                <input
                  value={newName}
                  autoFocus
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
                <span>Terminal stage — where leads finish</span>
              </label>
              <div className="stage-form-actions">
                <button type="submit" disabled={busy || newName.trim() === ''}>
                  Add stage
                </button>
                <button type="button" disabled={busy} onClick={() => setAddingStage(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="board-add-button" disabled={busy} onClick={() => setAddingStage(true)}>
              <PlusIcon />
              <span>New stage</span>
            </button>
          )}
        </section>
      </div>
    </section>
  )
}

/**
 * The stage order once `id` takes `targetId`'s place: dropped on a column to
 * its right it lands after that column, to its left before it. Undefined when
 * either is not in the order or nothing would move.
 */
export function withStagePlaced(order: number[], id: number, targetId: number): number[] | undefined {
  const from = order.indexOf(id)
  const to = order.indexOf(targetId)
  if (from === -1 || to === -1 || from === to) return undefined
  const next = order.filter((stageId) => stageId !== id)
  next.splice(to, 0, id)
  return next
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
