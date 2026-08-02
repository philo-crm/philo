import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { installFakeApi, makeLead, type FakeApi } from './support/fake-api.ts'

/** New holds two, Contacted and Closed are empty — see TEST_STAGES. */
function leads() {
  return [
    makeLead({ id: 1, name: 'Dana Okafor' }),
    makeLead({ id: 2, name: 'Sam Reyes' }),
  ]
}

function column(name: string) {
  return screen.getByRole('region', { name })
}

/** The stage a lead sits in, read back off the fake's own state. */
function stageOf(api: FakeApi, id: number): string | undefined {
  return api.leads.find((lead) => lead.id === id)?.stageName
}

/** jsdom builds no DataTransfer, and dragstart writes to one. */
function dragStart(card: HTMLElement) {
  fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } })
}

describe('FunnelBoard', () => {
  it('shows a column per stage with its cards and its non-spam count', async () => {
    installFakeApi({
      leads: [...leads(), makeLead({ id: 3, name: 'Bot Submission', isSpam: true })],
    })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)

    const newStage = await screen.findByRole('region', { name: 'New' })
    expect(within(newStage).getByText('Dana Okafor')).toBeDefined()
    expect(within(newStage).getByText('Sam Reyes')).toBeDefined()
    // Three leads sit in New; the quarantined one is not on the board, so it is
    // not in the number either.
    expect(within(newStage).getByText('2')).toBeDefined()
    expect(within(newStage).queryByText('Bot Submission')).toBeNull()
    expect(within(column('Contacted')).getByText('No leads here.')).toBeDefined()
  })

  it('marks the terminal stage', async () => {
    installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)

    const closed = await screen.findByRole('region', { name: 'Closed' })
    expect(within(closed).getByText('Terminal')).toBeDefined()
    expect(within(column('New')).queryByText('Terminal')).toBeNull()
  })

  it('moves a card to another stage from the card itself', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.change(screen.getByRole('combobox', { name: 'Move Dana Okafor to another stage' }), {
      target: { value: '2' },
    })

    await waitFor(() => expect(within(column('Contacted')).getByText('Dana Okafor')).toBeDefined())
    expect(stageOf(api, 1)).toBe('Contacted')
    expect(api.calls.some((call) => call.path === '/api/v1/leads/1/stage')).toBe(true)
  })

  it('records the move on the lead timeline', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Sam Reyes')

    fireEvent.change(screen.getByRole('combobox', { name: 'Move Sam Reyes to another stage' }), {
      target: { value: '3' },
    })

    await waitFor(() => expect(stageOf(api, 2)).toBe('Closed'))
    const moved = api.leads[1]?.events.at(-1)
    expect(moved?.type).toBe('stage_changed')
    expect(moved?.payload['to']).toEqual({ id: 3, name: 'Closed' })
  })

  it('moves a card dropped on another column', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    const card = (await screen.findByText('Dana Okafor')).closest('li')
    expect(card).not.toBeNull()

    dragStart(card as HTMLElement)
    fireEvent.dragOver(column('Closed'))
    fireEvent.drop(column('Closed'))

    await waitFor(() => expect(within(column('Closed')).getByText('Dana Okafor')).toBeDefined())
    expect(stageOf(api, 1)).toBe('Closed')
  })

  it('ignores a card dropped back on the column it came from', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    const card = (await screen.findByText('Dana Okafor')).closest('li')

    dragStart(card as HTMLElement)
    fireEvent.drop(column('New'))

    // The request would have gone out on the drop, so there is nothing to wait
    // for — either it is in `calls` by now or it was never made.
    expect(api.calls.some((call) => call.path.endsWith('/stage'))).toBe(false)
    expect(stageOf(api, 1)).toBe('New')
  })

  it('adds a stage to the end of the funnel', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.change(screen.getByPlaceholderText('Stage name'), { target: { value: 'Screening' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }))

    expect(await screen.findByRole('region', { name: 'Screening' })).toBeDefined()
    expect(api.stages.at(-1)?.name).toBe('Screening')
    // Cleared on success, so the next stage does not start from the last name.
    expect((screen.getByPlaceholderText('Stage name') as HTMLInputElement).value).toBe('')
  })

  it('renames a stage, and the leads in it follow', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.click(within(column('New')).getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Stage name'), { target: { value: 'Applied' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('region', { name: 'Applied' })).toBeDefined()
    expect(api.stages[0]?.name).toBe('Applied')
    expect(stageOf(api, 1)).toBe('Applied')
  })

  it('marks a stage terminal from the rename form', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    const contacted = column('Contacted')
    fireEvent.click(within(contacted).getByRole('button', { name: 'Rename' }))
    // Scoped: the add-stage form carries a checkbox by the same name.
    fireEvent.click(within(contacted).getByLabelText('Terminal stage'))
    fireEvent.click(within(contacted).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(within(column('Contacted')).getByText('Terminal')).toBeDefined())
    expect(api.stages[1]?.isTerminal).toBe(true)
  })

  it('reorders the board and persists the whole new order', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.click(screen.getByRole('button', { name: 'Move Contacted earlier' }))

    await waitFor(() => {
      const labels = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
      expect(labels).toEqual(['Contacted', 'New', 'Closed', 'Add a stage'])
    })
    const reorder = api.calls.find((call) => call.path === '/api/v1/stages/reorder')
    // The complete funnel, not just the pair that swapped — a partial order
    // leaves two stages claiming the same position.
    expect(reorder?.body).toEqual({ stageIds: [2, 1, 3] })
  })

  it('cannot move the first stage earlier or the last one later', async () => {
    installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    expect(screen.getByRole('button', { name: 'Move New earlier' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Move Closed later' }).hasAttribute('disabled')).toBe(true)
  })

  it('deletes an empty stage and refuses a stage holding leads', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    // New holds two leads, so its delete is not offered at all.
    expect(screen.getByRole('button', { name: 'Delete New' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Contacted' }))

    await waitForElementToBeRemoved(() => screen.queryByRole('region', { name: 'Contacted' }))
    expect(api.stages.map((stage) => stage.name)).toEqual(['New', 'Closed'])
  })

  it('keeps delete off a stage whose only leads are quarantined', async () => {
    installFakeApi({
      leads: [makeLead({ id: 4, stageId: 2, stageName: 'Contacted', isSpam: true })],
    })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)

    const contacted = await screen.findByRole('region', { name: 'Contacted' })
    // The board shows none of them, so the column counts zero — but the stage
    // is not empty and the server would refuse the delete.
    expect(within(contacted).getByText('0')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Delete Contacted' }).hasAttribute('disabled')).toBe(true)
  })

  it('explains a rejected stage edit in the funnel’s own words', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    // The stage is gone by the time the rename lands — the message has to be
    // about a stage, not about the lead code of the same name.
    api.stages = api.stages.filter((stage) => stage.id !== 2)
    fireEvent.click(within(column('Contacted')).getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Stage name'), { target: { value: 'Reached' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That stage no longer exists. Reload and try again.',
    )
  })

  it('says how many cards a column is not showing', async () => {
    const many = Array.from({ length: 30 }, (_, index) => makeLead({ id: index + 1 }))
    installFakeApi({ leads: many })
    render(<FunnelBoard onSessionExpired={vi.fn()} />)

    expect(await screen.findByText('Showing 25 of 30')).toBeDefined()
  })

  it('hands back to the login screen when the session has expired', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ leads: leads(), expired: true })
    render(<FunnelBoard onSessionExpired={onSessionExpired} />)

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })
})
