import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveRelativeTime, resolveDate, RELATIVE_TIME_REGEX } from '../../src/lib/date.js'

describe('date resolver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('RELATIVE_TIME_REGEX', () => {
    it('should match -7d', () => {
      expect(RELATIVE_TIME_REGEX.test('-7d')).toBe(true)
    })

    it('should match -24h', () => {
      expect(RELATIVE_TIME_REGEX.test('-24h')).toBe(true)
    })

    it('should match -30m', () => {
      expect(RELATIVE_TIME_REGEX.test('-30m')).toBe(true)
    })

    it('should not match ISO dates', () => {
      expect(RELATIVE_TIME_REGEX.test('2026-03-01')).toBe(false)
    })

    it('should not match invalid expressions', () => {
      expect(RELATIVE_TIME_REGEX.test('7d')).toBe(false)
      expect(RELATIVE_TIME_REGEX.test('-7x')).toBe(false)
      expect(RELATIVE_TIME_REGEX.test('')).toBe(false)
    })
  })

  describe('resolveRelativeTime', () => {
    it('should resolve -7d to 7 days ago', () => {
      const result = resolveRelativeTime('-7d')
      expect(result).toBe('2026-03-18T12:00:00.000Z')
    })

    it('should resolve -24h to 24 hours ago', () => {
      const result = resolveRelativeTime('-24h')
      expect(result).toBe('2026-03-24T12:00:00.000Z')
    })

    it('should resolve -30m to 30 minutes ago', () => {
      const result = resolveRelativeTime('-30m')
      expect(result).toBe('2026-03-25T11:30:00.000Z')
    })

    it('should pass through ISO dates unchanged', () => {
      const result = resolveRelativeTime('2026-01-01T00:00:00Z')
      expect(result).toBe('2026-01-01T00:00:00Z')
    })

    it('should pass through invalid input unchanged', () => {
      const result = resolveRelativeTime('not-a-date')
      expect(result).toBe('not-a-date')
    })
  })

  describe('resolveDate', () => {
    it('should return undefined for undefined input', () => {
      expect(resolveDate(undefined)).toBeUndefined()
    })

    it('should resolve relative time expressions', () => {
      const result = resolveDate('-7d')
      expect(result).toBe('2026-03-18T12:00:00.000Z')
    })

    it('should pass through ISO dates', () => {
      const result = resolveDate('2026-01-01')
      expect(result).toBe('2026-01-01')
    })
  })
})
