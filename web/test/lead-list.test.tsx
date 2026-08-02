import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LeadList } from '../src/LeadList.tsx'
import { installFakeApi, makeLead } from './support/fake-api.ts'

function leads() {
  return [
    makeLead({ id: 1, name: 'Dana Okafor', phone: '555-0100', fields: { endorsements: 'hazmat' } }),
    makeLead({ id: 2, name: 'Sam Reyes', stageId: 2, stageName: 'Contacted' }),
  ]
}

describe('LeadList', () => {
  it('lists leads with their contact details and stage', async () => {
    installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)

    expect(await screen.findByText('Dana Okafor')).toBeDefined()
    expect(screen.getByText('lead1@example.com · 555-0100')).toBeDefined()
    // Scoped to the table: the stage filter lists every stage name too.
    expect(within(screen.getByRole('table')).getByText('Contacted')).toBeDefined()
    expect(screen.getByText('2 leads')).toBeDefined()
  })

  it('searches the API rather than filtering what it already has', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Sam Reyes')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hazmat' } })

    await waitForElementToBeRemoved(() => screen.queryByText('Sam Reyes'))
    expect(screen.getByText('Dana Okafor')).toBeDefined()
    const searched = api.calls.filter((call) => call.query.get('search') === 'hazmat')
    expect(searched.length).toBeGreaterThan(0)
    expect(searched[0]?.query.get('spam')).toBe('false')
  })

  it('filters by stage', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '2' } })

    await waitForElementToBeRemoved(() => screen.queryByText('Dana Okafor'))
    expect(screen.getByText('Sam Reyes')).toBeDefined()
    expect(api.calls.some((call) => call.query.get('stage') === '2')).toBe(true)
  })

  it('promotes a quarantined lead out of the spam view', async () => {
    const api = installFakeApi({
      leads: [makeLead({ id: 3, name: 'Bot Submission', isSpam: true })],
    })
    render(<LeadList isSpam onSessionExpired={vi.fn()} />)
    await screen.findByText('Bot Submission')

    fireEvent.click(screen.getByRole('button', { name: 'Not spam' }))

    await waitForElementToBeRemoved(() => screen.queryByText('Bot Submission'))
    expect(api.leads[0]?.isSpam).toBe(false)
    expect(screen.getByText('Nothing is quarantined.')).toBeDefined()
  })

  it('hands back to the login screen when the session has expired', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ leads: leads(), expired: true })
    render(<LeadList isSpam={false} onSessionExpired={onSessionExpired} />)

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })
})
