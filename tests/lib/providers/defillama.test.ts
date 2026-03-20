import { describe, it, expect } from 'vitest'

import { defillamaProvider } from '../../../src/lib/providers/defillama.js'
import { CliError } from '../../../src/lib/errors.js'

describe('defillamaProvider', () => {
  // -- Provider identity --

  describe('provider metadata', () => {
    it('should have name "defillama"', () => {
      expect(defillamaProvider.name).toBe('defillama')
    })

    it('should have displayName "DeFiLlama"', () => {
      expect(defillamaProvider.displayName).toBe('DeFiLlama')
    })

    it('should not define authHeader', () => {
      expect(defillamaProvider.authHeader).toBeUndefined()
    })

    it('should not define resolveAuth', () => {
      expect(defillamaProvider.resolveAuth).toBeUndefined()
    })
  })

  // -- Base URL / Tier routing --

  describe('base URL and tier routing', () => {
    it('should have default baseUrl pointing to api.llama.fi', () => {
      expect(defillamaProvider.baseUrl.default).toBe('https://api.llama.fi')
    })

    it('should have free tier URL pointing to api.llama.fi', () => {
      expect(defillamaProvider.baseUrl.byTier.free).toBe(
        'https://api.llama.fi',
      )
    })

    it('should have pro tier URL pointing to pro-api.llama.fi with apiKey placeholder', () => {
      expect(defillamaProvider.baseUrl.byTier.pro).toBe(
        'https://pro-api.llama.fi/{apiKey}',
      )
    })
  })

  // -- Rate limits --

  describe('rate limits', () => {
    it('should have free tier rate limit of 500 per minute', () => {
      expect(defillamaProvider.rateLimits.perMinute.free).toBe(500)
    })

    it('should have pro tier rate limit of 1000 per minute', () => {
      expect(defillamaProvider.rateLimits.perMinute.pro).toBe(1000)
    })
  })

  // -- Actions --

  describe('actions', () => {
    const expectedActions = [
      'protocols',
      'protocol',
      'tvl',
      'chains',
      'chain-tvl',
      'emissions',
      'yields',
    ]

    it('should define all 7 actions', () => {
      const actionNames = Object.keys(defillamaProvider.actions)
      expect(actionNames).toHaveLength(7)
      for (const name of expectedActions) {
        expect(defillamaProvider.actions).toHaveProperty(name)
      }
    })

    it('should use method GET for all actions', () => {
      for (const [name, action] of Object.entries(defillamaProvider.actions)) {
        expect(action.method, `action "${name}" should use GET`).toBe('GET')
      }
    })

    // -- Free tier actions --

    describe('protocols action', () => {
      it('should have path /protocols', () => {
        expect(defillamaProvider.actions.protocols.path).toBe('/protocols')
      })

      it('should have minTier "free"', () => {
        expect(defillamaProvider.actions.protocols.minTier).toBe('free')
      })

      it('should have empty params array', () => {
        expect(defillamaProvider.actions.protocols.params).toEqual([])
      })
    })

    describe('protocol action', () => {
      it('should have path /protocol/{protocol}', () => {
        expect(defillamaProvider.actions.protocol.path).toBe(
          '/protocol/{protocol}',
        )
      })

      it('should have minTier "free"', () => {
        expect(defillamaProvider.actions.protocol.minTier).toBe('free')
      })

      it('should have protocol param that is required with inPath true', () => {
        const param = defillamaProvider.actions.protocol.params.find(
          (p) => p.name === 'protocol',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
        expect(param!.inPath).toBe(true)
      })
    })

    describe('tvl action', () => {
      it('should have path /v2/historicalChainTvl', () => {
        expect(defillamaProvider.actions.tvl.path).toBe(
          '/v2/historicalChainTvl',
        )
      })

      it('should have minTier "free"', () => {
        expect(defillamaProvider.actions.tvl.minTier).toBe('free')
      })

      it('should have empty params array', () => {
        expect(defillamaProvider.actions.tvl.params).toEqual([])
      })
    })

    describe('chains action', () => {
      it('should have path /v2/chains', () => {
        expect(defillamaProvider.actions.chains.path).toBe('/v2/chains')
      })

      it('should have minTier "free"', () => {
        expect(defillamaProvider.actions.chains.minTier).toBe('free')
      })

      it('should have empty params array', () => {
        expect(defillamaProvider.actions.chains.params).toEqual([])
      })
    })

    describe('chain-tvl action', () => {
      it('should have path /v2/historicalChainTvl/{chain}', () => {
        expect(defillamaProvider.actions['chain-tvl'].path).toBe(
          '/v2/historicalChainTvl/{chain}',
        )
      })

      it('should have minTier "free"', () => {
        expect(defillamaProvider.actions['chain-tvl'].minTier).toBe('free')
      })

      it('should have chain param that is required with inPath true', () => {
        const param = defillamaProvider.actions['chain-tvl'].params.find(
          (p) => p.name === 'chain',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
        expect(param!.inPath).toBe(true)
      })
    })

    // -- Pro tier actions --

    describe('emissions action', () => {
      it('should have path /api/emission/{coingeckoId}', () => {
        expect(defillamaProvider.actions.emissions.path).toBe(
          '/api/emission/{coingeckoId}',
        )
      })

      it('should have minTier "pro"', () => {
        expect(defillamaProvider.actions.emissions.minTier).toBe('pro')
      })

      it('should have coingeckoId param that is required with inPath true', () => {
        const param = defillamaProvider.actions.emissions.params.find(
          (p) => p.name === 'coingeckoId',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
        expect(param!.inPath).toBe(true)
      })
    })

    describe('yields action', () => {
      it('should have path /yields/pools', () => {
        expect(defillamaProvider.actions.yields.path).toBe('/yields/pools')
      })

      it('should have minTier "pro"', () => {
        expect(defillamaProvider.actions.yields.minTier).toBe('pro')
      })

      it('should have empty params array', () => {
        expect(defillamaProvider.actions.yields.params).toEqual([])
      })
    })

    // -- Tier distribution --

    it('should have exactly 5 free-tier actions', () => {
      const freeActions = Object.entries(defillamaProvider.actions).filter(
        ([, a]) => a.minTier === 'free',
      )
      expect(freeActions).toHaveLength(5)
    })

    it('should have exactly 2 pro-tier actions', () => {
      const proActions = Object.entries(defillamaProvider.actions).filter(
        ([, a]) => a.minTier === 'pro',
      )
      expect(proActions).toHaveLength(2)
    })
  })

  // -- Normalize function --

  describe('normalize', () => {
    it('should return a plain object body as-is (standard free-tier response)', () => {
      const body = { tvl: 123456, name: 'Aave' }
      const result = defillamaProvider.normalize(body, 'protocol')
      expect(result).toEqual({ tvl: 123456, name: 'Aave' })
    })

    it('should return an array body as-is', () => {
      const body = [{ name: 'Ethereum', tvl: 100 }]
      const result = defillamaProvider.normalize(body, 'chains')
      expect(result).toEqual([{ name: 'Ethereum', tvl: 100 }])
    })

    it('should parse Pro double-encoded body string into JSON', () => {
      const inner = { pools: [{ apy: 5.2 }] }
      const body = { body: JSON.stringify(inner) }
      const result = defillamaProvider.normalize(body, 'yields')
      expect(result).toEqual(inner)
    })

    it('should throw CliError when Pro body field is invalid JSON', () => {
      const body = { body: 'not valid json {{{' }
      expect(() => defillamaProvider.normalize(body, 'yields')).toThrow(CliError)
      expect(() => defillamaProvider.normalize(body, 'yields')).toThrow('Failed to parse Pro API response body')
    })

    it('should return body as-is when body field is not a string', () => {
      const body = { body: 42 }
      const result = defillamaProvider.normalize(body, 'protocol')
      expect(result).toEqual({ body: 42 })
    })

    it('should return body as-is when body field is an object', () => {
      const body = { body: { nested: true } }
      const result = defillamaProvider.normalize(body, 'protocol')
      expect(result).toEqual({ body: { nested: true } })
    })

    it('should return null when body is null', () => {
      const result = defillamaProvider.normalize(null, 'protocols')
      expect(result).toBeNull()
    })

    it('should return undefined when body is undefined', () => {
      const result = defillamaProvider.normalize(undefined, 'protocols')
      expect(result).toBeUndefined()
    })

    it('should return a primitive string as-is', () => {
      const result = defillamaProvider.normalize('raw string', 'protocols')
      expect(result).toBe('raw string')
    })

    it('should return a primitive number as-is', () => {
      const result = defillamaProvider.normalize(42, 'protocols')
      expect(result).toBe(42)
    })

    it('should handle Pro body field containing a JSON array string', () => {
      const inner = [{ pool: 'ETH-USDC', apy: 3.1 }]
      const body = { body: JSON.stringify(inner) }
      const result = defillamaProvider.normalize(body, 'yields')
      expect(result).toEqual(inner)
    })

    it('should handle Pro body field containing an empty JSON object string', () => {
      const body = { body: '{}' }
      const result = defillamaProvider.normalize(body, 'yields')
      expect(result).toEqual({})
    })
  })

  // -- mapParams (chain name mapping) --

  describe('mapParams', () => {
    it('should map CoinGecko chain name to DeFiLlama format', () => {
      const result = defillamaProvider.mapParams!(
        { chain: 'ethereum' },
        'chain-tvl',
      )
      expect(result.chain).toBe('Ethereum')
    })

    it('should map binance-smart-chain to BSC', () => {
      const result = defillamaProvider.mapParams!(
        { chain: 'binance-smart-chain' },
        'chain-tvl',
      )
      expect(result.chain).toBe('BSC')
    })

    it('should pass through already-correct chain names', () => {
      const result = defillamaProvider.mapParams!(
        { chain: 'Ethereum' },
        'chain-tvl',
      )
      expect(result.chain).toBe('Ethereum')
    })

    it('should not affect params without chain field', () => {
      const result = defillamaProvider.mapParams!(
        { protocol: 'aave' },
        'protocol',
      )
      expect(result.protocol).toBe('aave')
    })
  })
})
