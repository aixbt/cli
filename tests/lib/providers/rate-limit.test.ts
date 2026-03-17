import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  getTracker,
  recordRequest,
  remainingInWindow,
  deriveProviderConcurrency,
  resetAllTrackers,
} from '../../../src/lib/providers/rate-limit.js'

describe('rate-limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAllTrackers()
  })

  afterEach(() => {
    resetAllTrackers()
    vi.useRealTimers()
  })

  // -- getTracker --

  describe('getTracker', () => {
    it('should create a new tracker for an unknown provider', () => {
      const tracker = getTracker('openai', 60)

      expect(tracker.providerName).toBe('openai')
      expect(tracker.maxPerMinute).toBe(60)
      expect(tracker.timestamps).toEqual([])
    })

    it('should return the same tracker for the same provider name', () => {
      const first = getTracker('openai', 60)
      const second = getTracker('openai', 60)

      expect(first).toBe(second)
    })

    it('should return independent trackers for different providers', () => {
      const openai = getTracker('openai', 60)
      const anthropic = getTracker('anthropic', 100)

      expect(openai).not.toBe(anthropic)
      expect(openai.providerName).toBe('openai')
      expect(anthropic.providerName).toBe('anthropic')
      expect(openai.maxPerMinute).toBe(60)
      expect(anthropic.maxPerMinute).toBe(100)
    })
  })

  // -- recordRequest --

  describe('recordRequest', () => {
    it('should return 0 when under the rate limit', () => {
      const tracker = getTracker('test-provider', 10)

      const waitMs = recordRequest(tracker)

      expect(waitMs).toBe(0)
      expect(tracker.timestamps).toHaveLength(1)
    })

    it('should return positive wait time when window is full', () => {
      const tracker = getTracker('test-provider', 3)

      // Record 2 requests (under limit)
      recordRequest(tracker)
      recordRequest(tracker)

      // The 3rd request hits the limit (length >= maxPerMinute)
      const waitMs = recordRequest(tracker)

      expect(waitMs).toBeGreaterThan(0)
      expect(waitMs).toBeLessThanOrEqual(60_000)
    })

    it('should prune timestamps older than 60 seconds', () => {
      const tracker = getTracker('test-provider', 3)

      // Record 2 requests at time 0
      recordRequest(tracker)
      recordRequest(tracker)

      // Advance past the 60s window
      vi.advanceTimersByTime(61_000)

      // This request should prune the old ones and return 0
      const waitMs = recordRequest(tracker)

      expect(waitMs).toBe(0)
      // Only the new request should remain
      expect(tracker.timestamps).toHaveLength(1)
    })

    it('should calculate correct wait time based on oldest timestamp in window', () => {
      const tracker = getTracker('test-provider', 3)

      // Record first request at t=0
      recordRequest(tracker)

      // Advance 10 seconds, record second
      vi.advanceTimersByTime(10_000)
      recordRequest(tracker)

      // Advance another 10 seconds, record third (hits limit)
      vi.advanceTimersByTime(10_000)
      const waitMs = recordRequest(tracker)

      // Wait should be: oldest_timestamp + 60_000 - now
      // oldest was at t=0, now is t=20_000
      // waitMs = 0 + 60_000 - 20_000 = 40_000
      expect(waitMs).toBe(40_000)
    })

    it('should return 0 wait time when oldest timestamp is exactly 60s old', () => {
      const tracker = getTracker('test-provider', 3)

      // Record 2 requests at t=0
      recordRequest(tracker)
      recordRequest(tracker)

      // Advance exactly 60s -- the first two timestamps are now at the cutoff boundary
      vi.advanceTimersByTime(60_000)

      // The prune uses strict < cutoff, so timestamps at exactly cutoff are pruned
      const waitMs = recordRequest(tracker)

      // After pruning, only the new request remains (length=1, under limit of 3)
      expect(waitMs).toBe(0)
    })
  })

  // -- remainingInWindow --

  describe('remainingInWindow', () => {
    it('should return maxPerMinute for a fresh tracker', () => {
      const tracker = getTracker('test-provider', 60)

      expect(remainingInWindow(tracker)).toBe(60)
    })

    it('should decrease as requests are recorded', () => {
      const tracker = getTracker('test-provider', 10)

      recordRequest(tracker)
      expect(remainingInWindow(tracker)).toBe(9)

      recordRequest(tracker)
      expect(remainingInWindow(tracker)).toBe(8)
    })

    it('should recover after the 60s window slides', () => {
      const tracker = getTracker('test-provider', 5)

      // Use up all capacity
      for (let i = 0; i < 5; i++) {
        recordRequest(tracker)
      }
      expect(remainingInWindow(tracker)).toBe(0)

      // Advance past the window
      vi.advanceTimersByTime(61_000)

      expect(remainingInWindow(tracker)).toBe(5)
    })

    it('should never return a negative value', () => {
      const tracker = getTracker('test-provider', 2)

      // Record more than maxPerMinute
      recordRequest(tracker)
      recordRequest(tracker)
      recordRequest(tracker)

      expect(remainingInWindow(tracker)).toBe(0)
    })
  })

  // -- deriveProviderConcurrency --

  describe('deriveProviderConcurrency', () => {
    it('should return 5 when plenty of capacity remains (>20)', () => {
      const tracker = getTracker('test-provider', 60)

      expect(deriveProviderConcurrency(tracker)).toBe(5)
    })

    it('should return 3 when 11-20 requests remaining', () => {
      const tracker = getTracker('test-provider', 25)

      // Use 10, leaving 15 remaining
      for (let i = 0; i < 10; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(15)
      expect(deriveProviderConcurrency(tracker)).toBe(3)
    })

    it('should return 2 when 3-10 requests remaining', () => {
      const tracker = getTracker('test-provider', 15)

      // Use 10, leaving 5 remaining
      for (let i = 0; i < 10; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(5)
      expect(deriveProviderConcurrency(tracker)).toBe(2)
    })

    it('should return 1 when 0-2 requests remaining', () => {
      const tracker = getTracker('test-provider', 5)

      // Use all 5, leaving 0 remaining
      for (let i = 0; i < 5; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(0)
      expect(deriveProviderConcurrency(tracker)).toBe(1)
    })

    it('should return 2 at exactly 10 remaining (boundary)', () => {
      const tracker = getTracker('test-provider', 20)

      // Use 10, leaving 10 remaining
      for (let i = 0; i < 10; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(10)
      expect(deriveProviderConcurrency(tracker)).toBe(2)
    })

    it('should return 3 at exactly 20 remaining (boundary)', () => {
      const tracker = getTracker('test-provider', 30)

      // Use 10, leaving 20 remaining
      for (let i = 0; i < 10; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(20)
      expect(deriveProviderConcurrency(tracker)).toBe(3)
    })

    it('should return 1 at exactly 2 remaining (boundary)', () => {
      const tracker = getTracker('test-provider', 5)

      // Use 3, leaving 2 remaining
      for (let i = 0; i < 3; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(2)
      expect(deriveProviderConcurrency(tracker)).toBe(1)
    })

    it('should return 2 at exactly 3 remaining (boundary)', () => {
      const tracker = getTracker('test-provider', 5)

      // Use 2, leaving 3 remaining
      for (let i = 0; i < 2; i++) {
        recordRequest(tracker)
      }

      expect(remainingInWindow(tracker)).toBe(3)
      expect(deriveProviderConcurrency(tracker)).toBe(2)
    })
  })

  // -- resetAllTrackers --

  describe('resetAllTrackers', () => {
    it('should clear all trackers so getTracker returns new ones', () => {
      const original = getTracker('openai', 60)
      recordRequest(original)

      resetAllTrackers()

      const fresh = getTracker('openai', 60)

      // Should be a new tracker, not the same object
      expect(fresh).not.toBe(original)
      expect(fresh.timestamps).toEqual([])
    })

    it('should clear trackers for all providers', () => {
      getTracker('openai', 60)
      getTracker('anthropic', 100)
      getTracker('google', 50)

      resetAllTrackers()

      // All should return fresh trackers
      const openai = getTracker('openai', 60)
      const anthropic = getTracker('anthropic', 100)

      expect(openai.timestamps).toEqual([])
      expect(anthropic.timestamps).toEqual([])
    })
  })
})
