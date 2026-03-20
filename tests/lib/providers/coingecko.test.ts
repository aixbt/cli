import { describe, it, expect } from 'vitest'

import { coingeckoProvider } from '../../../src/lib/providers/coingecko.js'

describe('coingeckoProvider', () => {
  // -- Provider identity --

  describe('provider metadata', () => {
    it('should have name "coingecko"', () => {
      expect(coingeckoProvider.name).toBe('coingecko')
    })

    it('should have displayName "CoinGecko"', () => {
      expect(coingeckoProvider.displayName).toBe('CoinGecko')
    })
  })

  // -- Tier-specific base URLs --

  describe('baseUrl', () => {
    it('should have free tier pointing to GeckoTerminal API', () => {
      expect(coingeckoProvider.baseUrl.byTier.free).toBe(
        'https://api.geckoterminal.com/api/v2',
      )
    })

    it('should have demo tier pointing to CoinGecko API', () => {
      expect(coingeckoProvider.baseUrl.byTier.demo).toBe(
        'https://api.coingecko.com/api/v3',
      )
    })

    it('should have pro tier pointing to CoinGecko Pro API', () => {
      expect(coingeckoProvider.baseUrl.byTier.pro).toBe(
        'https://pro-api.coingecko.com/api/v3',
      )
    })

    it('should have default baseUrl pointing to GeckoTerminal', () => {
      expect(coingeckoProvider.baseUrl.default).toBe(
        'https://api.geckoterminal.com/api/v2',
      )
    })
  })

  // -- Rate limits --

  describe('rateLimits', () => {
    it('should have free tier rate limit of 30 per minute', () => {
      expect(coingeckoProvider.rateLimits.perMinute.free).toBe(30)
    })

    it('should have demo tier rate limit of 30 per minute', () => {
      expect(coingeckoProvider.rateLimits.perMinute.demo).toBe(30)
    })

    it('should have pro tier rate limit of 500 per minute', () => {
      expect(coingeckoProvider.rateLimits.perMinute.pro).toBe(500)
    })
  })

  // -- Actions --

  describe('actions', () => {
    const ALL_ACTION_NAMES = [
      'price',
      'markets',
      'coin',
      'trending',
      'ohlc',
      'categories',
      'token-price',
      'pool',
      'token-pools',
      'trending-pools',
      'token-ohlcv',
      'pool-ohlcv',
      'price-history',
    ]

    const COINGECKO_ONLY_ACTIONS = [
      'price',
      'markets',
      'coin',
      'trending',
      'categories',
    ]

    const GECKOTERMINAL_ACTIONS = [
      'token-price',
      'pool',
      'token-pools',
      'trending-pools',
      'token-ohlcv',
      'pool-ohlcv',
    ]

    /** Actions that are minTier: 'free' but use CoinGecko paths (not GeckoTerminal) */
    const COINGECKO_FREE_ACTIONS = [
      'ohlc',
      'price-history',
    ]

    it('should define all 13 actions', () => {
      const actionNames = Object.keys(coingeckoProvider.actions)
      expect(actionNames).toHaveLength(13)
      for (const name of ALL_ACTION_NAMES) {
        expect(coingeckoProvider.actions).toHaveProperty(name)
      }
    })

    it('should use method GET for all actions', () => {
      for (const [name, action] of Object.entries(coingeckoProvider.actions)) {
        expect(action.method, `action "${name}" should use GET`).toBe('GET')
      }
    })

    it('should have minTier "demo" for CoinGecko-only actions', () => {
      for (const name of COINGECKO_ONLY_ACTIONS) {
        expect(
          coingeckoProvider.actions[name].minTier,
          `action "${name}" should have minTier "demo"`,
        ).toBe('demo')
      }
    })

    it('should have minTier "free" for GeckoTerminal actions', () => {
      for (const name of GECKOTERMINAL_ACTIONS) {
        expect(
          coingeckoProvider.actions[name].minTier,
          `action "${name}" should have minTier "free"`,
        ).toBe('free')
      }
    })

    it('should have minTier "free" for CoinGecko free actions', () => {
      for (const name of COINGECKO_FREE_ACTIONS) {
        expect(
          coingeckoProvider.actions[name].minTier,
          `action "${name}" should have minTier "free"`,
        ).toBe('free')
      }
    })

    // -- CoinGecko-only actions: no pathByTier --

    it('should not have pathByTier on CoinGecko-only actions', () => {
      for (const name of COINGECKO_ONLY_ACTIONS) {
        expect(
          coingeckoProvider.actions[name].pathByTier,
          `action "${name}" should not have pathByTier`,
        ).toBeUndefined()
      }
    })

    // -- GeckoTerminal actions: pathByTier overrides --

    it('should have pathByTier with pro override for GeckoTerminal actions', () => {
      for (const name of GECKOTERMINAL_ACTIONS) {
        const action = coingeckoProvider.actions[name]
        expect(
          action.pathByTier,
          `action "${name}" should have pathByTier`,
        ).toBeDefined()
        expect(
          action.pathByTier!.pro,
          `action "${name}" pathByTier should have pro key`,
        ).toBeDefined()
      }
    })

    it('should have GeckoTerminal pathByTier pro paths starting with /onchain', () => {
      for (const name of GECKOTERMINAL_ACTIONS) {
        const action = coingeckoProvider.actions[name]
        expect(
          action.pathByTier!.pro,
          `action "${name}" pathByTier.pro should start with /onchain`,
        ).toMatch(/^\/onchain/)
      }
    })

    // -- price action --

    describe('price action', () => {
      it('should have path /simple/price', () => {
        expect(coingeckoProvider.actions.price.path).toBe('/simple/price')
      })

      it('should have ids as a required param', () => {
        const idsParam = coingeckoProvider.actions.price.params.find(
          (p) => p.name === 'ids',
        )
        expect(idsParam).toBeDefined()
        expect(idsParam!.required).toBe(true)
      })

      it('should have optional params for vs_currencies, market_cap, volume, and change', () => {
        const paramNames = coingeckoProvider.actions.price.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('vs_currencies')
        expect(paramNames).toContain('include_market_cap')
        expect(paramNames).toContain('include_24hr_vol')
        expect(paramNames).toContain('include_24hr_change')
      })
    })

    // -- markets action --

    describe('markets action', () => {
      it('should have path /coins/markets', () => {
        expect(coingeckoProvider.actions.markets.path).toBe('/coins/markets')
      })

      it('should have no required params', () => {
        const requiredParams = coingeckoProvider.actions.markets.params.filter(
          (p) => p.required,
        )
        expect(requiredParams).toHaveLength(0)
      })

      it('should have params including category, order, per_page, and sparkline', () => {
        const paramNames = coingeckoProvider.actions.markets.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('category')
        expect(paramNames).toContain('order')
        expect(paramNames).toContain('per_page')
        expect(paramNames).toContain('sparkline')
      })
    })

    // -- coin action --

    describe('coin action', () => {
      it('should have path /coins/{id}', () => {
        expect(coingeckoProvider.actions.coin.path).toBe('/coins/{id}')
      })

      it('should have id param that is required with inPath true', () => {
        const idParam = coingeckoProvider.actions.coin.params.find(
          (p) => p.name === 'id',
        )
        expect(idParam).toBeDefined()
        expect(idParam!.required).toBe(true)
        expect(idParam!.inPath).toBe(true)
      })
    })

    // -- trending action --

    describe('trending action', () => {
      it('should have path /search/trending', () => {
        expect(coingeckoProvider.actions.trending.path).toBe('/search/trending')
      })

      it('should have empty params array', () => {
        expect(coingeckoProvider.actions.trending.params).toEqual([])
      })
    })

    // -- ohlc action --

    describe('ohlc action', () => {
      it('should have path /coins/{id}/ohlc', () => {
        expect(coingeckoProvider.actions.ohlc.path).toBe('/coins/{id}/ohlc')
      })

      it('should have id param that is required with inPath true', () => {
        const idParam = coingeckoProvider.actions.ohlc.params.find(
          (p) => p.name === 'id',
        )
        expect(idParam).toBeDefined()
        expect(idParam!.required).toBe(true)
        expect(idParam!.inPath).toBe(true)
      })

      it('should have optional params for vs_currency, days, and interval', () => {
        const paramNames = coingeckoProvider.actions.ohlc.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('vs_currency')
        expect(paramNames).toContain('days')
        expect(paramNames).toContain('interval')
      })
    })

    // -- categories action --

    describe('categories action', () => {
      it('should have path /coins/categories', () => {
        expect(coingeckoProvider.actions.categories.path).toBe(
          '/coins/categories',
        )
      })

      it('should have optional order param', () => {
        const orderParam = coingeckoProvider.actions.categories.params.find(
          (p) => p.name === 'order',
        )
        expect(orderParam).toBeDefined()
        expect(orderParam!.required).toBe(false)
      })
    })

    // -- token-price action --

    describe('token-price action', () => {
      it('should have path for GeckoTerminal token price lookup', () => {
        expect(coingeckoProvider.actions['token-price'].path).toBe(
          '/simple/networks/{network}/token_price/{addresses}',
        )
      })

      it('should have network and addresses as required inPath params', () => {
        const params = coingeckoProvider.actions['token-price'].params
        const network = params.find((p) => p.name === 'network')
        const addresses = params.find((p) => p.name === 'addresses')
        expect(network).toBeDefined()
        expect(network!.required).toBe(true)
        expect(network!.inPath).toBe(true)
        expect(addresses).toBeDefined()
        expect(addresses!.required).toBe(true)
        expect(addresses!.inPath).toBe(true)
      })
    })

    // -- pool action --

    describe('pool action', () => {
      it('should have path for GeckoTerminal pool lookup', () => {
        expect(coingeckoProvider.actions.pool.path).toBe(
          '/networks/{network}/pools/{address}',
        )
      })

      it('should have network and address as required inPath params', () => {
        const params = coingeckoProvider.actions.pool.params
        const network = params.find((p) => p.name === 'network')
        const address = params.find((p) => p.name === 'address')
        expect(network).toBeDefined()
        expect(network!.required).toBe(true)
        expect(network!.inPath).toBe(true)
        expect(address).toBeDefined()
        expect(address!.required).toBe(true)
        expect(address!.inPath).toBe(true)
      })
    })

    // -- token-pools action --

    describe('token-pools action', () => {
      it('should have path for GeckoTerminal token pools lookup', () => {
        expect(coingeckoProvider.actions['token-pools'].path).toBe(
          '/networks/{network}/tokens/{address}/pools',
        )
      })

      it('should have network and address as required inPath params', () => {
        const params = coingeckoProvider.actions['token-pools'].params
        const network = params.find((p) => p.name === 'network')
        const address = params.find((p) => p.name === 'address')
        expect(network).toBeDefined()
        expect(network!.required).toBe(true)
        expect(network!.inPath).toBe(true)
        expect(address).toBeDefined()
        expect(address!.required).toBe(true)
        expect(address!.inPath).toBe(true)
      })

      it('should have optional page param', () => {
        const pageParam = coingeckoProvider.actions['token-pools'].params.find(
          (p) => p.name === 'page',
        )
        expect(pageParam).toBeDefined()
        expect(pageParam!.required).toBe(false)
      })
    })

    // -- trending-pools action --

    describe('trending-pools action', () => {
      it('should have path for GeckoTerminal trending pools', () => {
        expect(coingeckoProvider.actions['trending-pools'].path).toBe(
          '/networks/trending_pools',
        )
      })

      it('should have optional page param', () => {
        const pageParam = coingeckoProvider.actions[
          'trending-pools'
        ].params.find((p) => p.name === 'page')
        expect(pageParam).toBeDefined()
        expect(pageParam!.required).toBe(false)
      })
    })
  })

  // -- resolveAuth --

  describe('resolveAuth', () => {
    const resolveAuth = coingeckoProvider.resolveAuth!

    it('should return empty object for free tier', () => {
      expect(resolveAuth('any-key', 'free')).toEqual({})
    })

    it('should return demo API key header for demo tier', () => {
      expect(resolveAuth('my-demo-key', 'demo')).toEqual({
        'x-cg-demo-api-key': 'my-demo-key',
      })
    })

    it('should return pro API key header for pro tier', () => {
      expect(resolveAuth('my-pro-key', 'pro')).toEqual({
        'x-cg-pro-api-key': 'my-pro-key',
      })
    })

    it('should not leak the key in free tier regardless of key value', () => {
      const result = resolveAuth('secret-key-123', 'free')
      expect(Object.keys(result)).toHaveLength(0)
    })

    it('should use the exact key value provided without transformation', () => {
      const key = 'CG-AbCdEfGh12345'
      expect(resolveAuth(key, 'demo')).toEqual({
        'x-cg-demo-api-key': 'CG-AbCdEfGh12345',
      })
      expect(resolveAuth(key, 'pro')).toEqual({
        'x-cg-pro-api-key': 'CG-AbCdEfGh12345',
      })
    })
  })

  // -- normalize --

  describe('normalize', () => {
    // Non-GeckoTerminal actions: returns body as-is

    it('should return body as-is for CoinGecko-only actions', () => {
      const body = { prices: [100, 200] }
      const result = coingeckoProvider.normalize(body, 'price')
      expect(result).toEqual({ prices: [100, 200] })
    })

    it('should return body as-is for markets action', () => {
      const body = [{ id: 'bitcoin', current_price: 50000 }]
      const result = coingeckoProvider.normalize(body, 'markets')
      expect(result).toEqual([{ id: 'bitcoin', current_price: 50000 }])
    })

    it('should return body as-is for trending action', () => {
      const body = { coins: [{ item: { id: 'pepe' } }] }
      const result = coingeckoProvider.normalize(body, 'trending')
      expect(result).toEqual({ coins: [{ item: { id: 'pepe' } }] })
    })

    it('should return body as-is for coin action', () => {
      const body = { id: 'bitcoin', name: 'Bitcoin' }
      const result = coingeckoProvider.normalize(body, 'coin')
      expect(result).toEqual({ id: 'bitcoin', name: 'Bitcoin' })
    })

    it('should return body as-is for ohlc action', () => {
      const body = [[1700000000, 50000, 51000, 49000, 50500]]
      const result = coingeckoProvider.normalize(body, 'ohlc')
      expect(result).toEqual([[1700000000, 50000, 51000, 49000, 50500]])
    })

    it('should return body as-is for categories action', () => {
      const body = [{ id: 'defi', name: 'DeFi' }]
      const result = coingeckoProvider.normalize(body, 'categories')
      expect(result).toEqual([{ id: 'defi', name: 'DeFi' }])
    })

    // GeckoTerminal actions: applies flattenJsonApiResponse

    it('should flatten JSON:API response for token-price action', () => {
      const body = {
        data: {
          id: 'eth_0xabc',
          type: 'token_price',
          attributes: { price_usd: '1.23' },
        },
      }
      const result = coingeckoProvider.normalize(body, 'token-price')
      expect(result).toEqual({
        id: 'eth_0xabc',
        type: 'token_price',
        price_usd: '1.23',
      })
    })

    it('should flatten JSON:API array response for trending-pools action', () => {
      const body = {
        data: [
          {
            id: 'pool-1',
            type: 'pool',
            attributes: { name: 'WETH/USDC', volume_usd: '1000000' },
          },
          {
            id: 'pool-2',
            type: 'pool',
            attributes: { name: 'PEPE/WETH', volume_usd: '500000' },
          },
        ],
      }
      const result = coingeckoProvider.normalize(body, 'trending-pools')
      expect(result).toEqual([
        { id: 'pool-1', type: 'pool', name: 'WETH/USDC', volume_usd: '1000000' },
        { id: 'pool-2', type: 'pool', name: 'PEPE/WETH', volume_usd: '500000' },
      ])
    })

    it('should flatten JSON:API response for pool action', () => {
      const body = {
        data: {
          id: 'eth_0xpool',
          type: 'pool',
          attributes: { base_token_price_usd: '2000.00' },
        },
      }
      const result = coingeckoProvider.normalize(body, 'pool')
      expect(result).toEqual({
        id: 'eth_0xpool',
        type: 'pool',
        base_token_price_usd: '2000.00',
      })
    })

    it('should flatten JSON:API response for token-pools action', () => {
      const body = {
        data: [
          {
            id: 'pool-a',
            type: 'pool',
            attributes: { name: 'TOKEN/WETH' },
          },
        ],
      }
      const result = coingeckoProvider.normalize(body, 'token-pools')
      expect(result).toEqual([
        { id: 'pool-a', type: 'pool', name: 'TOKEN/WETH' },
      ])
    })

    // Edge cases

    it('should return null as-is for non-GeckoTerminal action', () => {
      const result = coingeckoProvider.normalize(null, 'price')
      expect(result).toBeNull()
    })

    it('should return undefined as-is for non-GeckoTerminal action', () => {
      const result = coingeckoProvider.normalize(undefined, 'markets')
      expect(result).toBeUndefined()
    })

    it('should return null as-is for GeckoTerminal action (flattenJsonApiResponse pass-through)', () => {
      const result = coingeckoProvider.normalize(null, 'token-price')
      expect(result).toBeNull()
    })

    it('should return primitive as-is for GeckoTerminal action', () => {
      const result = coingeckoProvider.normalize('raw string', 'pool')
      expect(result).toBe('raw string')
    })

    it('should return body as-is when GeckoTerminal response has no data field', () => {
      const body = { error: 'not found' }
      const result = coingeckoProvider.normalize(body, 'token-price')
      expect(result).toEqual({ error: 'not found' })
    })

    it('should return body as-is for unknown action names (non-GeckoTerminal)', () => {
      const body = { foo: 'bar' }
      const result = coingeckoProvider.normalize(body, 'unknown-action')
      expect(result).toEqual({ foo: 'bar' })
    })

    it('should normalize token-ohlcv as GeckoTerminal response', () => {
      const body = { data: { attributes: { ohlcv_list: [[1710000000, 1, 2, 0.5, 1.5, 100]] } } }
      const result = coingeckoProvider.normalize(body, 'token-ohlcv')
      expect(result).toHaveProperty('ohlcv_list')
    })
  })

  // -- mapParams (chain mapping) --

  describe('mapParams', () => {
    it('should map CoinGecko chain name to GeckoTerminal network ID', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'ethereum', address: '0xabc' },
        'token-ohlcv',
      )
      expect(result.network).toBe('eth')
    })

    it('should map binance-smart-chain to bsc', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'binance-smart-chain', address: '0xabc' },
        'token-price',
      )
      expect(result.network).toBe('bsc')
    })

    it('should pass through already-correct network IDs', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'eth', address: '0xabc' },
        'token-ohlcv',
      )
      expect(result.network).toBe('eth')
    })

    it('should not map network param for non-network actions', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'ethereum', id: 'bitcoin' },
        'ohlc',
      )
      expect(result.network).toBe('ethereum')
    })

    it('should default timeframe to day for token-ohlcv', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'eth', address: '0xabc' },
        'token-ohlcv',
      )
      expect(result.timeframe).toBe('day')
    })

    it('should not override explicit timeframe', () => {
      const result = coingeckoProvider.mapParams!(
        { network: 'eth', address: '0xabc', timeframe: 'hour' },
        'token-ohlcv',
      )
      expect(result.timeframe).toBe('hour')
    })
  })
})
