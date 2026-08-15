import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiKeys } from '../src/ApiKeys.tsx'
import { installFakeApi, TEST_API_KEYS, type FakeApi } from './support/fake-api.ts'

function renderKeys(onSessionExpired = vi.fn()) {
  return render(<ApiKeys onSessionExpired={onSessionExpired} />)
}

/** Resolves once the loaded list is on screen rather than the spinner. */
async function loaded() {
  return screen.findByText('Nightly export')
}

function create(name: string) {
  fireEvent.change(screen.getByLabelText('What is this key for?'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
}

/** The secret the fake handed out for the most recent create. */
function lastSecret(api: FakeApi): string {
  const secret = api.apiKeySecrets.at(-1)
  if (secret === undefined) throw new Error('no key was created')
  return secret
}

describe('ApiKeys', () => {
  it('lists the keys with their prefix and last use, and no secret', async () => {
    installFakeApi()
    renderKeys()
    await loaded()

    expect(screen.getByText('philo_export…')).toBeDefined()
    expect(screen.getByText('Claude Code')).toBeDefined()
    // A key that has never been used says so rather than showing a blank cell.
    expect(screen.getByText('Never')).toBeDefined()
  })

  it('says so when there are none yet', async () => {
    installFakeApi({ apiKeys: [] })
    renderKeys()

    expect(await screen.findByText('No API keys yet.')).toBeDefined()
  })

  it('shows the new key once, and adds it to the list', async () => {
    const api = installFakeApi()
    renderKeys()
    await loaded()

    create('Cron job')

    const secret = await waitFor(() => lastSecret(api))
    expect((await screen.findByLabelText('New API key')).getAttribute('value')).toBe(secret)
    expect(screen.getByText('Cron job')).toBeDefined()
    expect(api.apiKeys.map((key) => key.name)).toContain('Cron job')
    // The box is cleared, so a second click cannot mint a duplicate by accident.
    expect((screen.getByLabelText('What is this key for?') as HTMLInputElement).value).toBe('')
  })

  it('drops the secret from the page when it is dismissed', async () => {
    const api = installFakeApi()
    renderKeys()
    await loaded()

    create('Cron job')
    await screen.findByLabelText('New API key')
    const secret = lastSecret(api)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(screen.queryByLabelText('New API key')).toBeNull()
    })
    expect(document.body.innerHTML).not.toContain(secret)
  })

  it('will not create a key with no name', async () => {
    installFakeApi()
    renderKeys()
    await loaded()

    expect((screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    fireEvent.change(screen.getByLabelText('What is this key for?'), { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('takes two clicks to revoke', async () => {
    const api = installFakeApi()
    renderKeys()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Nightly export' }))
    expect(api.apiKeys).toHaveLength(TEST_API_KEYS.length)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking Nightly export' }))

    await waitFor(() => {
      expect(screen.queryByText('Nightly export')).toBeNull()
    })
    expect(api.apiKeys.map((key) => key.name)).toEqual(['Claude Code'])
  })

  it('takes a freshly shown secret off screen when its key is revoked', async () => {
    const api = installFakeApi()
    renderKeys()
    await loaded()

    create('Cron job')
    await screen.findByLabelText('New API key')
    const secret = lastSecret(api)

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Cron job' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking Cron job' }))

    await waitFor(() => {
      expect(screen.queryByText('Cron job')).toBeNull()
    })
    expect(document.body.innerHTML).not.toContain(secret)
  })

  it('reports a key somebody else already revoked', async () => {
    const api = installFakeApi()
    renderKeys()
    await loaded()

    // Gone from the server while this screen still lists it.
    api.apiKeys = api.apiKeys.filter((key) => key.name !== 'Nightly export')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Nightly export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking Nightly export' }))

    expect(
      await screen.findByText('That key has already been revoked. Reload to see the current list.'),
    ).toBeDefined()
  })

  it('hands an expired session back to the shell', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ expired: true })
    renderKeys(onSessionExpired)

    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalled()
    })
  })
})
