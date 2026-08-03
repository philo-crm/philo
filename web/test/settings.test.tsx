import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/Settings.tsx'
import { installFakeApi, TEST_EMAIL_SETTINGS, type StoredEmailSettings } from './support/fake-api.ts'

function renderSettings(onSessionExpired = vi.fn()) {
  return render(<Settings onSessionExpired={onSessionExpired} />)
}

/** Resolves once the loaded settings are on screen rather than the spinner. */
async function loaded() {
  return screen.findByDisplayValue(TEST_EMAIL_SETTINGS.smtpHost)
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
}

const UNCONFIGURED: StoredEmailSettings = {
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUsername: '',
  smtpPassword: '',
  fromName: '',
  fromAddress: '',
  replyTo: '',
  businessName: '',
}

describe('Settings', () => {
  it('fills the form from the stored configuration', async () => {
    installFakeApi()
    renderSettings()
    await loaded()

    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('587')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('apikey')
    expect((screen.getByLabelText('From address') as HTMLInputElement).value).toBe(
      'no-reply@example.com',
    )
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Example Co')
  })

  it('never puts the stored password in the page, and says one is held', async () => {
    installFakeApi()
    renderSettings()
    await loaded()

    const password = screen.getByLabelText('Password') as HTMLInputElement
    expect(password.value).toBe('')
    expect(password.getAttribute('placeholder')).toBe('Stored — leave blank to keep')
    expect(document.body.innerHTML).not.toContain('stored-secret')
  })

  it('saves the edited fields', async () => {
    const api = installFakeApi()
    renderSettings()
    await loaded()

    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp2.example.com' } })
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '465' } })
    fireEvent.click(screen.getByLabelText(/TLS from the start/))
    save()

    expect(await screen.findByText('Settings saved.')).toBeDefined()
    expect(api.emailSettings.smtpHost).toBe('smtp2.example.com')
    expect(api.emailSettings.smtpPort).toBe(465)
    expect(api.emailSettings.smtpSecure).toBe(true)
  })

  it('leaves the stored password alone when the box is not touched', async () => {
    const api = installFakeApi()
    renderSettings()
    await loaded()

    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp2.example.com' } })
    save()

    await screen.findByText('Settings saved.')
    expect(api.emailSettings.smtpPassword).toBe('stored-secret')
    const patch = api.calls.findLast((call) => call.method === 'PATCH')
    expect(patch?.body).not.toHaveProperty('smtpPassword')
  })

  it('replaces the password when one is typed', async () => {
    const api = installFakeApi()
    renderSettings()
    await loaded()

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-secret' } })
    save()

    await screen.findByText('Settings saved.')
    expect(api.emailSettings.smtpPassword).toBe('new-secret')
    // Cleared afterwards, so a shared screen does not sit there holding it.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('removes the password when the box is emptied on purpose', async () => {
    const api = installFakeApi()
    renderSettings()
    await loaded()

    const password = screen.getByLabelText('Password')
    fireEvent.change(password, { target: { value: 'x' } })
    fireEvent.change(password, { target: { value: '' } })
    expect(screen.getByText('Saving now removes the stored password.')).toBeDefined()

    save()

    await screen.findByText('Settings saved.')
    expect(api.emailSettings.smtpPassword).toBe('')
    expect(
      (screen.getByLabelText('Password') as HTMLInputElement).getAttribute('placeholder'),
    ).toBe('')
  })

  it('reports the field the server refused, and keeps what was typed', async () => {
    installFakeApi()
    renderSettings()
    await loaded()

    // A domain with no dot: the browser's own `type="email"` check lets it
    // through, and the server's stricter rule is what refuses it — which is the
    // only way this message is ever reached.
    fireEvent.change(screen.getByLabelText('From address'), { target: { value: 'dana@example' } })
    save()

    expect(
      await screen.findByText('The sender address has to be a valid email address.'),
    ).toBeDefined()
    expect((screen.getByLabelText('From address') as HTMLInputElement).value).toBe('dana@example')
  })

  it('saves before it sends a test, so the test uses what was stored', async () => {
    const api = installFakeApi()
    renderSettings()
    await loaded()

    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp3.example.com' } })
    fireEvent.change(screen.getByLabelText('Send a test email to'), {
      target: { value: 'ops@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }))

    expect(await screen.findByText('Test email sent to ops@example.com.')).toBeDefined()
    expect(api.emailSettings.smtpHost).toBe('smtp3.example.com')
    expect(api.testEmailsSent).toEqual(['ops@example.com'])
    const paths = api.calls.map((call) => `${call.method} ${call.path}`)
    expect(paths.indexOf('PATCH /api/v1/settings/email')).toBeLessThan(
      paths.indexOf('POST /api/v1/settings/email/test'),
    )
  })

  it('passes the mail server’s complaint through', async () => {
    installFakeApi({ testEmailFailure: '535 authentication failed' })
    renderSettings()
    await loaded()

    fireEvent.change(screen.getByLabelText('Send a test email to'), {
      target: { value: 'ops@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }))

    expect(
      await screen.findByText('The mail server refused the message. 535 authentication failed'),
    ).toBeDefined()
  })

  it('says what is missing when nothing has been configured yet', async () => {
    installFakeApi({ emailSettings: UNCONFIGURED })
    renderSettings()
    await screen.findByLabelText('SMTP host')

    fireEvent.change(screen.getByLabelText('Send a test email to'), {
      target: { value: 'ops@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }))

    expect(
      await screen.findByText('Fill in an SMTP host and a sender address first, then save.'),
    ).toBeDefined()
  })

  it('will not send a test to nowhere', async () => {
    installFakeApi()
    renderSettings()
    await loaded()

    expect(
      (screen.getByRole('button', { name: 'Send test email' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('hands an expired session back to the shell', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ expired: true })
    renderSettings(onSessionExpired)

    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalled()
    })
  })
})
