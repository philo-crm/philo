import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { LeadDetail } from '../src/LeadDetail.tsx'
import { LeadList } from '../src/LeadList.tsx'
import { emitChange, installFakeApi, makeLead, TEST_USER, type FakeApi } from './support/fake-api.ts'

/** Until the screen has its change stream open, an emitted change has nowhere to go. */
async function streaming(api: FakeApi) {
  await waitFor(() => expect(api.changeStreams.length).toBeGreaterThan(0))
}

describe('live updates', () => {
  it('puts a lead somebody else filed on the board, scoped to the funnel shown', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')
    await streaming(api)
    expect(api.changeStreams[0]!.funnelId).toBe(1)

    const arrived = makeLead({ id: 2, name: 'Sam Reyes' })
    api.leads.push(arrived)
    emitChange(api, 'lead.created', 1, { lead: arrived })

    const column = screen.getByRole('region', { name: 'New' })
    await waitFor(() => expect(within(column).getByText('Sam Reyes')).toBeDefined())
  })

  it('moves a card an agent moved', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')
    await streaming(api)

    const lead = api.leads[0]!
    lead.stageId = 3
    lead.stageName = 'Closed'
    emitChange(api, 'lead.stage_changed', 1, { lead, from: { id: 1, name: 'New', funnelId: 1 } })

    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Closed' })).getByText('Dana Okafor')).toBeDefined(),
    )
  })

  it('refreshes the lead list', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')
    await streaming(api)

    api.leads[0]!.name = 'Dana Okafor-Reyes'
    emitChange(api, 'lead.updated', 1, { lead: api.leads[0]! })

    await screen.findByText('Dana Okafor-Reyes')
  })

  it('shows a note an agent added to the open lead, and ignores other leads', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' }), makeLead({ id: 2 })] })
    render(<LeadDetail leadId={1} currentUserId={TEST_USER.id} onSessionExpired={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Dana Okafor' })
    await streaming(api)
    const fetches = () => api.calls.filter((call) => call.path === '/api/v1/leads/1').length
    const before = fetches()

    emitChange(api, 'lead.updated', 1, { lead: api.leads[1]! })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(fetches()).toBe(before)

    api.leads[0]!.events.push({
      id: 99,
      type: 'note_added',
      payload: { note: 'Phone screen went well.' },
      actor: 'apikey:3',
      createdAt: new Date().toISOString(),
    })
    emitChange(api, 'lead.updated', 1, { lead: api.leads[0]! })

    await screen.findByText('Phone screen went well.')
  })

  it('says so when the open lead is deleted elsewhere', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<LeadDetail leadId={1} currentUserId={TEST_USER.id} onSessionExpired={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Dana Okafor' })
    await streaming(api)

    api.leads = []
    emitChange(api, 'lead.deleted', 1, { leadId: 1 })

    expect((await screen.findByRole('alert')).textContent).toContain('just deleted')
  })

  it('closes the stream when the screen goes away', async () => {
    const api = installFakeApi({ leads: [] })
    const { unmount } = render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await streaming(api)

    unmount()

    expect(api.changeStreams).toHaveLength(0)
  })
})
