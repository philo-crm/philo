import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { People } from '../src/People.tsx'
import { installFakeApi, TEST_PEOPLE, TEST_USER, type FakeApi } from './support/fake-api.ts'

/** People — ADR-0012: an admin's screen for who may sign in, and as what. */
function renderPeople(onSessionExpired = vi.fn()) {
  return render(<People currentUserId={TEST_USER.id} onSessionExpired={onSessionExpired} />)
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr')!
}

async function loaded() {
  await screen.findByText('Sam Rivera')
}

function lastLink(api: FakeApi): string {
  const link = api.links.at(-1)
  if (link === undefined) throw new Error('no link was issued')
  return link
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
})

describe('People', () => {
  it('lists everyone with their role and status, and offers no action on yourself', async () => {
    installFakeApi()
    renderPeople()
    await loaded()

    expect(within(row('Sam Rivera')).getByText('Active')).toBeDefined()
    expect(within(row('new@example.com')).getByText('Invited')).toBeDefined()
    expect(within(row('Former Colleague')).getByText('Deactivated')).toBeDefined()

    const own = row('Owner')
    expect(within(own).getByText('You')).toBeDefined()
    expect(within(own).queryAllByRole('button')).toHaveLength(0)
    expect(within(own).queryByRole('combobox')).toBeNull()
    expect(within(own).getByText('Admin')).toBeDefined()
  })

  it('invites someone and shows their link once, with its expiry and a copy button', async () => {
    const api = installFakeApi()
    renderPeople()
    await loaded()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))

    const box = (await screen.findByLabelText('Invite link for pat@example.com')) as HTMLInputElement
    expect(box.value).toBe(lastLink(api))
    expect(screen.getByText(/expires/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined()
    expect(within(row('pat@example.com')).getByText('Invited')).toBeDefined()
    expect(api.people.find((person) => person.email === 'pat@example.com')?.role).toBe('admin')
    // Cleared, so a second click cannot invite twice by accident.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByDisplayValue(lastLink(api))).toBeNull()
    expect(api.links).toHaveLength(1)
  })

  it('copies the link to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const api = installFakeApi()
    renderPeople()
    await loaded()

    fireEvent.click(within(row('Sam Rivera')).getByRole('button', { name: 'Reset link for Sam Rivera' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(lastLink(api)))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
  })

  it('says why an invite was refused', async () => {
    installFakeApi()
    renderPeople()
    await loaded()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/already has an account/)
  })

  it('changes a role', async () => {
    const api = installFakeApi()
    renderPeople()
    await loaded()

    fireEvent.change(within(row('Sam Rivera')).getByRole('combobox', { name: 'Role for Sam Rivera' }), {
      target: { value: 'admin' },
    })

    await waitFor(() => expect(api.people.find((person) => person.id === 8)?.role).toBe('admin'))
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ role: 'admin' })
  })

  it('explains the last-admin refusal and keeps the role on screen as stored', async () => {
    installFakeApi({
      user: { ...TEST_USER, id: 8 },
      people: [
        { id: 7, name: 'Owner', email: 'owner@example.com', role: 'admin', status: 'active' },
        { id: 8, name: 'Sam Rivera', email: 'sam@example.com', role: 'user', status: 'active' },
      ],
    })
    render(<People currentUserId={8} onSessionExpired={vi.fn()} />)
    await loaded()

    const select = within(row('Owner')).getByRole('combobox', { name: 'Role for Owner' }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'user' } })

    expect((await screen.findByRole('alert')).textContent).toMatch(/last admin/)
    expect(select.value).toBe('admin')
  })

  it('deactivates only on a second click, and reactivates', async () => {
    const api = installFakeApi()
    renderPeople()
    await loaded()

    fireEvent.click(within(row('Sam Rivera')).getByRole('button', { name: 'Deactivate Sam Rivera' }))
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false)
    fireEvent.click(within(row('Sam Rivera')).getByRole('button', { name: 'Confirm deactivating Sam Rivera' }))

    await waitFor(() => expect(within(row('Sam Rivera')).getByText('Deactivated')).toBeDefined())
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ disabled: true })

    fireEvent.click(within(row('Former Colleague')).getByRole('button', { name: 'Reactivate Former Colleague' }))
    await waitFor(() => expect(within(row('Former Colleague')).getByText('Active')).toBeDefined())
  })

  it('issues a reset link once, and a fresh invite link for someone still invited', async () => {
    const api = installFakeApi()
    renderPeople()
    await loaded()

    // Neither for someone deactivated: their sign-in is refused anyway.
    expect(within(row('Former Colleague')).queryByRole('button', { name: /link/i })).toBeNull()

    fireEvent.click(within(row('Sam Rivera')).getByRole('button', { name: 'Reset link for Sam Rivera' }))
    const reset = (await screen.findByLabelText('Reset link for sam@example.com')) as HTMLInputElement
    expect(reset.value).toBe(lastLink(api))
    expect(screen.getByText(/signs them out everywhere/)).toBeDefined()

    fireEvent.click(within(row('new@example.com')).getByRole('button', { name: 'New invite link for new@example.com' }))
    const invite = (await screen.findByLabelText('Invite link for new@example.com')) as HTMLInputElement
    expect(invite.value).toBe(lastLink(api))
    // One link on screen at a time: the earlier one is gone.
    expect(screen.queryByLabelText('Reset link for sam@example.com')).toBeNull()
  })

  it('with an external IdP, shows roles read-only and leaves only deactivation', async () => {
    installFakeApi({ builtInIdp: false, rolesManagedByIdp: true })
    renderPeople()
    await loaded()

    expect(screen.getByText(/managed by your identity provider/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /link/i })).toBeNull()
    const sam = row('Sam Rivera')
    expect(within(sam).getByText('User')).toBeDefined()
    expect(within(sam).getByRole('button', { name: 'Deactivate Sam Rivera' })).toBeDefined()
  })

  it('names the IdP-refused status', async () => {
    installFakeApi({
      builtInIdp: false,
      rolesManagedByIdp: true,
      people: [...TEST_PEOPLE, { id: 11, name: 'Lapsed', email: 'lapsed@example.com', role: null, status: 'no_access' }],
    })
    renderPeople()
    await screen.findByText('Lapsed')

    expect(within(row('Lapsed')).getByText('No access')).toBeDefined()
  })

  it('hands a 401 to the shell', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ expired: true })
    renderPeople(onSessionExpired)
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })
})

describe('People in the app', () => {
  it('is a Server settings section an admin reaches from the account menu', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('link', { name: 'People' }))

    expect(await screen.findByText('Sam Rivera')).toBeDefined()
    expect(window.location.pathname).toBe('/settings/people')
    const nav = screen.getByRole('navigation', { name: 'Server settings sections' })
    expect(within(nav).getByRole('link', { name: 'People' }).getAttribute('aria-current')).toBe('page')
  })

  it('is not offered to a user, and a deep link says to ask an admin', async () => {
    installFakeApi({ user: { ...TEST_USER, role: 'user' }, leads: [] })
    window.history.pushState(null, '', '/settings/people')
    render(<App />)

    expect(await screen.findByText(/Only an admin can change this/)).toBeDefined()
    expect(screen.queryByText('Sam Rivera')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(screen.queryByRole('link', { name: 'People' })).toBeNull()
  })
})
