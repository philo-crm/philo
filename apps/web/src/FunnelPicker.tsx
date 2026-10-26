import { useCallback, useState } from 'react'
import { fetchFunnels, type FunnelRecord } from './api.ts'
import { useResource, type Resource } from './useResource.ts'

/** The funnel the board and the template editor last showed, per browser. */
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

function writeStored(id: number): void {
  try {
    window.localStorage.setItem(SELECTED_FUNNEL_KEY, String(id))
  } catch {
    // A browser that remembers nothing starts on the default funnel next time.
  }
}

export function useFunnels(): Resource<FunnelRecord[]> {
  const load = useCallback((signal: AbortSignal) => fetchFunnels(signal), [])
  return useResource(load)
}

/**
 * Which funnel a screen is showing — ADR-0009. Remembered across screens and
 * visits; a remembered funnel that has since been deleted falls back to the
 * default. Undefined until the funnel list has loaded.
 */
export function useSelectedFunnel(funnels: FunnelRecord[] | undefined): [number | undefined, (id: number) => void] {
  const [chosen, setChosen] = useState(readStored)
  const select = useCallback((id: number) => {
    writeStored(id)
    setChosen(id)
  }, [])

  if (funnels === undefined) return [undefined, select]
  const selected = funnels.find((funnel) => funnel.id === chosen) ?? funnels.find((funnel) => funnel.isDefault)
  return [selected?.id ?? funnels[0]?.id, select]
}

export interface FunnelPickerProps {
  funnels: FunnelRecord[]
  selected: number | undefined
  onChange: (id: number) => void
  disabled?: boolean
}

/** Nothing at all on an instance with one funnel, which is most of them. */
export function FunnelPicker({ funnels, selected, onChange, disabled = false }: FunnelPickerProps) {
  if (funnels.length < 2) return null
  return (
    <label className="field funnel-picker">
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
