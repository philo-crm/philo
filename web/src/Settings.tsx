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
import { EmailTemplates } from './EmailTemplates.tsx'
import { isStandalone, isIosSafari } from './install.ts'
import {
  disablePush,
  enablePush,
  readPushState,
  syncPushSubscription,
  type PushState,
} from './push.ts'
import { useResource, useSessionGuard } from './useResource.ts'

export interface SettingsProps {
  onSessionExpired: () => void
}

export function Settings({ onSessionExpired }: SettingsProps) {
  const load = useCallback((signal: AbortSignal) => fetchEmailSettings(signal), [])
  const settings = useResource(load)
  useSessionGuard(settings.error, onSessionExpired)

  return (
    <>
      {settings.data === undefined ? (
        <section className="screen">
          <h1>Settings</h1>
          {settings.error === undefined ? (
            <p className="empty">Loading…</p>
          ) : (
            <p className="notice notice-error" role="alert">
              {settingsErrorMessage(settings.error)}
            </p>
          )}
        </section>
      ) : (
        <EmailSettingsForm initial={settings.data} onSaved={settings.set} />
      )}
      {/* Outside the branch above: a template is editable whether or not the
          SMTP settings loaded, and the two fail independently. */}
      <PushNotifications onSessionExpired={onSessionExpired} />
      <EmailTemplates onSessionExpired={onSessionExpired} />
    </>
  )
}

/**
 * Push, per device. Deliberately not a stored setting: a subscription belongs
 * to the browser it was made in, so this switch says something about *this*
 * phone and nothing about the instance.
 */
function PushNotifications({ onSessionExpired }: SettingsProps) {
  const [state, setState] = useState<PushState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)

  // A 401 here means the session ended, and the only useful answer is the login
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
    const change = state === 'on' ? disablePush() : enablePush()
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
    <section className="screen">
      {/* h2 rather than h1: this sits under the Settings screen's own heading. */}
      <header className="screen-head">
        <h2>Notifications on this device</h2>
      </header>

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
                checked={state === 'on'}
                disabled={busy || state === 'unsupported' || state === 'blocked'}
                onChange={toggle}
              />
              <span>Push a notification to this device when a new lead arrives.</span>
            </label>
            <p className="hint">{pushHint(state)}</p>
          </div>
        </div>
      )}
    </section>
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
  return 'Email always goes out as well, so a missed push never means a missed lead.'
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
    <section className="screen">
      <header className="screen-head">
        <h1>Settings</h1>
      </header>

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

      <form className="settings-form" onSubmit={handleSave}>
        <div className="panels">
          <div className="panel">
            <h2>Mail server</h2>
            <div className="fields">
              <label className="field">
                <span className="field-label">SMTP host</span>
                <input
                  value={form.smtpHost}
                  autoComplete="off"
                  placeholder="smtp.example.com"
                  onChange={(event) => set('smtpHost', event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.smtpPort}
                  onChange={(event) => set('smtpPort', event.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.smtpSecure}
                  onChange={(event) => set('smtpSecure', event.target.checked)}
                />
                <span>TLS from the start (port 465). Leave off for STARTTLS on 587.</span>
              </label>
              <label className="field">
                <span className="field-label">Username</span>
                <input
                  value={form.smtpUsername}
                  autoComplete="off"
                  onChange={(event) => set('smtpUsername', event.target.value)}
                />
              </label>
              <label className="field">
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
              {passwordSet && passwordEdited && password === '' && (
                <p className="hint">Saving now removes the stored password.</p>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Sender</h2>
            <div className="fields">
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
              <p className="hint">
                Where a reply to the acknowledgment lands. Philo never receives email, so make this
                a real inbox.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2>Business</h2>
            <div className="fields">
              <label className="field">
                <span className="field-label">Business name</span>
                <input
                  value={form.businessName}
                  maxLength={MAX_SETTINGS_NAME_LENGTH}
                  onChange={(event) => set('businessName', event.target.value)}
                />
              </label>
              <p className="hint">
                Used wherever a template writes <code>{'{{business.name}}'}</code>.
              </p>
            </div>
          </div>
        </div>

        <div className="settings-actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          <span className="hint">
            New leads are emailed to everyone who can sign in, and acknowledged to the applicant.
          </span>
        </div>
      </form>

      <form className="panel test-form" onSubmit={handleTest}>
        <h2>Test</h2>
        <label className="field">
          <span className="field-label">Send a test email to</span>
          <input
            type="email"
            value={testTo}
            autoComplete="off"
            placeholder="you@example.com"
            onChange={(event) => setTestTo(event.target.value)}
          />
        </label>
        <p className="hint">Saves the settings above first, then sends with them.</p>
        <div className="settings-actions">
          <button type="submit" disabled={busy || testTo.trim() === ''}>
            {busy ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      </form>
    </section>
  )
}
