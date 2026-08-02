import { useCallback, useState, type FormEvent } from 'react'
import {
  createStage,
  deleteStage,
  fetchBoard,
  moveLeadStage,
  reorderStages,
  stageErrorMessage,
  updateStage,
  MAX_STAGE_NAME_LENGTH,
} from './api.ts'
import { firstFailure } from './http.ts'
import { StageColumn } from './StageColumn.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface FunnelBoardProps {
  onSessionExpired: () => void
}

export function FunnelBoard({ onSessionExpired }: FunnelBoardProps) {
  const loadBoard = useCallback((signal: AbortSignal) => fetchBoard(signal), [])
  const board = useResource(loadBoard)

  const [actionError, setActionError] = useState<unknown>(undefined)
  const [pending, setPending] = useState(false)
  const [draggingId, setDraggingId] = useState<number | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newTerminal, setNewTerminal] = useState(false)

  const error = firstFailure(board.error, actionError)
  useSessionGuard(error, onSessionExpired)

  const columns = board.data ?? []
  const stages = columns.map((column) => column.stage)
  // Still busy while the refetch below is in flight: re-enabling the controls
  // over stale counts invites a second edit against a funnel that just moved.
  const busy = pending || board.loading

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
    // The empty option of a card's "Move to…" select, chosen by a keyboard
    // walking the list. Nothing to do, and Number('') is not a stage.
    if (!Number.isSafeInteger(stageId) || stageId <= 0) return
    void run(() => moveLeadStage(leadId, stageId))
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
    void run(() => reorderStages(next))
  }

  async function handleCreateStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newName.trim()
    if (busy || name === '') return
    // Cleared only on success, so a rejected name is still there to fix.
    if (await run(() => createStage(name, newTerminal))) {
      setNewName('')
      setNewTerminal(false)
    }
  }

  return (
    <section className="screen screen-wide">
      <header className="screen-head">
        <h1>Funnel</h1>
        <p className="count" aria-live="polite">
          {board.loading && board.data === undefined ? 'Loading…' : `${stages.length} stages`}
        </p>
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
            onDragLead={setDraggingId}
            onMoveLead={handleMoveLead}
            onEditStage={(id, patch) => run(() => updateStage(id, patch))}
            onReorderStage={handleReorderStage}
            onDeleteStage={(id) => void run(() => deleteStage(id))}
          />
        ))}

        {/* The last column is always the one that adds another, so an instance
            whose funnel somehow has no stages is still repairable from here. */}
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
