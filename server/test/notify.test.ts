import { afterEach, describe, expect, it, vi } from 'vitest'
import { combineLeadCreatedHooks, notifyLeadCreated, type CreatedLead } from '../src/notify.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const LEAD: CreatedLead = { id: 7, formId: 1, isSpam: false }

describe('combineLeadCreatedHooks', () => {
  it('has nothing to call when neither channel is wired up', () => {
    expect(combineLeadCreatedHooks(undefined, undefined)).toBeUndefined()
  })

  it('passes a single hook straight through', () => {
    const hook = vi.fn()
    expect(combineLeadCreatedHooks(hook, undefined)).toBe(hook)
  })

  it('fires every hook with the same lead', () => {
    const email = vi.fn()
    const push = vi.fn()

    combineLeadCreatedHooks(email, push)?.(LEAD)

    expect(email).toHaveBeenCalledWith(LEAD)
    expect(push).toHaveBeenCalledWith(LEAD)
  })

  /**
   * The point of the combinator. ADR-0004 makes email and push independent
   * paths to the same fact, so an SMTP module that throws must not be what
   * stops the phone from buzzing.
   */
  it('runs the later hooks after an earlier one throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const push = vi.fn()

    const combined = combineLeadCreatedHooks(() => {
      throw new Error('smtp exploded')
    }, push)

    expect(() => combined?.(LEAD)).not.toThrow()
    expect(push).toHaveBeenCalledWith(LEAD)
  })

  it('does not let a rejected promise from one hook escape to the caller', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const push = vi.fn()

    const combined = combineLeadCreatedHooks(() => Promise.reject(new Error('smtp down')), push)
    combined?.(LEAD)

    expect(push).toHaveBeenCalledWith(LEAD)
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
  })
})

describe('notifyLeadCreated', () => {
  it('does nothing without a hook', () => {
    expect(() => notifyLeadCreated(undefined, LEAD)).not.toThrow()
  })

  // The lead is already committed by the time this runs — DESIGN.md (Intake
  // endpoint) puts every downstream failure behind the 201 the form already got.
  it('swallows and logs a throwing hook', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    notifyLeadCreated(() => {
      throw new Error('boom')
    }, LEAD)

    expect(errors).toHaveBeenCalledWith('lead-created hook failed', expect.any(Error))
  })
})
