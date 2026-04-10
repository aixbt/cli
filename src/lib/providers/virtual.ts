import type { Provider, ActionDefinition } from './types.js'
import { hasValue } from './utils.js'
import { createAliasProvider, proxyAction } from './alias.js'
import { coingeckoProvider } from './coingecko.js'
import { dexpaprikaProvider } from './dexpaprika.js'
import { goplusProvider } from './goplus.js'
import { defillamaProvider } from './defillama.js'
import { resolveGeckoOhlc } from './aixbt.js'

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
    { name: 'projectId', required: false, description: 'AIXBT project ID — routes to AIXBT candles when available' },
    { name: 'start', required: false, description: 'Start date (ISO 8601)' },
    { name: 'end', required: false, description: 'End date (ISO 8601)' },
    { name: 'at', required: false, description: 'Historical anchor (ISO 8601 or relative)' },
    { name: 'before_timestamp', required: false, description: 'Unix timestamp (seconds) — cap chart data to this time. Auto-set from recipe --at.' },
  ],
  minTier: 'free',
  resolve: async (params, ctx) => {
    // Path 1: AIXBT candles (preferred when projectId available)
    if (hasValue(params.projectId)) {
      const intervalMap: Record<string, string> = { day: '1d', hour: '1h', minute: '5m' }
      const interval = intervalMap[String(params.timeframe ?? 'day')] ?? '1h'
      try {
        const result = await ctx.request({
          provider: 'aixbt',
          action: 'candles',
          params: { id: params.projectId, interval, start: params.start, end: params.end, at: params.at },
        })
        const data = result.data as { candles?: unknown[] } | undefined
        if (data?.candles && data.candles.length > 0) {
          return {
            provider: 'aixbt',
            action: 'candles',
            params: { id: params.projectId, interval, start: params.start, end: params.end, at: params.at },
          }
        }
      } catch {
        // AIXBT failed — fall through to existing paths
      }
    }

    // Path 2: On-chain — pick provider based on hint, default dexpaprika
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
      const resolved = resolveGeckoOhlc(
        params.geckoId,
        { days: params.limit, beforeTs: params.before_timestamp, currency: params.currency },
        ctx.tier,
      )
      return { provider: 'coingecko', ...resolved }
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
