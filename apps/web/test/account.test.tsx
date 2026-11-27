import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Account } from '../src/Account.tsx'
import { App } from '../src/App.tsx'
import { installFakeApi, TEST_PASSWORD, TEST_USER } from './support/fake-api.ts'

/** Your own account — ADR-0012. */
function renderAccount(onChanged = vi.fn(), onSessionExpired = vi.fn()) {
  render(<Account onAccountChanged={onChanged} onSessionExpired={onSessionExpired} />)
  return onChanged
}

async function loaded() {
  await screen.findByDisplayValue(TEST_USER.email)
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
})

describe('Account', () => {
  it('shows your name, email and role', async () => {
    installFakeApi()
    renderAccount()
    await loaded()

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Owner')
    expect(screen.getByText(/You are an admin/)).toBeDefined()
  })

  it('says what a user can do', async () => {
    installFakeApi({ user: { ...TEST_USER, role: 'user' } })
    renderAccount()
    await loaded()

    expect(screen.getByText(/You are a user/)).toBeDefined()
  })

  it('changes your name without asking for the password', async () => {
    const api = installFakeApi()
    const onChanged = renderAccount()
    await loaded()

    type('Name', 'Dana Owner')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeDefined()
    expect(api.user?.name).toBe('Dana Owner')
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ name: 'Dana Owner' })
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ name: 'Dana Owner', email: TEST_USER.email }))
  })

  it('asks for the current password before changing your email, and says when it is wrong', async () => {
    const api = installFakeApi()
    renderAccount()
    await loaded()

    type('Email', 'owner2@example.com')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    type('Password', 'not it at all')
    fireEvent.click(save)
    expect((await screen.findByRole('alert')).textContent).toMatch(/current password is not right/)
    expect(api.user?.email).toBe(TEST_USER.email)

    type('Password', TEST_PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeDefined()
    expect(api.user?.email).toBe('owner2@example.com')
    // Spent: it is not left sitting in the box.
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('changes your password', async () => {
    const api = installFakeApi()
    renderAccount()
    await loaded()

    const form = screen.getByRole('form', { name: 'Change password' })
    fireEvent.change(form.querySelector('input[name="current-password"]')!, { target: { value: TEST_PASSWORD } })
    type('New password', 'a much longer passphrase')
    type('New password again', 'a much longer passphrase')
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText(/Password changed/)).toBeDefined()
    expect(api.password).toBe('a much longer passphrase')
  })

  it('refuses a new password that does not match its repeat, without asking the server', async () => {
    const api = installFakeApi()
    renderAccount()
    await loaded()

    const form = screen.getByRole('form', { name: 'Change password' })
    fireEvent.change(form.querySelector('input[name="current-password"]')!, { target: { value: TEST_PASSWORD } })
    type('New password', 'a much longer passphrase')
    type('New password again', 'a much longer passphrasf')
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/)
    expect(api.calls.some((call) => call.path === '/api/v1/account/password')).toBe(false)
  })

  it('with an external IdP, leaves email and password to it', async () => {
    installFakeApi({ builtInIdp: false })
    renderAccount()
    await loaded()

    expect((screen.getByLabelText('Email') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('form', { name: 'Change password' })).toBeNull()
    expect(screen.getByText(/identity provider/)).toBeDefined()
  })
})

describe('Account in the app', () => {
  it('opens from the account menu, and a new name reaches the menu', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('link', { name: 'Your account' }))
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeDefined()
    expect(window.location.pathname).toBe('/account')

    await loaded()
    type('Name', 'Dana Owner')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.')

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    await waitFor(() => expect(document.querySelector('.menu-identity-name')?.textContent).toBe('Dana Owner'))
  })
})
