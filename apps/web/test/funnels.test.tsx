import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { selectFunnel } from '../src/FunnelPicker.tsx'
import { FunnelList, FunnelSettings } from '../src/FunnelSettings.tsx'
import { FunnelSwitcher } from '../src/FunnelSwitcher.tsx'
import { LeadDetail } from '../src/LeadDetail.tsx'
import { LeadList } from '../src/LeadList.tsx'
import {
  installFakeApi,
  makeLead,
  TEST_FUNNELS,
  TEST_STAGES,
  TEST_USER,
  type FakeApi,
} from './support/fake-api.ts'

// The selection is the whole app's and outlives a render, so each test starts on the default.
beforeEach(() => {
  selectFunnel(1)
})

/** The default funnel plus a second one with stages of its own — ADR-0009. */
function twoFunnels(overrides: Partial<FakeApi> = {}): FakeApi {
  return installFakeApi({
    funnels: [
      ...TEST_FUNNELS,
      {
        ...TEST_FUNNELS[0]!,
        id: 2,
        name: 'Owner-operators',
        isDefault: false,
        forms: [{ id: 2, name: 'Owner-operators', formKey: 'form-2', intakeUrl: 'http://localhost:3000/api/intake/form-2' }],
      },
    ],
    stages: [
      ...TEST_STAGES,
      { id: 10, name: 'Lease review', position: 0, isTerminal: false, leadCount: 0, funnelId: 2 },
      { id: 11, name: 'Signed', position: 1, isTerminal: true, leadCount: 0, funnelId: 2 },
    ],
    ...overrides,
  })
}

