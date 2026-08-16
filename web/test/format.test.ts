import { describe, expect, it } from 'vitest'
import type { LeadEventRecord } from '../src/api.ts'
import { actorLabel, describeEvent, formatFieldValue, humanizeKey, leadTitle } from '../src/format.ts'

function event(overrides: Partial<LeadEventRecord>): LeadEventRecord {
  return {
    id: 1,
    type: 'created',
    payload: {},
    actor: 'form:key',
    createdAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  }
}

describe('humanizeKey', () => {
  it('reads snake, kebab and camel keys the same way', () => {
    expect(humanizeKey('years_experience')).toBe('Years experience')
    expect(humanizeKey('years-experience')).toBe('Years experience')
    expect(humanizeKey('yearsExperience')).toBe('Years experience')
  })

  it('leaves acronyms alone, which a recruiting funnel is full of', () => {
    expect(humanizeKey('CDL_class')).toBe('CDL class')
    expect(humanizeKey('has_TWIC_card')).toBe('Has TWIC card')
  })

  it('falls back to the raw key when there is nothing to humanize', () => {
    expect(humanizeKey('___')).toBe('___')
  })
})

describe('formatFieldValue', () => {
  it('renders every JSON shape an intake form can submit', () => {
    expect(formatFieldValue('Class A')).toBe('Class A')
    expect(formatFieldValue(12)).toBe('12')
    expect(formatFieldValue(true)).toBe('Yes')
    expect(formatFieldValue(false)).toBe('No')
    expect(formatFieldValue(['tanker', 'hazmat'])).toBe('tanker, hazmat')
    expect(formatFieldValue({ city: 'Springfield' })).toBe('{"city":"Springfield"}')
  })

  it('shows a dash rather than a blank cell for nothing', () => {
    expect(formatFieldValue(null)).toBe('—')
    expect(formatFieldValue(undefined)).toBe('—')
    expect(formatFieldValue('   ')).toBe('—')
    expect(formatFieldValue([])).toBe('—')
  })
})

describe('actorLabel', () => {
  it('never renders the form key, which is the intake endpoint’s secret', () => {
    expect(actorLabel('form:9f3a-unguessable', 7)).toBe('Intake form')
    expect(actorLabel('form:9f3a-unguessable', 7)).not.toContain('9f3a')
  })

  it('distinguishes the reader from anyone else', () => {
    expect(actorLabel('user:7', 7)).toBe('You')
    expect(actorLabel('user:8', 7)).toBe('A user')
  })

  it('names a headless caller as what it is, matching what the server writes', () => {
    expect(actorLabel('api_key:3', 7)).toBe('API key')
    expect(actorLabel('system', 7)).toBe('System')
  })

  it('tells a connector apart from Philo’s own writes', () => {
    expect(actorLabel('oauth:client-abc', 7)).toBe('Connected app')
    expect(actorLabel('oauth:client-abc', 7)).not.toBe(actorLabel('system', 7))
  })
})

describe('describeEvent', () => {
  it('names the stage transition on both sides', () => {
    const summary = describeEvent(
      event({
        type: 'stage_changed',
        payload: { from: { id: 1, name: 'New' }, to: { id: 2, name: 'Contacted' } },
      }),
    )
    expect(summary.label).toBe('Stage changed')
    expect(summary.detail).toBe('New → Contacted')
  })

  it('carries a note as body text, and marks a system-written one', () => {
    expect(describeEvent(event({ type: 'note_added', payload: { note: 'Called back' } }))).toMatchObject({
      label: 'Note added',
      body: 'Called back',
    })
    expect(
      describeEvent(event({ type: 'note_added', payload: { note: 'Marked as not spam.', system: true } })).label,
    ).toBe('System note')
  })

  it('shows the subject a sent email went out with', () => {
    expect(
      describeEvent(
        event({
          type: 'email_sent',
          payload: { template: 'new_lead_ack', subject: 'Thanks for getting in touch' },
          actor: 'system',
        }),
      ),
    ).toMatchObject({ label: 'Email sent', detail: '“Thanks for getting in touch”' })
  })

  it('falls back to the template when a send recorded no subject', () => {
    expect(
      describeEvent(event({ type: 'email_sent', payload: { template: 'new_lead_notify' } })).detail,
    ).toBe('new_lead_notify')
  })

  it('still renders an event type it has never seen', () => {
    expect(describeEvent(event({ type: 'call_logged' })).label).toBe('Call logged')
  })
})

describe('leadTitle', () => {
  it('falls back through the contact fields before giving up on the id', () => {
    expect(leadTitle({ id: 4, name: 'Dana', email: 'd@example.com', phone: null })).toBe('Dana')
    expect(leadTitle({ id: 4, name: null, email: 'd@example.com', phone: null })).toBe('d@example.com')
    expect(leadTitle({ id: 4, name: null, email: null, phone: '555-0100' })).toBe('555-0100')
    expect(leadTitle({ id: 4, name: null, email: null, phone: null })).toBe('Lead 4')
  })
})
