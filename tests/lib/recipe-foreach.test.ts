import { describe, it, expect, vi } from 'vitest'
import { deriveConcurrency, computeWaitTime, waitIfRateLimited, type RateLimitTracker } from '../../src/lib/recipe/foreach.js'
import type { RateLimitInfo } from '../../src/types.js'
import * as apiClient from '../../src/lib/api-client.js'

vi.mock('../../src/lib/api-client.js', async () => {
  const actual = await vi.importActual('../../src/lib/api-client.js')
  return {
    ...actual,
    get: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  }
})

const mockSleep = vi.mocked(apiClient.sleep)

function makeRateLimit(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    limitPerMinute: 60,
    remainingPerMinute: 30,
    resetMinute: new Date(Date.now() + 60000).toISOString(),
    limitPerDay: 10000,
    remainingPerDay: 9000,
    resetDay: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  }
}

// -- deriveConcurrency --

describe('deriveConcurrency', () => {
  it('returns 3 when rateLimit is null', () => {
    expect(deriveConcurrency(null)).toBe(3)
  })

  it.each([
    [0, 1],
    [1, 1],
    [5, 1],
    [6, 3],
    [20, 3],
    [21, 5],
    [50, 5],
    [51, 10],
    [100, 10],
  ])('returns correct concurrency for remaining=%i -> %i', (remaining, expected) => {
    expect(deriveConcurrency(makeRateLimit({ remainingPerMinute: remaining }))).toBe(expected)
  })
})

// -- computeWaitTime --

describe('computeWaitTime', () => {
  it('uses retryAfterSeconds when present', () => {
    const rl = makeRateLimit({ retryAfterSeconds: 10 })
    expect(computeWaitTime(rl)).toBe(10_000)
  })

  it('calculates from resetMinute when retryAfterSeconds is absent', () => {
    const futureReset = new Date(Date.now() + 30_000).toISOString()
    const rl = makeRateLimit({ resetMinute: futureReset, retryAfterSeconds: undefined })
    const wait = computeWaitTime(rl)
    // Should be ~30500ms (30s + 500ms buffer), allow some tolerance
    expect(wait).toBeGreaterThan(29_000)
    expect(wait).toBeLessThan(32_000)
  })

  it('falls back to 5000ms when resetMinute is in the past', () => {
    const pastReset = new Date(Date.now() - 10_000).toISOString()
    const rl = makeRateLimit({ resetMinute: pastReset, retryAfterSeconds: undefined })
    expect(computeWaitTime(rl)).toBe(5000)
  })
})

// -- waitIfRateLimited --

describe('waitIfRateLimited', () => {
  beforeEach(() => mockSleep.mockClear())

  function makeTracker(): RateLimitTracker {
    return { paused: false, waitedMs: 0 }
  }

  it('sleeps when remainingPerMinute <= 2', async () => {
    const tracker = makeTracker()
    const rl = makeRateLimit({ remainingPerMinute: 2, retryAfterSeconds: 3 })
    await waitIfRateLimited(rl, tracker)

    expect(mockSleep).toHaveBeenCalledWith(3000)
    expect(tracker.paused).toBe(true)
    expect(tracker.waitedMs).toBe(3000)
  })

  it('does not sleep when remainingPerMinute > 2', async () => {
    const tracker = makeTracker()
    const rl = makeRateLimit({ remainingPerMinute: 3 })
    await waitIfRateLimited(rl, tracker)

    expect(mockSleep).not.toHaveBeenCalled()
    expect(tracker.paused).toBe(false)
  })

  it('does not sleep when rateLimit is null', async () => {
    const tracker = makeTracker()
    await waitIfRateLimited(null, tracker)

    expect(mockSleep).not.toHaveBeenCalled()
    expect(tracker.paused).toBe(false)
  })

  it('accumulates waitedMs across multiple calls', async () => {
    const tracker = makeTracker()
    const rl = makeRateLimit({ remainingPerMinute: 1, retryAfterSeconds: 2 })
    await waitIfRateLimited(rl, tracker)
    await waitIfRateLimited(rl, tracker)

    expect(tracker.waitedMs).toBe(4000)
  })
})
