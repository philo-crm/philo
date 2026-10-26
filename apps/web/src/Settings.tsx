import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  fetchEmailSettings,
  sendTestEmail,
  settingsErrorMessage,
  updateEmailSettings,
  MAX_SETTINGS_NAME_LENGTH,
  type EmailSettings,
  type EmailSettingsPatch,
} from './api.ts'
import { ApiKeys } from './ApiKeys.tsx'
import { FunnelList } from './FunnelSettings.tsx'
import { isStandalone, isIosSafari } from './install.ts'
import {
  disablePush,
  enablePush,
  readPushState,
  syncPushSubscription,
  type PushState,
} from './push.ts'
import { SettingsCard, SettingsLayout, SettingsSection } from './SettingsLayout.tsx'
import { useResource, useSessionGuard } from './useResource.ts'
import { Webhooks } from './Webhooks.tsx'

/** The server's own settings, as opposed to a funnel's — each one a page of the area. */
export const SETTINGS_SECTIONS = {
  email: 'Email & business',
  funnels: 'Funnels',
  notifications: 'Notifications',
  'api-keys': 'API keys',
  webhooks: 'Webhooks',
} as const

export type SettingsSection = keyof typeof SETTINGS_SECTIONS

const SETTINGS_NAV = Object.entries(SETTINGS_SECTIONS).map(([key, label]) => ({ to: `/settings/${key}`, label }))

export interface SettingsProps {
  section?: SettingsSection
  onSessionExpired: () => void
}

export function Settings({ section = 'email', onSessionExpired }: SettingsProps) {
  return (
    <SettingsLayout
      title="Server settings"
      description="Shared by every funnel and everyone who signs in."
      nav={SETTINGS_NAV}
      current={`/settings/${section}`}
    >
      {section === 'email' && <EmailSettings onSessionExpired={onSessionExpired} />}
      {section === 'funnels' && <FunnelList onSessionExpired={onSessionExpired} />}
      {section === 'notifications' && <PushNotifications onSessionExpired={onSessionExpired} />}
      {section === 'api-keys' && <ApiKeys onSessionExpired={onSessionExpired} />}
      {section === 'webhooks' && <Webhooks onSessionExpired={onSessionExpired} />}
    </SettingsLayout>
  )
}

interface SectionProps {
  onSessionExpired: () => void
}

function EmailSettings({ onSessionExpired }: SectionProps) {
  const load = useCallback((signal: AbortSignal) => fetchEmailSettings(signal), [])
  const settings = useResource(load)
  useSessionGuard(settings.error, onSessionExpired)

  if (settings.data !== undefined) return <EmailSettingsForm initial={settings.data} onSaved={settings.set} />
  return (
    <SettingsSection title="Email & business">
      {settings.error === undefined ? (
        <p className="empty">Loading…</p>
      ) : (
        <p className="notice notice-error" role="alert">
          {settingsErrorMessage(settings.error)}
        </p>
      )}
    </SettingsSection>
  )
}

/**
 * Push, per device. Deliberately not a stored setting: a subscription belongs
 * to the browser it was made in, so this switch says something about *this*
 * phone and nothing about the instance.
 */
