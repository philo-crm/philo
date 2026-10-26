/*
 * Dragging a card with a finger. HTML5 drag and drop is a mouse affair — most
 * phone browsers never start one from a touch — so a touch drag is built from
 * pointer events: hold the card still for a moment to lift it, move, let go
 * over a column. Moving before the hold completes is a scroll, as it always was.
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/** How long a finger rests on a card before it lifts. Shorter reads as a tap, longer as a stall. */
export const LIFT_DELAY_MS = 350
/** A finger that wanders further than this before the lift is scrolling, not holding. */
const SLOP_PX = 10

/** Every column marks itself with this, so a drop can find the one under the finger. */
export const STAGE_ATTRIBUTE = 'data-stage-id'

export function stageAt(x: number, y: number): number | undefined {
  const target = document.elementFromPoint(x, y)?.closest(`[${STAGE_ATTRIBUTE}]`)
  const id = Number(target?.getAttribute(STAGE_ATTRIBUTE))
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export interface TouchDragOptions {
  disabled: boolean
  onLift: () => void
  /** The column under the finger as it moves; undefined when it is over none. */
  onOver: (stageId: number | undefined) => void
  /** Let go: over a column, or not (`undefined`), which puts the card back. */
  onDrop: (stageId: number | undefined) => void
}

interface Press {
  pointerId: number
  startX: number
  startY: number
  timer: ReturnType<typeof setTimeout> | undefined
  lifted: boolean
}

export function useTouchDrag<T extends HTMLElement>(options: TouchDragOptions) {
  const ref = useRef<T>(null)
  const press = useRef<Press | undefined>(undefined)
  const dropped = useRef(false)
  const [lifted, setLifted] = useState(false)
  const latest = useRef(options)
  latest.current = options

  function settle(element: T | null) {
    const current = press.current
    if (current === undefined) return
    clearTimeout(current.timer)
    press.current = undefined
    if (element !== null) {
      element.style.transform = ''
      setLifted(false)
    }
  }

  // React listens to touchmove passively, and only a non-passive listener may
  // stop the page scrolling under a lifted card.
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const hold = (event: TouchEvent) => {
      if (press.current?.lifted === true) event.preventDefault()
    }
    element.addEventListener('touchmove', hold, { passive: false })
    return () => element.removeEventListener('touchmove', hold)
  }, [])

  // A card that unmounts mid-drag — the board refetched — must not leave its timer running.
  useEffect(() => () => settle(null), [])

  return {
    ref,
    /** Held and following the finger. */
    lifted,
    onPointerDown(event: ReactPointerEvent<T>) {
      if (event.pointerType === 'mouse' || latest.current.disabled || press.current !== undefined) return
      const pointerId = event.pointerId
      const timer = setTimeout(() => {
        const current = press.current
        if (current === undefined || current.pointerId !== pointerId) return
        current.lifted = true
        setLifted(true)
        ref.current?.setPointerCapture?.(pointerId)
        latest.current.onLift()
      }, LIFT_DELAY_MS)
      press.current = { pointerId, startX: event.clientX, startY: event.clientY, timer, lifted: false }
    },
    onPointerMove(event: ReactPointerEvent<T>) {
      const current = press.current
      if (current === undefined || current.pointerId !== event.pointerId) return
      const dx = event.clientX - current.startX
      const dy = event.clientY - current.startY
      if (!current.lifted) {
        if (Math.hypot(dx, dy) > SLOP_PX) settle(ref.current)
        return
      }
      if (ref.current !== null) ref.current.style.transform = `translate(${dx}px, ${dy}px)`
      latest.current.onOver(stageAt(event.clientX, event.clientY))
    },
    onPointerUp(event: ReactPointerEvent<T>) {
      const current = press.current
      if (current === undefined || current.pointerId !== event.pointerId) return
      const wasLifted = current.lifted
      settle(ref.current)
      if (!wasLifted) return
      // The click the browser sends after this pointerup belongs to the drag.
      dropped.current = true
      setTimeout(() => {
        dropped.current = false
      }, 0)
      latest.current.onDrop(stageAt(event.clientX, event.clientY))
    },
    onPointerCancel(event: ReactPointerEvent<T>) {
      const current = press.current
      if (current === undefined || current.pointerId !== event.pointerId) return
      const wasLifted = current.lifted
      settle(ref.current)
      if (wasLifted) latest.current.onDrop(undefined)
    },
    /** A held finger opens the context menu on Android; a lifted card is not asking for one. */
    onContextMenu(event: ReactMouseEvent<T>) {
      if (press.current !== undefined) event.preventDefault()
    },
    /** A tap that became a drag must not also follow the card's link. */
    onClickCapture(event: ReactMouseEvent<T>) {
      if (dropped.current) event.preventDefault()
    },
  }
}
