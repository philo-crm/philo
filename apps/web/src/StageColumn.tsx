import { useState, type DragEvent, type FormEvent } from 'react'
import {
  MAX_CONTACT_FIELD_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  type BoardColumn,
  type LeadRecord,
  type StageRecord,
} from './api.ts'
import { formatDateTime, leadContact, leadTitle } from './format.ts'
import { GripIcon, MoreIcon, PlusIcon } from './icons.tsx'
import { Menu } from './Menu.tsx'
import { Link } from './router.tsx'
import { STAGE_ATTRIBUTE, useTouchDrag } from './touchDrag.ts'

/** What the column's own add form collects — the rest of a lead is filled in on its screen. */
export interface QuickLead {
  name: string
  email: string
  phone: string
}

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
  /** The column being dragged by its grip, so the others know to make room. */
  draggingStageId: number | undefined
  /** The column a finger is holding a card or a column over — a touch drag has no dragover. */
  touchOverId: number | undefined
  onDragLead: (leadId: number | undefined) => void
  onDragStage: (stageId: number | undefined) => void
  onTouchOver: (stageId: number | undefined) => void
  onMoveLead: (leadId: number, stageId: number) => void
  onCreateLead: (stageId: number, lead: QuickLead) => Promise<boolean>
  onEditStage: (id: number, patch: { name: string; isTerminal: boolean }) => Promise<boolean>
  onReorderStage: (id: number, offset: -1 | 1) => void
  /** Dropped on another column: take that column's place. */
  onPlaceStage: (id: number, targetId: number) => void
  onDeleteStage: (id: number) => void
}

