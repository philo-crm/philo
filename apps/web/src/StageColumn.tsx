import { useState, type DragEvent, type FormEvent } from 'react'
import { MAX_STAGE_NAME_LENGTH, type BoardColumn, type LeadRecord, type StageRecord } from './api.ts'
import { formatDateTime, leadContact, leadTitle } from './format.ts'
import { Link } from './router.tsx'
import { STAGE_ATTRIBUTE, useTouchDrag } from './touchDrag.ts'

export interface StageColumnProps {
  column: BoardColumn
  /** Every stage: transitions are unrestricted, so a card can go to any of them. */
  stages: StageRecord[]
  /** Where this column sits, so the reorder controls know which ends are ends. */
  index: number
  columnCount: number
  /** Something is in flight somewhere on the board; every control waits for it. */
  busy: boolean
  /** The card being dragged, so a column knows whether a drop is worth taking. */
  draggingId: number | undefined
  /** The column a finger is holding a card over — a touch drag has no dragover. */
  touchOverId: number | undefined
  onDragLead: (leadId: number | undefined) => void
  onTouchOver: (stageId: number | undefined) => void
  onMoveLead: (leadId: number, stageId: number) => void
  onEditStage: (id: number, patch: { name: string; isTerminal: boolean }) => Promise<boolean>
  onReorderStage: (id: number, offset: -1 | 1) => void
  onDeleteStage: (id: number) => void
}

