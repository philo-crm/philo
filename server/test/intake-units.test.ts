import { describe, expect, it } from 'vitest'
import { DedupeWindow } from '../src/intake/dedupe.ts'
import {
  HONEYPOT_FIELD,
  MAX_FIELD_DEPTH,
  isContactable,
  isWithinDepthLimit,
  mapSubmission,
  parseFormEncoded,
  submissionHash,
} from '../src/intake/payload.ts'
import { TokenBucket } from '../src/intake/rate-limit.ts'

describe('parseFormEncoded', () => {
  it('reads a plain HTML form body', () => {
    expect(parseFormEncoded('name=Dana+Rivers&email=dana%40example.com')).toEqual({
      name: 'Dana Rivers',
      email: 'dana@example.com',
    })
  })

  it('collects a repeated key into a list', () => {
    expect(parseFormEncoded('endorsements=hazmat&endorsements=tanker')).toEqual({
      endorsements: ['hazmat', 'tanker'],
    })
  })

  // Compared as text: an object literal `{ __proto__: … }` sets the prototype
  // rather than a key, so it cannot express what this is checking for.
  it('keeps a field named __proto__ as a field', () => {
    expect(JSON.stringify(parseFormEncoded('__proto__=surprise'))).toBe('{"__proto__":"surprise"}')
  })
})

describe('mapSubmission', () => {
  it('maps the reserved names to their columns', () => {
    const submission = mapSubmission({
      name: '  Dana Rivers ',
      email: ' Dana@Example.COM ',
      phone: ' 555-0100 ',
    })
    expect(submission).toMatchObject({
      name: 'Dana Rivers',
      email: 'dana@example.com',
      phone: '555-0100',
      fields: {},
      isSpam: false,
    })
  })

  it('builds a name from first and last when there is no name', () => {
    expect(mapSubmission({ first_name: 'Dana', last_name: 'Rivers' }).name).toBe('Dana Rivers')
  })

  it('accepts a first name with no last name', () => {
    expect(mapSubmission({ first_name: 'Dana' }).name).toBe('Dana')
  })

  it('prefers an explicit name over the parts', () => {
    expect(mapSubmission({ name: 'Dana R.', first_name: 'Dana', last_name: 'Rivers' }).name).toBe('Dana R.')
  })

  it('falls back to the parts when name is blank', () => {
    expect(mapSubmission({ name: '   ', first_name: 'Dana', last_name: 'Rivers' }).name).toBe('Dana Rivers')
  })

  it('treats a blank reserved value as absent', () => {
    expect(mapSubmission({ name: '', email: '  ', phone: '' })).toMatchObject({
      name: null,
      email: null,
      phone: null,
    })
  })

  it('keeps every other key in fields, untouched', () => {
    const submission = mapSubmission({
      email: 'dana@example.com',
      years_experience: 7,
      endorsements: ['hazmat', 'tanker'],
      available: true,
      notes: { shift: 'nights' },
    })
    expect(submission.fields).toEqual({
      years_experience: 7,
      endorsements: ['hazmat', 'tanker'],
      available: true,
      notes: { shift: 'nights' },
    })
  })

  it('coerces a scalar reserved value to text', () => {
    expect(mapSubmission({ phone: 5_550_100 }).phone).toBe('5550100')
  })

  it('preserves a non-scalar reserved value in fields rather than dropping it', () => {
    const submission = mapSubmission({ email: { work: 'dana@example.com' }, phone: '555-0100' })
    expect(submission.email).toBeNull()
    expect(submission.fields).toEqual({ email: { work: 'dana@example.com' } })
  })

  it('marks a filled honeypot as spam and never stores it', () => {
    const submission = mapSubmission({ email: 'bot@example.com', [HONEYPOT_FIELD]: 'http://spam' })
    expect(submission.isSpam).toBe(true)
    expect(submission.fields).toEqual({})
  })

  it('does not let a __proto__ key swallow itself or reach the prototype', () => {
    const submission = mapSubmission(JSON.parse('{"email":"dana@example.com","__proto__":{"admin":true}}'))
    expect(JSON.stringify(submission.fields)).toBe('{"__proto__":{"admin":true}}')
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined()
  })

  it('ignores an empty honeypot, which is what a human submits', () => {
    const submission = mapSubmission({ email: 'dana@example.com', [HONEYPOT_FIELD]: '' })
    expect(submission.isSpam).toBe(false)
    expect(submission.fields).toEqual({})
  })
})

