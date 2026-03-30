import type { Provider, ActionDefinition } from './types.js'
import { hasValue } from './utils.js'
import { createAliasProvider, proxyAction } from './alias.js'
import { coingeckoProvider } from './coingecko.js'
import { dexpaprikaProvider } from './dexpaprika.js'
import { goplusProvider } from './goplus.js'
import { defillamaProvider } from './defillama.js'

// ---------------------------------------------------------------------------
// market — on-chain price/pool/OHLCV data
//
// Shared actions (both providers): default to dexpaprika (fast, keyless).
// CoinGecko-only on-chain actions: pass through to coingecko.
// `chart` action: smart routing based on params (on-chain vs CEX).
//
// Dotted syntax (e.g. `source: market.coingecko`) forces routing to a
// specific backend for shared actions.
// ---------------------------------------------------------------------------

/** On-chain actions that exist on both dexpaprika and coingecko — default to dexpaprika */
const SHARED_ACTIONS = ['token-ohlcv', 'token-pools', 'pool-ohlcv'] as const

/** On-chain actions unique to coingecko — pass through directly */
const COINGECKO_ONLY_ACTIONS = ['token-price', 'pool', 'trending-pools'] as const

const marketActions: Record<string, ActionDefinition> = {}

// Shared actions: route to hint provider or default to dexpaprika
for (const name of SHARED_ACTIONS) {
  marketActions[name] = proxyAction('dexpaprika', name, dexpaprikaProvider.actions[name], 'dexpaprika')
}

// CoinGecko-only on-chain actions: always route to coingecko
for (const name of COINGECKO_ONLY_ACTIONS) {
  marketActions[name] = proxyAction('coingecko', name, coingeckoProvider.actions[name])
}

// chart — smart routing: on-chain vs CEX, provider selection via hint
marketActions['chart'] = {
  method: 'GET',
  description: 'Get price chart — on-chain DEX data if address available, CoinGecko OHLC if geckoId available',
  hint: 'You need historical price candles and have a token address and/or CoinGecko ID',
  params: [
    { name: 'network', required: false, description: 'Network ID — from tokens[].chain' },
    { name: 'address', required: false, description: 'Token contract address — from tokens[].address' },
    { name: 'geckoId', required: false, description: 'CoinGecko coin ID — from coingeckoData.apiId' },
    { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day")' },
    { name: 'limit', required: false, description: 'Number of candles / days of data (default: 30)' },
    { name: 'currency', required: false, description: 'Quote currency (default: "usd")' },
    { name: 'before_timestamp', required: false, description: 'Unix timestamp (seconds) — cap chart data to this time. Auto-set from recipe --at.' },
  ],
  minTier: 'free',
  resolve: (params, ctx) => {
    // On-chain path: pick provider based on hint, default dexpaprika
    if (hasValue(params.network) && hasValue(params.address)) {
      const target = ctx.hint ?? 'dexpaprika'
      return {
        provider: target,
        action: 'token-ohlcv',
        params: {
          network: params.network,
          address: params.address,
          timeframe: params.timeframe ?? 'day',
          limit: params.limit,
          currency: params.currency,
          before_timestamp: params.before_timestamp,
        },
      }
    }
    // CEX path: CoinGecko OHLC (requires geckoId, always CoinGecko)
    if (hasValue(params.geckoId)) {
      const days = params.limit ?? 30
      const beforeTs = params.before_timestamp

      // Paid tier: use ohlc-range for precise date windows
      if (ctx.tier === 'paid' && hasValue(beforeTs)) {
        const to = Number(beforeTs)
        const from = to - Number(days) * 86400
        return {
          provider: 'coingecko',
          action: 'ohlc-range',
          params: {
            id: params.geckoId,
            vs_currency: params.currency ?? 'usd',
            from,
            to,
            interval: 'daily',
          },
        }
      }

      return {
        provider: 'coingecko',
        action: 'ohlc',
        params: {
          id: params.geckoId,
          vs_currency: params.currency ?? 'usd',
          days,
          before_timestamp: beforeTs,
        },
      }
    }
    return { error: 'no on-chain address or geckoId available for this project' }
  },
}

export const marketProvider: Provider = {
  name: 'market',
  displayName: 'Market',
  actions: marketActions,
  tiers: {},
}

// ---------------------------------------------------------------------------
// security — all GoPlus actions + curated virtual entry points
// ---------------------------------------------------------------------------

export const securityProvider = createAliasProvider('security', 'Security', goplusProvider, {
  'token-scan': 'security-check',
  'address-scan': 'address-security',
})

// ---------------------------------------------------------------------------
// defi — all DeFiLlama actions + curated virtual entry points
// ---------------------------------------------------------------------------

export const defiProvider = createAliasProvider('defi', 'DeFi', defillamaProvider)