export function StageColumn({
  column,
  stages,
  index,
  columnCount,
  busy,
  draggingId,
  touchOverId,
  onDragLead,
  onTouchOver,
  onMoveLead,
  onEditStage,
  onReorderStage,
  onDeleteStage,
}: StageColumnProps) {
  const { stage } = column
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(stage.name)
  const [isTerminal, setIsTerminal] = useState(stage.isTerminal)
  const [over, setOver] = useState(false)

  function startEditing() {
    // Seeded from the stage each time the form opens, so a cancelled edit — or
    // a rename that landed from somewhere else — does not come back as a draft.
    setName(stage.name)
    setIsTerminal(stage.isTerminal)
    setEditing(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    // Enter in the name box submits too, and the Save button being disabled does
    // not stop it — so the in-flight check belongs here, not only on the button.
    if (busy || trimmed === '') return
    if (await onEditStage(stage.id, { name: trimmed, isTerminal })) setEditing(false)
  }

  /**
   * A card this column would actually take: one that is being dragged, and that
   * is not already sitting here. Both the highlight and the drop ask, so that
   * the accent border never offers a drop the drop handler will refuse.
   */
  function accepts(id: number | undefined): id is number {
    return id !== undefined && !column.leads.some((lead) => lead.id === id)
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setOver(false)
    if (!accepts(draggingId)) return
    onMoveLead(draggingId, stage.id)
  }

  /**
   * A stage holding anything at all refuses to go, quarantined leads included —
   * so the gate is `leadCount`, which counts them, and not the column's `total`,
   * which is the non-spam number the board actually shows.
   */
  const deletable = stage.leadCount === 0 && columnCount > 1
  const highlighted = over || (touchOverId === stage.id && accepts(draggingId))

  return (
    <section
      className={`board-column${stage.isTerminal ? ' is-terminal' : ''}${highlighted ? ' is-over' : ''}`}
      aria-label={stage.name}
      {...{ [STAGE_ATTRIBUTE]: stage.id }}
      onDragOver={(event) => {
        if (!accepts(draggingId)) return
        // Without this the browser refuses the drop and animates the card home.
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={(event) => {
        // dragleave bubbles up from every card, so the pointer crossing onto one
        // would otherwise read as leaving the column and blink the highlight off
        // at each card boundary. relatedTarget is null when the drag leaves the
        // window entirely, which does mean leaving.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOver(false)
      }}
      onDrop={handleDrop}
    >
      <header className="board-column-head">
        {editing ? (
          <form className="stage-form" onSubmit={(event) => void handleSubmit(event)}>
            <label className="field">
              <span className="field-label">Stage name</span>
              <input
                value={name}
                autoFocus
                maxLength={MAX_STAGE_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={isTerminal}
                onChange={(event) => setIsTerminal(event.target.checked)}
              />
              <span>Terminal stage</span>
            </label>
            <div className="stage-form-actions">
              <button type="submit" disabled={busy || name.trim() === ''}>
                Save
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <h2 className="board-column-title">
              {stage.name}
              {stage.isTerminal && <span className="tag tag-terminal">Terminal</span>}
            </h2>
            <p className="count numeric">{column.total}</p>
            <div className="board-column-actions">
              <button type="button" disabled={busy} onClick={startEditing}>
                Rename
              </button>
              <button
                type="button"
                aria-label={`Move ${stage.name} earlier`}
                disabled={busy || index === 0}
                onClick={() => onReorderStage(stage.id, -1)}
              >
                ←
              </button>
              <button
                type="button"
                aria-label={`Move ${stage.name} later`}
                disabled={busy || index === columnCount - 1}
                onClick={() => onReorderStage(stage.id, 1)}
              >
                →
              </button>
              <button
                type="button"
                aria-label={`Delete ${stage.name}`}
                disabled={busy || !deletable}
                onClick={() => onDeleteStage(stage.id)}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </header>

      {/*
        Why Delete is off, when the column itself does not already say so. A
        column showing cards explains itself; an empty-looking one that refuses
        to go does not, and a `title` on a disabled button is no help — browsers
        suppress pointer events on those, so the tooltip never appears.
      */}
      {!deletable && column.total === 0 && !editing && (
        <p className="board-note muted">
          {columnCount <= 1
            ? 'A funnel keeps its last stage.'
            : `Holds ${stage.leadCount} quarantined ${stage.leadCount === 1 ? 'lead' : 'leads'}.`}
        </p>
      )}

      {column.leads.length === 0 ? (
        <p className="board-empty muted">No leads here.</p>
      ) : (
        <ol className="board-cards">
          {column.leads.map((lead) => (
            <BoardCard
              key={lead.id}
              lead={lead}
              stage={stage}
              stages={stages}
              busy={busy}
              dragging={draggingId === lead.id}
              onDragLead={onDragLead}
              onTouchOver={onTouchOver}
              onMoveLead={onMoveLead}
            />
          ))}
        </ol>
      )}

      {column.total > column.leads.length && (
        <p className="board-more muted numeric">
          Showing {column.leads.length} of {column.total}
        </p>
      )}
    </section>
  )
}

interface BoardCardProps {
  lead: LeadRecord
  /** The column it sits in. */
  stage: StageRecord
  stages: StageRecord[]
  busy: boolean
  dragging: boolean
  onDragLead: (leadId: number | undefined) => void
  onTouchOver: (stageId: number | undefined) => void
  onMoveLead: (leadId: number, stageId: number) => void
}

/**
 * One card. A mouse drags it with HTML5 drag and drop; a finger holds it still
 * to lift it and drags from there — see touchDrag.ts. Both end in the same
 * `onMoveLead`, and so does the select, which is what keeps it usable with
 * neither.
 */
function BoardCard({ lead, stage, stages, busy, dragging, onDragLead, onTouchOver, onMoveLead }: BoardCardProps) {
  const touch = useTouchDrag<HTMLLIElement>({
    disabled: busy,
    onLift: () => onDragLead(lead.id),
    onOver: onTouchOver,
    onDrop: (stageId) => {
      onTouchOver(undefined)
      if (stageId === undefined || stageId === stage.id) onDragLead(undefined)
      else onMoveLead(lead.id, stageId)
    },
  })

  return (
    <li
      ref={touch.ref}
      className={`board-card${dragging ? ' is-dragging' : ''}${touch.lifted ? ' is-lifted' : ''}`}
      draggable={!busy}
      onDragStart={(event) => {
        // Which card is moving is React state, not payload — but Firefox
        // refuses to start a drag whose dragstart carried no data at all.
        event.dataTransfer.setData('text/plain', String(lead.id))
        event.dataTransfer.effectAllowed = 'move'
        onDragLead(lead.id)
      }}
      onDragEnd={() => onDragLead(undefined)}
      onPointerDown={touch.onPointerDown}
      onPointerMove={touch.onPointerMove}
      onPointerUp={touch.onPointerUp}
      onPointerCancel={touch.onPointerCancel}
      onContextMenu={touch.onContextMenu}
      onClickCapture={touch.onClickCapture}
    >
      <Link to={`/leads/${lead.id}`} className="board-card-title" draggable={false}>
        {leadTitle(lead)}
      </Link>
      <p className="muted">{leadContact(lead)}</p>
      <p className="muted numeric board-card-meta">{formatDateTime(lead.createdAt)}</p>
      {/*
        What makes the board work without a pointer. Value stays empty so
        the control always reads "Move to…" rather than claiming to be a
        stage picker whose current stage is the column it already sits in.
      */}
      <select
        className="board-card-move"
        aria-label={`Move ${leadTitle(lead)} to another stage`}
        value=""
        disabled={busy}
        onChange={(event) => onMoveLead(lead.id, Number(event.target.value))}
      >
        <option value="">Move to…</option>
        {stages
          .filter((option) => option.id !== stage.id)
          .map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.name}
            </option>
          ))}
      </select>
    </li>
  )
}
