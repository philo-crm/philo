import type { ComponentType } from 'react'
import type { User } from './auth.ts'
import { MonitorIcon, MoonIcon, SunIcon } from './icons.tsx'
import { Menu } from './Menu.tsx'
import { Link } from './router.tsx'
import { setTheme, THEMES, useTheme, type Theme } from './theme.ts'

const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }
const THEME_ICONS: Record<Theme, ComponentType> = { light: SunIcon, dark: MoonIcon, system: MonitorIcon }

function initials(user: User): string {
  const source = (user.name ?? user.email).trim()
  const words = source.split(/[\s@._-]+/).filter((word) => word !== '')
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2)
  return letters.toUpperCase()
}

export interface AccountMenuProps {
  user: User
  onSignOut: () => void
}

/** Who is signed in, and everything that belongs to the person or the server rather than a funnel. */
export function AccountMenu({ user, onSignOut }: AccountMenuProps) {
  const theme = useTheme()

  return (
    <Menu
      className="account-menu"
      triggerClassName="account-trigger"
      ariaLabel="Account"
      align="end"
      label={<span className="avatar" aria-hidden="true">{initials(user)}</span>}
    >
      {(close) => (
        <>
          <div className="menu-identity">
            {user.name !== null && <p className="menu-identity-name">{user.name}</p>}
            <p className="muted">{user.email}</p>
          </div>
          <hr className="menu-rule" />
          <div className="theme-picker" role="group" aria-label="Theme">
            {THEMES.map((option) => {
              const ThemeIcon = THEME_ICONS[option]
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={theme === option}
                  onClick={() => setTheme(option)}
                >
                  <ThemeIcon />
                  <span>{THEME_LABELS[option]}</span>
                </button>
              )
            })}
          </div>
          <hr className="menu-rule" />
          <Link to="/settings" className="menu-item" onClick={close}>
            <span className="menu-item-text">Server settings</span>
          </Link>
          <Link to="/install" className="menu-item" onClick={close}>
            <span className="menu-item-text">Install the app</span>
          </Link>
          <hr className="menu-rule" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              onSignOut()
            }}
          >
            <span className="menu-item-text">Sign out</span>
          </button>
        </>
      )}
    </Menu>
  )
}
