import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface MenuProps {
  /** What the trigger shows. */
  label: ReactNode
  /** The trigger's accessible name, when `label` is an icon or says less than it should. */
  ariaLabel?: string
  className?: string
  triggerClassName?: string
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
  disabled?: boolean
  /** Rendered only while open. `close` is for an item that should shut the menu when used. */
  children: (close: () => void) => ReactNode
}

/**
 * A disclosure that opens a floating panel: the trigger says whether it is
 * open, Escape or a click anywhere else shuts it, and focus goes back to the
 * trigger when Escape does. Items are ordinary buttons and links, so they work
 * with Tab and with every screen reader without a roving-focus scheme.
 */
export function Menu({
  label,
  ariaLabel,
  className,
  triggerClassName,
  align = 'end',
  disabled = false,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className={`menu${className === undefined ? '' : ` ${className}`}`}>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div id={panelId} className={`menu-panel menu-panel-${align}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
