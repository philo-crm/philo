import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Webhooks } from '../src/Webhooks.tsx'
import { installFakeApi, TEST_FUNNELS } from './support/fake-api.ts'

function form() {
  return screen.getByRole('form', { name: 'Add a webhook' })
}

describe('Webhooks', () => {
  it('adds one for a funnel and chosen changes, showing the secret once', async () => {
    const api = installFakeApi()
    render(<Webhooks onSessionExpired={vi.fn()} />)
    await screen.findByText('No webhooks yet.')
    await within(form()).findByRole('option', { name: TEST_FUNNELS[0]!.name })

    fireEvent.change(within(form()).getByLabelText('Post to'), { target: { value: 'https://hooks.example.com/philo' } })
    fireEvent.change(within(form()).getByLabelText('For'), { target: { value: String(TEST_FUNNELS[0]!.id) } })
    fireEvent.click(within(form()).getByLabelText('A lead moves stage'))
    fireEvent.click(within(form()).getByRole('button', { name: 'Add webhook' }))

    expect(((await screen.findByLabelText('Signing secret')) as HTMLInputElement).value).toMatch(/^whsec_/)
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/webhooks')
    expect(created?.body).toEqual({
      url: 'https://hooks.example.com/philo',
      funnelId: TEST_FUNNELS[0]!.id,
      events: ['lead.stage_changed'],
    })
    const row = (await screen.findAllByText('https://hooks.example.com/philo')).at(-1)!.closest('tr')!
    expect(within(row).getByText(TEST_FUNNELS[0]!.name)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Signing secret')).toBeNull()
  })

  it('defaults to every funnel and every change', async () => {
    const api = installFakeApi()
    render(<Webhooks onSessionExpired={vi.fn()} />)
    await screen.findByText('No webhooks yet.')

    fireEvent.change(within(form()).getByLabelText('Post to'), { target: { value: 'https://hooks.example.com/' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Add webhook' }))

    await screen.findByLabelText('Signing secret')
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/webhooks')
    expect(created?.body).toEqual({ url: 'https://hooks.example.com/', funnelId: null, events: [] })
    expect(await screen.findByText('Every change')).toBeDefined()
  })

  it('explains a refused address', async () => {
    installFakeApi()
    render(<Webhooks onSessionExpired={vi.fn()} />)
    await screen.findByText('No webhooks yet.')

    fireEvent.change(within(form()).getByLabelText('Post to'), { target: { value: 'ftp://files.example.com/' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Add webhook' }))

    expect((await screen.findByRole('alert')).textContent).toContain('http:// or https://')
  })

  it('tests and deletes one', async () => {
    const api = installFakeApi({
      webhooks: [
        {
          id: 5,
          url: 'https://hooks.example.com/a',
          funnelId: null,
          events: [],
          actor: 'user:7',
          createdAt: '2026-07-01T12:00:00.000Z',
          lastDelivery: null,
        },
      ],
      webhookTestResult: { at: '2026-07-01T12:00:00.000Z', status: 500, ok: false, error: 'HTTP 500' },
    })
    render(<Webhooks onSessionExpired={vi.fn()} />)
    expect(await screen.findByText('Not yet')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test to https://hooks.example.com/a' }))
    expect(await screen.findByText(/HTTP 500/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Delete https://hooks.example.com/a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting https://hooks.example.com/a' }))
    await waitFor(() => expect(api.webhooks).toHaveLength(0))
    expect(await screen.findByText('No webhooks yet.')).toBeDefined()
  })
})
