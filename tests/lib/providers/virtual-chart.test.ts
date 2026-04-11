import { describe, it, expect, vi } from 'vitest'
import type { ResolveContext, Params, ProviderResponse } from '../../../src/lib/providers/types.js'
import { marketProvider } from '../../../src/lib/providers/virtual.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ResolveContext>): ResolveContext {
  return {
    hint: undefined,
    tier: 'free',
    request: vi.fn<[{ provider?: string; action: string; params: Params }], Promise<ProviderResponse>>(),
    ...overrides,
  }
}

const chartAction = marketProvider.actions['chart']

function resolve(params: Params, ctx?: Partial<ResolveContext>) {
  return chartAction.resolve!(params, makeCtx(ctx))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('market.chart resolve', () => {
  // -----------------------------------------------------------------------
  // Path 1: AIXBT candles (projectId present)
  // -----------------------------------------------------------------------

  describe('AIXBT candles path', () => {
    it('routes to aixbt candles when projectId is present', () => {
      const result = resolve({ projectId: 'abc123' })
      expect(result).toEqual({
        provider: 'aixbt',
        action: 'candles',
        params: expect.objectContaining({ id: 'abc123' }),
      })
    })

    it('maps timeframe "day" to interval "1d"', () => {
      const result = resolve({ projectId: 'abc123', timeframe: 'day' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ interval: '1d' }),
      }))
    })

    it('maps timeframe "hour" to interval "1h"', () => {
      const result = resolve({ projectId: 'abc123', timeframe: 'hour' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ interval: '1h' }),
      }))
    })

    it('maps timeframe "minute" to interval "5m"', () => {
      const result = resolve({ projectId: 'abc123', timeframe: 'minute' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ interval: '5m' }),
      }))
    })

    it('defaults to "1d" when timeframe is omitted', () => {
      const result = resolve({ projectId: 'abc123' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ interval: '1d' }),
      }))
    })

    it('defaults to "1h" for unrecognized timeframe', () => {
      const result = resolve({ projectId: 'abc123', timeframe: '4h' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ interval: '1h' }),
      }))
    })

    it('passes start, end, and at params through', () => {
      const result = resolve({
        projectId: 'abc123',
        timeframe: 'day',
        start: '2026-04-01',
        end: '2026-04-10',
        at: '2026-04-09',
      })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({
          start: '2026-04-01',
          end: '2026-04-10',
          at: '2026-04-09',
        }),
      }))
    })

    it('takes priority over network+address when both present', () => {
      const result = resolve({
        projectId: 'abc123',
        network: 'ethereum',
        address: '0xabc',
        geckoId: 'bitcoin',
      })
      expect(result).toEqual(expect.objectContaining({
        provider: 'aixbt',
        action: 'candles',
      }))
    })
  })

  // -----------------------------------------------------------------------
  // Path 2: On-chain (network + address)
  // -----------------------------------------------------------------------

  describe('on-chain path', () => {
    it('routes to dexpaprika by default when network+address present', () => {
      const result = resolve({ network: 'ethereum', address: '0xabc' })
      expect(result).toEqual(expect.objectContaining({
        provider: 'dexpaprika',
        action: 'token-ohlcv',
      }))
    })

    it('uses hint to override provider', () => {
      const result = resolve(
        { network: 'ethereum', address: '0xabc' },
        { hint: 'coingecko' },
      )
      expect(result).toEqual(expect.objectContaining({
        provider: 'coingecko',
        action: 'token-ohlcv',
      }))
    })

    it('passes timeframe, limit, currency, before_timestamp', () => {
      const result = resolve({
        network: 'solana',
        address: 'So111',
        timeframe: 'hour',
        limit: 50,
        currency: 'eur',
        before_timestamp: 1712700000,
      })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({
          network: 'solana',
          address: 'So111',
          timeframe: 'hour',
          limit: 50,
          currency: 'eur',
          before_timestamp: 1712700000,
        }),
      }))
    })

    it('defaults timeframe to "day" when omitted', () => {
      const result = resolve({ network: 'ethereum', address: '0xabc' })
      expect(result).toEqual(expect.objectContaining({
        params: expect.objectContaining({ timeframe: 'day' }),
      }))
    })
  })

  // -----------------------------------------------------------------------
  // Path 3: CEX (geckoId only)
  // -----------------------------------------------------------------------

  describe('CEX path', () => {
    it('routes to coingecko when only geckoId is present', () => {
      const result = resolve({ geckoId: 'bitcoin' })
      expect(result).toEqual(expect.objectContaining({
        provider: 'coingecko',
      }))
    })

    it('does not route to coingecko when network+address are also present', () => {
      const result = resolve({ network: 'ethereum', address: '0xabc', geckoId: 'bitcoin' })
      // Should take the on-chain path, not the CEX path
      expect(result).toEqual(expect.objectContaining({
        action: 'token-ohlcv',
      }))
    })
  })

  // -----------------------------------------------------------------------
  // Path 4: Error (no usable params)
  // -----------------------------------------------------------------------

  describe('error path', () => {
    it('returns error when no identifying params are present', () => {
      const result = resolve({})
      expect(result).toEqual({ error: expect.stringContaining('no on-chain address or geckoId') })
    })

    it('returns error when only timeframe/limit are present', () => {
      const result = resolve({ timeframe: 'day', limit: 30 })
      expect(result).toEqual({ error: expect.any(String) })
    })

    it('returns error when network is present but address is missing', () => {
      const result = resolve({ network: 'ethereum' })
      expect(result).toEqual({ error: expect.any(String) })
    })
  })
})