export function StageColumn({
  column,
  stages,
  index,
  columnCount,
  busy,
  draggingId,
  draggingStageId,
  touchOverId,
  onDragLead,
  onDragStage,
  onTouchOver,
  onMoveLead,
  onCreateLead,
  onEditStage,
  onReorderStage,
  onPlaceStage,
  onDeleteStage,
}: StageColumnProps) {
  const { stage } = column
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState(stage.name)
  const [isTerminal, setIsTerminal] = useState(stage.isTerminal)
  const [over, setOver] = useState(false)

  // The whole column follows the finger, though only the grip starts the drag.
  // Ref and pointer handlers share the <section>, as a card's share its <li>,
  // so the pointer captured at the lift keeps reaching the handlers.
  const touch = useTouchDrag<HTMLElement>({
    disabled: busy,
    onLift: () => onDragStage(stage.id),
    onOver: onTouchOver,
    onDrop: (targetId) => {
      onTouchOver(undefined)
      onDragStage(undefined)
      if (targetId !== undefined && targetId !== stage.id) onPlaceStage(stage.id, targetId)
    },
  })

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

  /** Another column, dragged by its grip, that would land in this one's place. */
  const takesStage = draggingStageId !== undefined && draggingStageId !== stage.id

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setOver(false)
    if (takesStage) {
      onPlaceStage(draggingStageId, stage.id)
      onDragStage(undefined)
      return
    }
    if (!accepts(draggingId)) return
    onMoveLead(draggingId, stage.id)
  }

  /**
   * A stage holding anything at all refuses to go, quarantined leads included —
   * so the gate is `leadCount`, which counts them, and not the column's `total`,
   * which is the non-spam number the board actually shows.
   */
  const deletable = stage.leadCount === 0 && columnCount > 1
  const touchedOver = touchOverId === stage.id && (accepts(draggingId) || takesStage)
  const highlighted = over || touchedOver
  // Which side the dragged column would land on, so the marker shows where.
  const draggedIndex = stages.findIndex((candidate) => candidate.id === draggingStageId)
  const placeMarker = takesStage && highlighted ? (draggedIndex > index ? ' is-place-before' : ' is-place-after') : ''

  const className = [
    'board-column',
    stage.isTerminal ? ' is-terminal' : '',
    highlighted && !takesStage ? ' is-over' : '',
    placeMarker,
    draggingStageId === stage.id ? ' is-moving' : '',
    touch.lifted ? ' is-lifted' : '',
  ].join('')

  return (
    <section
      ref={touch.ref}
      className={className}
      aria-label={stage.name}
      {...{ [STAGE_ATTRIBUTE]: stage.id }}
      onDragOver={(event) => {
        if (!takesStage && !accepts(draggingId)) return
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
      // On the column rather than the grip: a lifted column captures the
      // pointer on itself, and the moves, the drop and the cancel arrive here.
      // Only a press that starts on the grip lifts it; a card's own press
      // bubbles through and is ignored, the hook matching on pointer id.
      onPointerDown={(event) => {
        if ((event.target as Element).closest('.column-grip') !== null) touch.onPointerDown(event)
      }}
      onPointerMove={touch.onPointerMove}
      onPointerUp={touch.onPointerUp}
      onPointerCancel={touch.onPointerCancel}
      onContextMenu={touch.onContextMenu}
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
            <span
              className="column-grip"
              title="Drag to reorder"
              aria-hidden="true"
              draggable={!busy}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', `stage:${stage.id}`)
                event.dataTransfer.effectAllowed = 'move'
                const columnElement = event.currentTarget.closest('section')
                if (columnElement !== null) event.dataTransfer.setDragImage?.(columnElement, 20, 20)
                onDragStage(stage.id)
              }}
              onDragEnd={() => onDragStage(undefined)}
            >
              <GripIcon />
            </span>
            <h2 className="board-column-title">
              <span className="board-column-name">{stage.name}</span>
              <span className="board-column-count numeric">{column.total}</span>
            </h2>
            <div className="board-column-tools">
              <button
                type="button"
                className="icon-button"
                aria-label={`Add a lead to ${stage.name}`}
                aria-expanded={adding}
                disabled={busy}
                onClick={() => setAdding((value) => !value)}
              >
                <PlusIcon />
              </button>
              <Menu
                ariaLabel={`${stage.name} options`}
                triggerClassName="icon-button"
                label={<MoreIcon />}
                disabled={busy}
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        close()
                        startEditing()
                      }}
                    >
                      <span className="menu-item-text">Rename or change type</span>
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      aria-label={`Move ${stage.name} earlier`}
                      disabled={index === 0}
                      onClick={() => {
                        close()
                        onReorderStage(stage.id, -1)
                      }}
                    >
                      <span className="menu-item-text">Move left</span>
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      aria-label={`Move ${stage.name} later`}
                      disabled={index === columnCount - 1}
                      onClick={() => {
                        close()
                        onReorderStage(stage.id, 1)
                      }}
                    >
                      <span className="menu-item-text">Move right</span>
                    </button>
                    <hr className="menu-rule" />
                    <button
                      type="button"
                      className="menu-item menu-item-danger"
                      aria-label={`Delete ${stage.name}`}
                      disabled={!deletable}
                      onClick={() => {
                        close()
                        onDeleteStage(stage.id)
                      }}
                    >
                      <span className="menu-item-text">Delete stage</span>
                    </button>
                    {/* Why Delete is off. A disabled button shows no tooltip,
                        so the reason is written out under it instead. */}
                    {!deletable && (
                      <p className="menu-note">
                        {columnCount <= 1
                          ? 'A funnel keeps its last stage.'
                          : 'Only an empty stage can be deleted.'}
                      </p>
                    )}
                  </>
                )}
              </Menu>
            </div>
            {stage.isTerminal && <span className="tag tag-terminal">Terminal</span>}
          </>
        )}
      </header>

      {adding && (
        <QuickAddForm
          stageName={stage.name}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (lead) => {
            const created = await onCreateLead(stage.id, lead)
            if (created) setAdding(false)
            return created
          }}
        />
      )}

      {/*
        Why the column refuses to be deleted, when the column itself does not
        already say so. A column showing cards explains itself; an empty-looking
        one that refuses to go does not.
      */}
      {!deletable && column.total === 0 && !editing && (
        <p className="board-note muted">
          {columnCount <= 1
            ? 'A funnel keeps its last stage.'
            : `Holds ${stage.leadCount} quarantined ${stage.leadCount === 1 ? 'lead' : 'leads'}.`}
        </p>
      )}

      {column.leads.length === 0 ? (
        !adding && <p className="board-empty muted">No leads here.</p>
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

interface QuickAddFormProps {
  stageName: string
  busy: boolean
  onCancel: () => void
  onSubmit: (lead: QuickLead) => Promise<boolean>
}

/**
 * A lead entered straight into this column — a phone call, a walk-in. The same
 * rule as the full form: a name is optional, a way to reach them is not.
 */
function QuickAddForm({ stageName, busy, onCancel, onSubmit }: QuickAddFormProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [missingContact, setMissingContact] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (email.trim() === '' && phone.trim() === '') {
      setMissingContact(true)
      return
    }
    setMissingContact(false)
    await onSubmit({ name: name.trim(), email: email.trim(), phone: phone.trim() })
  }

  return (
    <form
      className="quick-add"
      aria-label={`New lead in ${stageName}`}
      onSubmit={(event) => void handleSubmit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <input
        aria-label="Name"
        placeholder="Name"
        value={name}
        autoFocus
        autoComplete="off"
        maxLength={MAX_CONTACT_FIELD_LENGTH}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        aria-label="Email"
        type="email"
        placeholder="Email"
        value={email}
        autoComplete="off"
        maxLength={MAX_EMAIL_LENGTH}
        onChange={(event) => setEmail(event.target.value)}
      />
      <input
        aria-label="Phone"
        type="tel"
        placeholder="Phone"
        value={phone}
        autoComplete="off"
        maxLength={MAX_CONTACT_FIELD_LENGTH}
        onChange={(event) => setPhone(event.target.value)}
      />
      {missingContact && (
        <p className="quick-add-error" role="alert">
          Add an email or a phone number.
        </p>
      )}
      <div className="stage-form-actions">
        <button type="submit" disabled={busy}>
          Add lead
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="hint">No email is sent to them or to you.</p>
    </form>
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
      <p className="muted board-card-contact">{leadContact(lead)}</p>
      <div className="board-card-foot">
        <span className="muted numeric board-card-meta">{formatDateTime(lead.createdAt)}</span>
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
      </div>
    </li>
  )
}
