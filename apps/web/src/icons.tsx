import type { ReactNode } from 'react'

/**
 * Line icons on a 16-unit grid, drawn in the text colour. Decorative: every
 * control that shows one also carries its name in text or `aria-label`.
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const ChevronDownIcon = () => (
  <Icon>
    <path d="m4 6 4 4 4-4" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
)

export const MoreIcon = () => (
  <Icon>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Icon>
)

export const GripIcon = () => (
  <Icon>
    {[4, 8, 12].map((y) => (
      <g key={y}>
        <circle cx="6" cy={y} r="0.5" fill="currentColor" />
        <circle cx="10" cy={y} r="0.5" fill="currentColor" />
      </g>
    ))}
  </Icon>
)

export const SunIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Icon>
)

export const MoonIcon = () => (
  <Icon>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
  </Icon>
)

export const MonitorIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="8" rx="1" />
    <path d="M6 14h4M8 11v3" />
  </Icon>
)

export const SettingsIcon = () => (
  <Icon>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Icon>
)
