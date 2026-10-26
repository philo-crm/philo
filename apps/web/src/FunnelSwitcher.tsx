import { useFunnels, useSelectedFunnel } from './FunnelPicker.tsx'
import { CheckIcon, ChevronDownIcon } from './icons.tsx'
import { Menu } from './Menu.tsx'
import { Link } from './router.tsx'

/**
 * The working funnel, chosen once in the top bar for every screen scoped to
 * one — the board, the lead list, a new lead, the funnel's own settings.
 */
export function FunnelSwitcher() {
  const funnels = useFunnels()
  const [selectedId, select] = useSelectedFunnel(funnels.data)
  const list = funnels.data ?? []
  const selected = list.find((funnel) => funnel.id === selectedId)

  return (
    <Menu
      className="funnel-switcher"
      triggerClassName="switcher-trigger"
      ariaLabel={selected === undefined ? 'Funnel' : `Funnel: ${selected.name}`}
      // Only while loading: after a failure the menu still leads to the settings.
      disabled={funnels.data === undefined && funnels.error === undefined}
      align="end"
      label={
        <>
          <span className="switcher-caption">Funnel</span>
          <span className="switcher-name">{selected?.name ?? '…'}</span>
          <ChevronDownIcon />
        </>
      }
    >
      {(close) => (
        <>
          <p className="menu-heading">Switch funnel</p>
          {funnels.error !== undefined && (
            <button type="button" className="menu-item" onClick={funnels.reload}>
              <span className="menu-check" />
              <span className="menu-item-text">Could not load funnels. Retry</span>
            </button>
          )}
          <ul className="menu-list">
            {list.map((funnel) => (
              <li key={funnel.id}>
                <button
                  type="button"
                  className="menu-item"
                  aria-current={funnel.id === selectedId ? 'true' : undefined}
                  onClick={() => {
                    select(funnel.id)
                    close()
                  }}
                >
                  <span className="menu-check">{funnel.id === selectedId && <CheckIcon />}</span>
                  <span className="menu-item-text">{funnel.name}</span>
                  <span className="menu-item-meta numeric">{funnel.leadCount}</span>
                </button>
              </li>
            ))}
          </ul>
          <hr className="menu-rule" />
          <Link to="/funnel" className="menu-item" onClick={close}>
            <span className="menu-check" />
            <span className="menu-item-text">Funnel settings</span>
          </Link>
          <Link to="/settings/funnels" className="menu-item" onClick={close}>
            <span className="menu-check" />
            <span className="menu-item-text">Add or remove funnels</span>
          </Link>
        </>
      )}
    </Menu>
  )
}