describe('isContactable', () => {
  it('needs at least one of email or phone', () => {
    expect(isContactable(mapSubmission({ name: 'Dana' }))).toBe(false)
    expect(isContactable(mapSubmission({ name: 'Dana', email: 'dana@example.com' }))).toBe(true)
    expect(isContactable(mapSubmission({ name: 'Dana', phone: '555-0100' }))).toBe(true)
  })
})

describe('isWithinDepthLimit', () => {
  it('accepts what a form produces', () => {
    expect(isWithinDepthLimit({ a: 1, b: { c: [1, 2, 3] } })).toBe(true)
  })

  it('rejects nesting past the limit', () => {
    let nested: unknown = 'bottom'
    for (let i = 0; i < MAX_FIELD_DEPTH; i += 1) nested = { deeper: nested }
    expect(isWithinDepthLimit(nested as Record<string, unknown>)).toBe(false)
  })

  it('rejects pathological nesting without recursing into it', () => {
    let nested: unknown = 'bottom'
    for (let i = 0; i < 50_000; i += 1) nested = { deeper: nested }
    expect(isWithinDepthLimit(nested as Record<string, unknown>)).toBe(false)
  })
})

describe('submissionHash', () => {
  const submission = mapSubmission({ email: 'dana@example.com', years_experience: 7 })

  it('matches for the same answers in a different key order', () => {
    const reordered = mapSubmission({ years_experience: 7, email: 'dana@example.com' })
    expect(submissionHash('key', reordered)).toBe(submissionHash('key', submission))
  })

  it('differs per form, so two forms never dedupe against each other', () => {
    expect(submissionHash('other', submission)).not.toBe(submissionHash('key', submission))
  })

  it('differs when any answer differs', () => {
    const changed = mapSubmission({ email: 'dana@example.com', years_experience: 8 })
    expect(submissionHash('key', changed)).not.toBe(submissionHash('key', submission))
  })
})

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 })
    expect([0, 0, 0].map(() => bucket.take('ip', 0))).toEqual([true, true, true])
    expect(bucket.take('ip', 0)).toBe(false)
  })

  it('refills on a timer, so a flood never locks a caller out for long', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 })
    bucket.take('ip', 0)
    bucket.take('ip', 0)
    expect(bucket.take('ip', 0)).toBe(false)
    expect(bucket.take('ip', 1_000)).toBe(true)
  })

  it('does not charge a refused request, so refusals cannot extend themselves', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 })
    bucket.take('ip', 0)
    for (let now = 0; now < 900; now += 100) expect(bucket.take('ip', now)).toBe(false)
    expect(bucket.take('ip', 1_000)).toBe(true)
  })

  it('never refills past capacity', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 })
    bucket.take('ip', 0)
    expect([0, 0].map(() => bucket.take('ip', 60_000))).toEqual([true, true])
    expect(bucket.take('ip', 60_000)).toBe(false)
  })

  it('tracks callers separately', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 })
    expect(bucket.take('a', 0)).toBe(true)
    expect(bucket.take('b', 0)).toBe(true)
    expect(bucket.take('a', 0)).toBe(false)
  })

  it('reports whole seconds until the next token', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.5 })
    bucket.take('ip', 0)
    expect(bucket.retryAfterSeconds('ip', 0)).toBe(2)
    expect(bucket.retryAfterSeconds('ip', 1_000)).toBe(1)
  })

  it('hands out no credit for a clock that jumps backwards', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 })
    bucket.take('ip', 10_000)
    expect(bucket.take('ip', 0)).toBe(false)
  })
})

describe('DedupeWindow', () => {
  it('remembers a hash for the window and forgets it after', () => {
    const window = new DedupeWindow(1_000)
    window.record('hash', 0)
    expect(window.has('hash', 500)).toBe(true)
    expect(window.has('hash', 1_001)).toBe(false)
  })

  it('knows nothing it was not told', () => {
    expect(new DedupeWindow(1_000).has('hash', 0)).toBe(false)
  })
})
