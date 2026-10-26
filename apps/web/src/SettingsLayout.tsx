import type { ReactNode } from 'react'
import { Link } from './router.tsx'

export interface SettingsNavItem {
  to: string
  label: string
}

export interface SettingsLayoutProps {
  title: string
  /** One line under the title saying what this area covers. */
  description: ReactNode
  nav: SettingsNavItem[]
  /** The `to` of the section showing. */
  current: string
  children: ReactNode
}

/**
 * A settings area: its sections listed down the side, one showing at a time.
 * On a phone the list becomes a row of tabs above the section.
 */
export function SettingsLayout({ title, description, nav, current, children }: SettingsLayoutProps) {
  return (
    <div className="settings-layout">
      <header className="settings-head">
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </header>
      <nav className="settings-nav" aria-label={`${title} sections`}>
        {nav.map((item) => (
          <Link key={item.to} to={item.to} aria-current={item.to === current ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="settings-body">{children}</div>
    </div>
  )
}

export interface SettingsSectionProps {
  title: string
  description?: ReactNode
  /** Beside the title, for a control that acts on the whole section. */
  action?: ReactNode
  children: ReactNode
}

/** One section of a settings area, titled for the screen reader's heading list as well as the eye. */
export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  return (
    <section className="settings-section" aria-label={title}>
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {description !== undefined && <p className="hint section-description">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export interface SettingsCardProps {
  title: string
  description?: ReactNode
  children: ReactNode
}

/**
 * A group of related fields: what it is on the left, the fields on the right,
 * stacking on a narrow screen. Not a form itself — a section's cards usually
 * share one Save.
 */
export function SettingsCard({ title, description, children }: SettingsCardProps) {
  return (
    <div className="settings-card">
      <div className="settings-card-about">
        <h3>{title}</h3>
        {description !== undefined && <p className="hint">{description}</p>}
      </div>
      <div className="fields">{children}</div>
    </div>
  )
}