/** Picks a funnel from the top bar's switcher. */
function switchTo(name: string, from: string) {
  fireEvent.click(screen.getByRole('button', { name: `Funnel: ${from}` }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
}

describe('the funnel switcher', () => {
  it('names the selected funnel and lists them all with their lead counts', async () => {
    twoFunnels({ leads: [makeLead({ id: 1 })] })
    render(<FunnelSwitcher />)

    fireEvent.click(await screen.findByRole('button', { name: 'Funnel: Default' }))
    const current = screen.getByRole('button', { name: /^Default/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.textContent).toContain('1')
    expect(screen.getByRole('link', { name: 'Add or remove funnels' }).getAttribute('href')).toBe('/settings/funnels')
  })

  it('still opens, with a retry, when the funnels fail to load', async () => {
    const api = installFakeApi()
    api.offline = /^\/api\/v1\/funnels$/
    render(<FunnelSwitcher />)

    const trigger = await screen.findByRole('button', { name: 'Funnel' })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    expect(screen.getByRole('link', { name: 'Funnel settings' })).toBeDefined()

    api.offline = undefined
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByRole('button', { name: /^Default/ })).toBeDefined()
  })

  it('switches the board to another funnel’s stages, where stages are added', async () => {
    const api = twoFunnels()
    render(
      <>
        <FunnelSwitcher />
        <FunnelBoard onSessionExpired={vi.fn()} />
      </>,
    )
    await screen.findByRole('region', { name: 'New' })

    switchTo('Owner-operators', 'Default')
    await screen.findByRole('region', { name: 'Lease review' })
    expect(screen.queryByRole('region', { name: 'New' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Owner-operators' })).toBeDefined()
    // The menu shuts on a choice.
    expect(screen.queryByRole('link', { name: 'Add or remove funnels' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New stage' }))
    fireEvent.change(screen.getByLabelText('New stage'), { target: { value: 'Inspection' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }))
    await screen.findByRole('region', { name: 'Inspection' })
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/stages')
    expect(created?.query.get('funnel')).toBe('2')
  })

  it('remembers the funnel it was last showing', async () => {
    twoFunnels()
    const first = render(<FunnelSwitcher />)
    await screen.findByRole('button', { name: 'Funnel: Default' })
    switchTo('Owner-operators', 'Default')
    first.unmount()

    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    expect(await screen.findByRole('region', { name: 'Lease review' })).toBeDefined()
    expect(window.localStorage.getItem('philo.funnel')).toBe('2')
  })
})

describe('funnel settings', () => {
  it('adds a funnel from the server’s list of them', async () => {
    const api = installFakeApi()
    render(<FunnelList onSessionExpired={vi.fn()} />)
    const list = await screen.findByRole('list', { name: 'Funnels' })
    expect(within(list).getByRole('button', { name: 'Open Default settings' })).toBeDefined()

    fireEvent.change(screen.getByLabelText('New funnel'), { target: { value: 'Sales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add funnel' }))

    expect(await screen.findByText('Sales added.')).toBeDefined()
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Open Sales settings' })).toBeDefined())
    expect(api.funnels.map((funnel) => funnel.name)).toEqual(['Default', 'Sales'])
  })

  it('opens a funnel’s settings from the list, selecting it', async () => {
    twoFunnels()
    render(<FunnelList onSessionExpired={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Owner-operators settings' }))

    expect(window.location.pathname).toBe('/funnel')
    expect(window.localStorage.getItem('philo.funnel')).toBe('2')
    window.history.pushState(null, '', '/')
  })

  it('edits only the selected funnel', async () => {
    twoFunnels()
    selectFunnel(2)
    render(<FunnelSettings onSessionExpired={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Owner-operators funnel' })).toBeDefined()
    expect(screen.queryByRole('form', { name: 'Default funnel' })).toBeNull()
  })

  it('saves the funnel-scoped overrides', async () => {
    const api = twoFunnels()
    selectFunnel(2)
    render(<FunnelSettings onSessionExpired={vi.fn()} />)
    const form = await screen.findByRole('form', { name: 'Owner-operators funnel' })

    fireEvent.change(within(form).getByLabelText('From name for this funnel'), { target: { value: 'Owner Team' } })
    fireEvent.change(within(form).getByLabelText('Reply-to for this funnel'), { target: { value: 'owners@example.com' } })
    fireEvent.change(within(form).getByLabelText('Notify about new leads'), {
      target: { value: 'a@example.com\nb@example.com' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save funnel' }))

    await screen.findByText('Funnel saved.')
    expect(api.funnels[1]).toMatchObject({
      fromName: 'Owner Team',
      replyTo: 'owners@example.com',
      notifyRecipients: ['a@example.com', 'b@example.com'],
    })
  })

  it('offers delete only for an empty funnel that is not the last', async () => {
    const api = twoFunnels({ leads: [makeLead({ id: 1 })] })
    const view = render(<FunnelSettings onSessionExpired={vi.fn()} />)
    await screen.findByRole('form', { name: 'Default funnel' })
    expect(screen.queryByRole('button', { name: 'Delete funnel' })).toBeNull()
    expect(screen.getByText('Only an empty funnel can be deleted. Move or delete its leads first.')).toBeDefined()
    view.unmount()

    selectFunnel(2)
    render(<FunnelSettings onSessionExpired={vi.fn()} />)
    await screen.findByRole('form', { name: 'Owner-operators funnel' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete funnel' }))

    await waitFor(() => expect(api.funnels.map((funnel) => funnel.name)).toEqual(['Default']))
    // A deleted selection falls back to the default funnel.
    expect(await screen.findByRole('form', { name: 'Default funnel' })).toBeDefined()
  })
})

describe('funnel-scoped templates', () => {
  it('edits the selected funnel’s templates', async () => {
    const api = twoFunnels()
    selectFunnel(2)
    render(<FunnelSettings section="emails" onSessionExpired={vi.fn()} />)

    const ack = await screen.findByRole('form', { name: 'Applicant acknowledgment' })
    expect(
      api.calls.some((call) => call.path === '/api/v1/settings/email/templates' && call.query.get('funnel') === '2'),
    ).toBe(true)
    fireEvent.change(within(ack).getByLabelText('Subject'), { target: { value: 'Welcome, owner' } })
    fireEvent.click(within(ack).getByRole('button', { name: 'Save template' }))

    await within(ack).findByText('Template saved.')
    expect(api.funnelTemplates[2]?.find((t) => t.trigger === 'new_lead_ack')?.subject).toBe('Welcome, owner')
    expect(api.emailTemplates.find((t) => t.trigger === 'new_lead_ack')?.subject).toBe('Thanks for getting in touch')
  })
})

describe('funnel-scoped leads', () => {
  it('filters the list by funnel', async () => {
    const api = twoFunnels({
      leads: [
        makeLead({ id: 1, name: 'Dana Okafor' }),
        makeLead({ id: 2, name: 'Sam Reyes', funnelId: 2, stageId: 10, stageName: 'Lease review' }),
      ],
    })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    // The selected funnel's leads, like the board.
    await screen.findByText('Dana Okafor')
    expect(screen.queryByText('Sam Reyes')).toBeNull()
    // The list never asked for every funnel before it knew which was selected.
    expect(api.calls.filter((call) => call.path === '/api/v1/leads').every((call) => call.query.get('funnel') === '1')).toBe(true)

    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: 'all' } })
    await screen.findByText('Sam Reyes')
    expect(screen.getByText('Owner-operators · Lease review')).toBeDefined()
    // Stage names repeat across funnels, so there is no stage filter across them.
    expect(screen.queryByRole('combobox', { name: 'Stage' })).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: '2' } })
    await waitFor(() => expect(screen.queryByText('Dana Okafor')).toBeNull())
    expect(api.calls.some((call) => call.path === '/api/v1/leads' && call.query.get('funnel') === '2')).toBe(true)
    const stage = await screen.findByRole('combobox', { name: 'Stage' })
    expect(within(stage).getByRole('option', { name: 'Lease review' })).toBeDefined()
    // Choosing a funnel here is choosing it everywhere.
    expect(window.localStorage.getItem('philo.funnel')).toBe('2')
  })

  it('leaves "All funnels" when the top bar switches funnel', async () => {
    twoFunnels({
      leads: [
        makeLead({ id: 1, name: 'Dana Okafor' }),
        makeLead({ id: 2, name: 'Sam Reyes', funnelId: 2, stageId: 10, stageName: 'Lease review' }),
      ],
    })
    render(
      <>
        <FunnelSwitcher />
        <LeadList isSpam={false} onSessionExpired={vi.fn()} />
      </>,
    )
    await screen.findByText('Dana Okafor')
    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: 'all' } })
    await screen.findByText('Sam Reyes')

    switchTo('Owner-operators', 'Default')

    await waitFor(() => expect(screen.queryByText('Dana Okafor')).toBeNull())
    expect(screen.getByText('Sam Reyes')).toBeDefined()
    expect((screen.getByRole('combobox', { name: 'Funnel' }) as HTMLSelectElement).value).toBe('2')
  })

  it('moves a lead into another funnel at its first stage', async () => {
    const api = twoFunnels({ leads: [makeLead({ id: 5, name: 'Dana Okafor' })] })
    render(<LeadDetail leadId={5} currentUserId={TEST_USER.id} onSessionExpired={vi.fn()} />)
    const funnel = await screen.findByRole('combobox', { name: 'Funnel' })

    fireEvent.change(funnel, { target: { value: '2' } })
    await waitFor(() => expect(api.leads[0]).toMatchObject({ funnelId: 2, stageId: 10 }))
    const stage = await screen.findByRole('combobox', { name: 'Stage' })
    await waitFor(() => expect(within(stage).getByRole('option', { name: 'Signed' })).toBeDefined())
  })
})
