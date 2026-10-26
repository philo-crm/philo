import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmailTemplates } from '../src/EmailTemplates.tsx'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { FunnelSettings } from '../src/FunnelSettings.tsx'
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

describe('the funnel board', () => {
  it('shows no funnel picker on an instance with one funnel', async () => {
    installFakeApi()
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByRole('region', { name: 'New' })
    expect(screen.queryByRole('combobox', { name: 'Funnel' })).toBeNull()
  })

  it('switches to another funnel’s stages and adds stages there', async () => {
    const api = twoFunnels()
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByRole('region', { name: 'New' })

    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: '2' } })
    await screen.findByRole('region', { name: 'Lease review' })
    expect(screen.queryByRole('region', { name: 'New' })).toBeNull()

    fireEvent.change(screen.getByLabelText('New stage'), { target: { value: 'Inspection' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }))
    await screen.findByRole('region', { name: 'Inspection' })
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/stages')
    expect(created?.query.get('funnel')).toBe('2')
  })

  it('remembers the funnel it was last showing', async () => {
    twoFunnels()
    const first = render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByRole('region', { name: 'New' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: '2' } })
    await screen.findByRole('region', { name: 'Lease review' })
    first.unmount()

    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    expect(await screen.findByRole('region', { name: 'Lease review' })).toBeDefined()
  })
})

describe('funnel settings', () => {
  it('creates a funnel and shows its intake URL', async () => {
    const api = installFakeApi()
    render(<FunnelSettings onSessionExpired={vi.fn()} />)
    await screen.findByRole('form', { name: 'Default funnel' })

    fireEvent.change(screen.getByLabelText('New funnel'), { target: { value: 'Sales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add funnel' }))

    const sales = await screen.findByRole('form', { name: 'Sales funnel' })
    expect(within(sales).getByText('http://localhost:3000/api/intake/form-2')).toBeDefined()
    expect(api.funnels.map((funnel) => funnel.name)).toEqual(['Default', 'Sales'])
  })

  it('saves the funnel-scoped overrides', async () => {
    const api = twoFunnels()
    render(<FunnelSettings onSessionExpired={vi.fn()} />)
    const form = await screen.findByRole('form', { name: 'Owner-operators funnel' })

    fireEvent.change(within(form).getByLabelText('From name for this funnel'), { target: { value: 'Owner Team' } })
    fireEvent.change(within(form).getByLabelText('Reply-to for this funnel'), { target: { value: 'owners@example.com' } })
    fireEvent.change(within(form).getByLabelText('Notify about new leads'), {
      target: { value: 'a@example.com\nb@example.com' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save funnel' }))

    await within(form).findByText('Funnel saved.')
    expect(api.funnels[1]).toMatchObject({
      fromName: 'Owner Team',
      replyTo: 'owners@example.com',
      notifyRecipients: ['a@example.com', 'b@example.com'],
    })
  })

  it('offers delete only for an empty funnel that is not the last', async () => {
    twoFunnels({ leads: [makeLead({ id: 1 })] })
    render(<FunnelSettings onSessionExpired={vi.fn()} />)
    const defaultForm = await screen.findByRole('form', { name: 'Default funnel' })
    const second = screen.getByRole('form', { name: 'Owner-operators funnel' })
    expect(within(defaultForm).queryByRole('button', { name: 'Delete funnel' })).toBeNull()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(within(second).getByRole('button', { name: 'Delete funnel' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Owner-operators funnel' })).toBeNull())
  })
})

describe('funnel-scoped templates', () => {
  it('edits the selected funnel’s templates', async () => {
    const api = twoFunnels()
    render(<EmailTemplates onSessionExpired={vi.fn()} />)
    await screen.findByRole('form', { name: 'Applicant acknowledgment' })

    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: '2' } })
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === '/api/v1/settings/email/templates' && call.query.get('funnel') === '2')).toBe(true),
    )
    const ack = await screen.findByRole('form', { name: 'Applicant acknowledgment' })
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
    await screen.findByText('Sam Reyes')
    expect(screen.getByText('Owner-operators · Lease review')).toBeDefined()
    // Stage names repeat across funnels, so there is no stage filter until one is chosen.
    expect(screen.queryByRole('combobox', { name: 'Stage' })).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: 'Funnel' }), { target: { value: '2' } })
    await waitFor(() => expect(screen.queryByText('Dana Okafor')).toBeNull())
    expect(api.calls.some((call) => call.path === '/api/v1/leads' && call.query.get('funnel') === '2')).toBe(true)
    const stage = await screen.findByRole('combobox', { name: 'Stage' })
    expect(within(stage).getByRole('option', { name: 'Lease review' })).toBeDefined()
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
