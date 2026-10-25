import { describe, expect, it } from 'vitest'
import { ApiError, firstFailure, isUnauthorized } from '../src/http.ts'

describe('firstFailure', () => {
  it('picks a 401 over an earlier failure of any other kind', () => {
    const blip = new TypeError('Failed to fetch')
    const expired = new ApiError(401, 'unauthorized')
    // The whole point: a side request failing must not hide the one failure
    // that has an answer other than a message.
    expect(firstFailure(blip, expired, undefined)).toBe(expired)
    expect(firstFailure(undefined, blip, expired)).toBe(expired)
  })

  it('otherwise reports the first failure there is', () => {
    const first = new ApiError(500, '')
    const second = new ApiError(503, '')
    expect(firstFailure(undefined, first, second)).toBe(first)
    expect(firstFailure(undefined, undefined)).toBeUndefined()
  })
})

describe('isUnauthorized', () => {
  it('is true only for a 401 the API actually answered', () => {
    expect(isUnauthorized(new ApiError(401, 'unauthorized'))).toBe(true)
    expect(isUnauthorized(new ApiError(403, 'forbidden'))).toBe(false)
    expect(isUnauthorized(new TypeError('Failed to fetch'))).toBe(false)
  })
})
