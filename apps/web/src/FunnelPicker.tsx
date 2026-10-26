import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fetchFunnels, type FunnelRecord } from './api.ts'
import { useResource, type Resource } from './useResource.ts'

/** The funnel the board and the funnel settings last showed, per browser. */
const SELECTED_FUNNEL_KEY = 'philo.funnel'

function readStored(): number | undefined {
  try {
    const raw = window.localStorage.getItem(SELECTED_FUNNEL_KEY)
    const id = raw === null ? Number.NaN : Number(raw)
    return Number.isSafeInteger(id) && id > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * One selection for the whole app — ADR-0009. The switcher in the top bar and
 * every screen scoped to a funnel read the same value, so changing it in one
 * place moves them all.
 */
const selectionListeners = new Set<() => void>()
/** Kept alongside storage so a browser that refuses to store still switches for this visit. */
let selection = readStored()

export function selectFunnel(id: number): void {
  selection = id
  try {
    window.localStorage.setItem(SELECTED_FUNNEL_KEY, String(id))
  } catch {
    // A browser that remembers nothing starts on the default funnel next time.
  }
  for (const listener of selectionListeners) listener()
}

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener)
  return () => selectionListeners.delete(listener)
}

function currentSelection(): number | undefined {
  return selection ?? readStored()
}

/**
 * Funnels are listed by several mounted components at once — the switcher and
 * whatever screen is open — so a change made through one of them tells the rest
 * to refetch rather than leave the switcher showing an old name.
 */
const changeListeners = new Set<() => void>()

export function funnelsChanged(): void {
  for (const listener of changeListeners) listener()
}

export function useFunnels(): Resource<FunnelRecord[]> {
  const load = useCallback((signal: AbortSignal) => fetchFunnels(signal), [])
  const funnels = useResource(load)
  const { refresh } = funnels
  useEffect(() => {
    changeListeners.add(refresh)
    return () => {
      changeListeners.delete(refresh)
    }
  }, [refresh])
  return funnels
}

/**
 * Which funnel is selected. A remembered funnel that has since been deleted
 * falls back to the default. Undefined until the funnel list has loaded.
 */
export function useSelectedFunnel(funnels: FunnelRecord[] | undefined): [number | undefined, (id: number) => void] {
  const chosen = useSyncExternalStore(subscribeSelection, currentSelection)
  if (funnels === undefined) return [undefined, selectFunnel]
  const selected = funnels.find((funnel) => funnel.id === chosen) ?? funnels.find((funnel) => funnel.isDefault)
  return [selected?.id ?? funnels[0]?.id, selectFunnel]
}

export interface FunnelPickerProps {
  funnels: FunnelRecord[]
  selected: number | undefined
  onChange: (id: number) => void
  disabled?: boolean
}

/** A plain select, for a form that files something into a funnel. Nothing on a one-funnel instance. */
export function FunnelPicker({ funnels, selected, onChange, disabled = false }: FunnelPickerProps) {
  if (funnels.length < 2) return null
  return (
    <label className="field">
      <span className="field-label">Funnel</span>
      <select
        value={selected === undefined ? '' : String(selected)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {funnels.map((funnel) => (
          <option key={funnel.id} value={String(funnel.id)}>
            {funnel.name}
          </option>
        ))}
      </select>
    </label>
  )
}
