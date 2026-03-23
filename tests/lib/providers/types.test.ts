import { describe, it, expect } from 'vitest'

import type { Provider, ProviderTierDef } from '../../../src/lib/providers/types.js'
import {
  isTierSufficient,
  getKeyedTiers,
  getSortedTiers,
} from '../../../src/lib/providers/types.js'

// -- Helpers --

function makeProvider(
  name: string,
  tiers: Record<string, ProviderTierDef>,
): Provider {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    actions: {},
    tiers,
    baseUrl: { byTier: {}, default: 'https://test.example.com' },
  }
}

// Pre-built providers matching actual tier definitions
const coingeckoProvider = makeProvider('coingecko', {
  free: { rank: 0, ratePerMinute: 10, keyless: true },
  demo: { rank: 1, ratePerMinute: 30 },
  paid: { rank: 2, ratePerMinute: 500 },
})

const goplusProvider = makeProvider('goplus', {
  free: { rank: 0, ratePerMinute: 30, keyless: true },
  paid: { rank: 1, ratePerMinute: 120 },
})

const allKeylessProvider = makeProvider('allkeyless', {
  free: { rank: 0, keyless: true },
  basic: { rank: 1, keyless: true },
})

const noKeylessProvider = makeProvider('nokeyless', {
  starter: { rank: 0 },
  pro: { rank: 1 },
  enterprise: { rank: 2 },
})

const emptyTiersProvider = makeProvider('empty', {})

const singleTierProvider = makeProvider('single', {
  only: { rank: 5 },
})

// -- isTierSufficient --

describe('isTierSufficient', () => {
  it('should return true when effective tier has higher rank than required', () => {
    expect(isTierSufficient(coingeckoProvider, 'paid', 'free')).toBe(true)
    expect(isTierSufficient(coingeckoProvider, 'paid', 'demo')).toBe(true)
    expect(isTierSufficient(coingeckoProvider, 'demo', 'free')).toBe(true)
  })

  it('should return false when effective tier has lower rank than required', () => {
    expect(isTierSufficient(coingeckoProvider, 'free', 'paid')).toBe(false)
    expect(isTierSufficient(coingeckoProvider, 'free', 'demo')).toBe(false)
    expect(isTierSufficient(coingeckoProvider, 'demo', 'paid')).toBe(false)
  })

  it('should return false when effective tier is unknown (fail-closed)', () => {
    expect(isTierSufficient(coingeckoProvider, 'enterprise', 'free')).toBe(false)
    expect(isTierSufficient(coingeckoProvider, 'unknown', 'demo')).toBe(false)
  })

  it('should return false when required tier is unknown (fail-closed)', () => {
    expect(isTierSufficient(coingeckoProvider, 'paid', 'enterprise')).toBe(false)
    expect(isTierSufficient(coingeckoProvider, 'demo', 'unknown')).toBe(false)
  })

  it('should return true when effective and required tier are equal', () => {
    expect(isTierSufficient(coingeckoProvider, 'paid', 'paid')).toBe(true)
    expect(isTierSufficient(coingeckoProvider, 'demo', 'demo')).toBe(true)
    expect(isTierSufficient(coingeckoProvider, 'free', 'free')).toBe(true)
  })

  it('should return false for any comparison on provider with empty tiers', () => {
    expect(isTierSufficient(emptyTiersProvider, 'free', 'free')).toBe(false)
    expect(isTierSufficient(emptyTiersProvider, 'paid', 'free')).toBe(false)
    expect(isTierSufficient(emptyTiersProvider, '', '')).toBe(false)
  })
})

// -- getKeyedTiers --

describe('getKeyedTiers', () => {
  it('should return only non-keyless tiers for CoinGecko-like provider (3 tiers, free is keyless)', () => {
    const result = getKeyedTiers(coingeckoProvider)
    expect(result).toEqual(['demo', 'paid'])
  })

  it('should return only non-keyless tiers for GoPlus-like provider (2 tiers, free is keyless)', () => {
    const result = getKeyedTiers(goplusProvider)
    expect(result).toEqual(['paid'])
  })

  it('should return empty array when all tiers are keyless', () => {
    const result = getKeyedTiers(allKeylessProvider)
    expect(result).toEqual([])
  })

  it('should return all tier names when no tiers are keyless', () => {
    const result = getKeyedTiers(noKeylessProvider)
    expect(result).toEqual(['starter', 'pro', 'enterprise'])
  })

  it('should return empty array for provider with no tiers', () => {
    const result = getKeyedTiers(emptyTiersProvider)
    expect(result).toEqual([])
  })
})

// -- getSortedTiers --

describe('getSortedTiers', () => {
  it('should return tiers in ascending rank order for 3-tier provider', () => {
    const result = getSortedTiers(coingeckoProvider)
    expect(result).toEqual([
      ['free', { rank: 0, ratePerMinute: 10, keyless: true }],
      ['demo', { rank: 1, ratePerMinute: 30 }],
      ['paid', { rank: 2, ratePerMinute: 500 }],
    ])
  })

  it('should return tiers in ascending rank order for 2-tier provider', () => {
    const result = getSortedTiers(goplusProvider)
    expect(result).toEqual([
      ['free', { rank: 0, ratePerMinute: 30, keyless: true }],
      ['paid', { rank: 1, ratePerMinute: 120 }],
    ])
  })

  it('should work with single-tier provider', () => {
    const result = getSortedTiers(singleTierProvider)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(['only', { rank: 5 }])
  })

  it('should return empty array for provider with no tiers', () => {
    const result = getSortedTiers(emptyTiersProvider)
    expect(result).toEqual([])
  })

  it('should sort correctly when tiers are defined in non-rank order', () => {
    const unordered = makeProvider('unordered', {
      enterprise: { rank: 10 },
      starter: { rank: 1 },
      pro: { rank: 5 },
    })

    const result = getSortedTiers(unordered)
    expect(result.map(([name]) => name)).toEqual(['starter', 'pro', 'enterprise'])
    expect(result.map(([, def]) => def.rank)).toEqual([1, 5, 10])
  })
})