function PushNotifications({ onSessionExpired }: SectionProps) {
  const [state, setState] = useState<PushState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)

  // A 401 here means the session ended, and the only useful answer is the sign-in
  // screen — the same handling every other authenticated screen has.
  useSessionGuard(error, onSessionExpired)

  useEffect(() => {
    let live = true
    // Sync rather than a plain read: the server may have dropped this browser's
    // row while it still holds the subscription, and that reads as "on" forever.
    void syncPushSubscription().then((current) => {
      if (live) setState(current)
    })
    return () => {
      live = false
    }
  }, [])

  /**
   * Straight out of the click, with nothing awaited first — iOS only honours
   * `Notification.requestPermission()` while the tap is still current, so a
   * `setBusy` that forced a render before it would break the one platform this
   * whole feature exists for.
   */
  function toggle() {
    if (busy || state === undefined) return
    setBusy(true)
    setError(undefined)
    const change = isEnabled(state) ? disablePush() : enablePush()
    void change
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught)
        // Whatever the browser actually ended up doing wins over what we asked
        // for, so the switch cannot be left claiming something untrue.
        return readPushState().then(setState)
      })
      .finally(() => setBusy(false))
  }

  return (
    <SettingsSection
      title="Notifications"
      description="For this device only. Each phone or browser that should be told about new leads turns this on for itself."
    >
      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {settingsErrorMessage(error)}
        </p>
      )}
      {state === undefined ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="panel">
          <div className="fields">
            <label className="check">
              <input
                type="checkbox"
                checked={isEnabled(state)}
                disabled={busy || state === 'unsupported' || state === 'blocked'}
                onChange={toggle}
              />
              <span>Push a notification to this device when a new lead arrives.</span>
            </label>
            <p className="hint">{pushHint(state)}</p>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

/**
 * Why the switch is where it is. The unsupported case is worth spelling out on
 * iOS specifically: a Safari tab simply cannot subscribe, and "install it first"
 * is the only useful thing to say — see install.ts and the /install screen.
 */
function pushHint(state: PushState): string {
  if (state === 'blocked') {
    return 'This browser has blocked notifications. Allow them for this site in its settings, then come back.'
  }
  if (state === 'unsupported') {
    if (isIosSafari() && !isStandalone()) {
      return 'On iPhone and iPad, push works only once Philo is added to the Home Screen. Open the install guide, then turn this on from the installed app.'
    }
    return 'This browser cannot receive push notifications. New leads are still emailed to everyone who can sign in.'
  }
  if (state === 'in-app') {
    return 'This browser has no push service, so Philo shows notifications only while it is open in a tab. In Brave, turn on "Use Google services for push messaging" in its privacy settings, restart it, then turn this off and on again. Email always goes out as well.'
  }
  return 'Email always goes out as well, so a missed push never means a missed lead.'
}

function isEnabled(state: PushState): boolean {
  return state === 'on' || state === 'in-app'
}

/** The editable copy. Strings throughout — the port is parsed on the way out. */
interface FormState {
  smtpHost: string
  smtpPort: string
  smtpSecure: boolean
  smtpUsername: string
  fromName: string
  fromAddress: string
  replyTo: string
  businessName: string
}

function toFormState(settings: EmailSettings): FormState {
  return {
    smtpHost: settings.smtpHost,
    smtpPort: String(settings.smtpPort),
    smtpSecure: settings.smtpSecure,
    smtpUsername: settings.smtpUsername,
    fromName: settings.fromName,
    fromAddress: settings.fromAddress,
    replyTo: settings.replyTo,
    businessName: settings.businessName,
  }
}

interface EmailSettingsFormProps {
  /** Read once, at mount. Everything after that is the form's own state. */
  initial: EmailSettings
  onSaved: (settings: EmailSettings) => void
}

function EmailSettingsForm({ initial, onSaved }: EmailSettingsFormProps) {
  const [form, setForm] = useState<FormState>(() => toFormState(initial))
  const [password, setPassword] = useState('')
  /**
   * Whether the password box has been touched. Untouched means "leave the
   * stored one alone", which is the only way an empty box can also mean
   * "remove it" — the value is never sent to the browser, so the box cannot
   * start out showing what is there.
   */
  const [passwordEdited, setPasswordEdited] = useState(false)
  const [passwordSet, setPasswordSet] = useState(initial.smtpPasswordSet)
  const [testTo, setTestTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  function patch(): EmailSettingsPatch {
    return {
      smtpHost: form.smtpHost,
      // A box holding nothing or nonsense reaches the server as something it
      // refuses by name, rather than being quietly turned into a default.
      smtpPort: Number(form.smtpPort),
      smtpSecure: form.smtpSecure,
      smtpUsername: form.smtpUsername,
      ...(passwordEdited ? { smtpPassword: password } : {}),
      fromName: form.fromName,
      fromAddress: form.fromAddress,
      replyTo: form.replyTo,
      businessName: form.businessName,
    }
  }

  async function save(): Promise<void> {
    const saved = await updateEmailSettings(patch())
    onSaved(saved)
    setForm(toFormState(saved))
    setPasswordSet(saved.smtpPasswordSet)
    setPassword('')
    setPasswordEdited(false)
  }

  async function run(action: () => Promise<void>, done: string) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      await action()
      setStatus(done)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(save, 'Settings saved.')
  }

  /**
   * Saves before it sends. The server tests the configuration it has stored, so
   * a test against values still sitting in these boxes would be a green light
   * for something the next real lead is not sent with.
   */
  function handleTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const to = testTo.trim()
    if (to === '') return
    void run(async () => {
      await save()
      await sendTestEmail(to)
    }, `Test email sent to ${to}.`)
  }

  return (
    <SettingsSection
      title="Email & business"
      description="New leads are emailed to everyone who can sign in, unless their funnel names its own recipients, and acknowledged to the applicant."
    >
      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {settingsErrorMessage(error)}
        </p>
      )}
      {status !== undefined && (
        <p className="notice notice-ok" role="status">
          {status}
        </p>
      )}

      <form className="panel settings-cards" aria-label="Email settings" onSubmit={handleSave}>
        <SettingsCard
          title="Business"
          description={
            <>
              Used wherever a template writes <code>{'{{business.name}}'}</code>.
            </>
          }
        >
          <label className="field">
            <span className="field-label">Business name</span>
            <input
              value={form.businessName}
              maxLength={MAX_SETTINGS_NAME_LENGTH}
              onChange={(event) => set('businessName', event.target.value)}
            />
          </label>
        </SettingsCard>

        <SettingsCard
          title="Sender"
          description="Who email from Philo appears to come from. Philo never receives email, so make the reply-to a real inbox. A funnel can override the name and reply-to."
        >
          <label className="field">
            <span className="field-label">From name</span>
            <input
              value={form.fromName}
              maxLength={MAX_SETTINGS_NAME_LENGTH}
              onChange={(event) => set('fromName', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">From address</span>
            <input
              type="email"
              value={form.fromAddress}
              autoComplete="off"
              placeholder="no-reply@example.com"
              onChange={(event) => set('fromAddress', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Reply-to</span>
            <input
              type="email"
              value={form.replyTo}
              autoComplete="off"
              placeholder="hello@example.com"
              onChange={(event) => set('replyTo', event.target.value)}
            />
          </label>
        </SettingsCard>

        <SettingsCard title="Mail server" description="The SMTP server Philo sends through.">
          <div className="field-row">
            <label className="field field-grow">
              <span className="field-label">SMTP host</span>
              <input
                value={form.smtpHost}
                autoComplete="off"
                placeholder="smtp.example.com"
                onChange={(event) => set('smtpHost', event.target.value)}
              />
            </label>
            <label className="field field-port">
              <span className="field-label">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={form.smtpPort}
                onChange={(event) => set('smtpPort', event.target.value)}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.smtpSecure}
              onChange={(event) => set('smtpSecure', event.target.checked)}
            />
            <span>TLS from the start (port 465). Leave off for STARTTLS on 587.</span>
          </label>
          <div className="field-row">
            <label className="field field-grow">
              <span className="field-label">Username</span>
              <input
                value={form.smtpUsername}
                autoComplete="off"
                onChange={(event) => set('smtpUsername', event.target.value)}
              />
            </label>
            <label className="field field-grow">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder={passwordSet && !passwordEdited ? 'Stored — leave blank to keep' : ''}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setPasswordEdited(true)
                }}
              />
            </label>
          </div>
          {passwordSet && passwordEdited && password === '' && (
            <p className="hint">Saving now removes the stored password.</p>
          )}
        </SettingsCard>

        <div className="form-footer">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      <form className="panel settings-cards" aria-label="Send a test email" onSubmit={handleTest}>
        <SettingsCard title="Test" description="Saves the settings above first, then sends with them.">
          <div className="field-row field-row-end">
            <label className="field field-grow">
              <span className="field-label">Send a test email to</span>
              <input
                type="email"
                value={testTo}
                autoComplete="off"
                placeholder="you@example.com"
                onChange={(event) => setTestTo(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary" disabled={busy || testTo.trim() === ''}>
              {busy ? 'Sending…' : 'Send test email'}
            </button>
          </div>
        </SettingsCard>
      </form>
    </SettingsSection>
  )
}
