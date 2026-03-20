import type { Provider, ActionDefinition, ProviderTier, Params } from './types.js'
import { flattenJsonApiResponse } from './normalize.js'
import { hasValue } from './utils.js'
import { toGeckoTerminalNetwork } from './chains.js'
import { resolveTokenOhlcvViaPool } from './alias.js'

const GECKOTERMINAL_ACTIONS = new Set([
  'token-price', 'pool', 'token-pools', 'trending-pools', 'token-ohlcv', 'pool-ohlcv',
])

/** Actions that use the `network` param and need chain mapping */
const NETWORK_PARAM_ACTIONS = new Set([
  'token-price', 'pool', 'token-pools', 'token-ohlcv', 'pool-ohlcv',
])

const actions: Record<string, ActionDefinition> = {
  // CoinGecko API actions (demo/pro only)
  price: {
    method: 'GET',
    path: '/simple/price',
    description: 'Get current price for one or more coins by CoinGecko ID',
    hint: 'You need the current USD price (and optionally market cap, volume) for coins by their CoinGecko ID',
    params: [
      { name: 'ids', required: true, description: 'Comma-separated CoinGecko IDs (e.g., "bitcoin,ethereum")' },
      { name: 'vs_currencies', required: false, description: 'Target currencies (default: "usd")' },
      { name: 'include_market_cap', required: false, description: 'Include market cap (true/false)' },
      { name: 'include_24hr_vol', required: false, description: 'Include 24h volume (true/false)' },
      { name: 'include_24hr_change', required: false, description: 'Include 24h price change % (true/false)' },
    ],
    minTier: 'demo',
  },
  markets: {
    method: 'GET',
    path: '/coins/markets',
    description: 'Get coin market data (price, market cap, volume) with ranking',
    hint: 'You need a ranked list of coins with market data, optionally filtered by category',
    params: [
      { name: 'vs_currency', required: false, description: 'Target currency (default: "usd")' },
      { name: 'ids', required: false, description: 'Comma-separated CoinGecko IDs to filter' },
      { name: 'category', required: false, description: 'Filter by CoinGecko category slug' },
      { name: 'order', required: false, description: 'Sort order (default: "market_cap_desc")' },
      { name: 'per_page', required: false, description: 'Results per page (max 250)' },
      { name: 'page', required: false, description: 'Page number' },
      { name: 'sparkline', required: false, description: 'Include 7-day sparkline (true/false)' },
      { name: 'price_change_percentage', required: false, description: 'Price change intervals (e.g., "1h,24h,7d")' },
    ],
    minTier: 'demo',
  },
  coin: {
    method: 'GET',
    path: '/coins/{id}',
    description: 'Get full details for a coin',
    hint: 'You need comprehensive details about a specific coin including contract addresses, social links, and description',
    params: [
      { name: 'id', required: true, description: 'CoinGecko coin ID (e.g., "bitcoin", "ethereum")', inPath: true },
      { name: 'localization', required: false, description: 'Include localized languages (true/false, default false)' },
      { name: 'tickers', required: false, description: 'Include exchange tickers (true/false)' },
      { name: 'market_data', required: false, description: 'Include market data (true/false, default true)' },
      { name: 'community_data', required: false, description: 'Include community data (true/false)' },
      { name: 'developer_data', required: false, description: 'Include developer data (true/false)' },
    ],
    minTier: 'demo',
  },
  trending: {
    method: 'GET',
    path: '/search/trending',
    description: 'Get trending coins, NFTs, and categories on CoinGecko',
    hint: 'You need to know what coins and categories are currently trending',
    params: [],
    minTier: 'demo',
  },
  ohlc: {
    method: 'GET',
    path: '/coins/{id}/ohlc',
    description: 'Get OHLC candlestick data for a coin',
    hint: 'You need price candlestick (open/high/low/close) data for charting or technical analysis',
    params: [
      { name: 'id', required: true, description: 'CoinGecko coin ID', inPath: true },
      { name: 'vs_currency', required: false, description: 'Target currency (default: "usd")' },
      { name: 'days', required: false, description: 'Data range in days (1, 7, 14, 30, 90, 180, 365)' },
      { name: 'interval', required: false, description: 'Candle interval (daily)' },
    ],
    minTier: 'free',
  },
  categories: {
    method: 'GET',
    path: '/coins/categories',
    description: 'List all coin categories with market data',
    hint: 'You need a list of CoinGecko coin categories (DeFi, Gaming, L2, etc.) with market caps',
    params: [
      { name: 'order', required: false, description: 'Sort order (e.g., "market_cap_desc", "name_asc")' },
    ],
    minTier: 'demo',
  },
  // GeckoTerminal actions (all tiers)
  'token-price': {
    method: 'GET',
    path: '/simple/networks/{network}/token_price/{addresses}',
    pathByTier: {
      pro: '/onchain/simple/networks/{network}/token_price/{addresses}',
    },
    description: 'Get on-chain token price by contract address and network',
    hint: 'You have a token contract address and need its current price from on-chain DEX data',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "eth", "solana", "base")', inPath: true },
      { name: 'addresses', required: true, description: 'Comma-separated token contract addresses', inPath: true },
    ],
    minTier: 'free',
  },
  pool: {
    method: 'GET',
    path: '/networks/{network}/pools/{address}',
    pathByTier: {
      pro: '/onchain/networks/{network}/pools/{address}',
    },
    description: 'Get details for a specific DEX liquidity pool',
    hint: 'You have a pool/pair address and need its liquidity, volume, and token details',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "eth", "solana", "base")', inPath: true },
      { name: 'address', required: true, description: 'Pool contract address', inPath: true },
    ],
    minTier: 'free',
  },
  'token-pools': {
    method: 'GET',
    path: '/networks/{network}/tokens/{address}/pools',
    pathByTier: {
      pro: '/onchain/networks/{network}/tokens/{address}/pools',
    },
    description: 'List DEX pools for a specific token',
    hint: 'You need to find liquidity pools (trading pairs) for a token on a specific chain',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "eth", "solana", "base")', inPath: true },
      { name: 'address', required: true, description: 'Token contract address', inPath: true },
      { name: 'page', required: false, description: 'Page number' },
    ],
    minTier: 'free',
  },
  'trending-pools': {
    method: 'GET',
    path: '/networks/trending_pools',
    pathByTier: {
      pro: '/onchain/networks/trending_pools',
    },
    description: 'Get trending DEX pools across all networks',
    hint: 'You need to see which liquidity pools are currently trending by volume or transactions',
    params: [
      { name: 'page', required: false, description: 'Page number' },
    ],
    minTier: 'free',
  },
  'token-ohlcv': {
    method: 'GET',
    path: '/networks/{network}/tokens/{address}/ohlcv/{timeframe}',
    pathByTier: {
      pro: '/onchain/networks/{network}/tokens/{address}/ohlcv/{timeframe}',
    },
    description: 'Get on-chain OHLCV candlestick data for a token by contract address',
    hint: 'You have a token contract address and need historical price candles (OHLCV) from DEX trading data',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "eth", "solana", "base") — also accepts CoinGecko chain names (e.g., "ethereum")', inPath: true },
      { name: 'address', required: true, description: 'Token contract address', inPath: true },
      { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day")', inPath: true },
      { name: 'aggregate', required: false, description: 'Number of intervals to aggregate (e.g., 1 for daily, 4 for 4-hour)' },
      { name: 'before_timestamp', required: false, description: 'Unix timestamp (seconds) — return candles before this time' },
      { name: 'limit', required: false, description: 'Number of candles to return' },
      { name: 'currency', required: false, description: 'Quote currency (default: "usd")' },
    ],
    minTier: 'free',
    resolve: async (params, ctx) => {
      // Pro tier has native token-level OHLCV — skip pool lookup
      if (ctx.tier === 'pro') return null
      return resolveTokenOhlcvViaPool(params, ctx.request)
    },
  },
  'pool-ohlcv': {
    method: 'GET',
    path: '/networks/{network}/pools/{address}/ohlcv/{timeframe}',
    pathByTier: {
      pro: '/onchain/networks/{network}/pools/{address}/ohlcv/{timeframe}',
    },
    description: 'Get on-chain OHLCV candlestick data for a specific DEX pool',
    hint: 'You have a pool address and need historical price candles (OHLCV) from DEX trading data',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "eth", "solana", "base")', inPath: true },
      { name: 'address', required: true, description: 'Pool contract address', inPath: true },
      { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day")', inPath: true },
      { name: 'aggregate', required: false, description: 'Number of intervals to aggregate' },
      { name: 'before_timestamp', required: false, description: 'Unix timestamp (seconds) — return candles before this time' },
      { name: 'limit', required: false, description: 'Number of candles to return' },
    ],
    minTier: 'free',
  },
  'chart': {
    method: 'GET',
    description: 'Get price chart — on-chain DEX data if address available, CoinGecko OHLC if geckoId available',
    hint: 'You need historical price candles and have a token address and/or CoinGecko ID',
    params: [
      { name: 'network', required: false, description: 'Network ID — from tokens[].chain (CoinGecko chain names accepted)' },
      { name: 'address', required: false, description: 'Token contract address — from tokens[].address' },
      { name: 'geckoId', required: false, description: 'CoinGecko coin ID — from coingeckoData.apiId' },
      { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day") — on-chain path only' },
      { name: 'limit', required: false, description: 'Number of candles / days of data (default: 30)' },
      { name: 'currency', required: false, description: 'Quote currency (default: "usd")' },
    ],
    minTier: 'free',
    resolve: (params) => {
      if (hasValue(params.network) && hasValue(params.address)) {
        return {
          action: 'token-ohlcv',
          params: {
            network: params.network,
            address: params.address,
            timeframe: params.timeframe ?? 'day',
            limit: params.limit,
            currency: params.currency,
          },
        }
      }

      if (hasValue(params.geckoId)) {
        return {
          action: 'ohlc',
          params: {
            id: params.geckoId,
            vs_currency: params.currency ?? 'usd',
            days: params.limit ?? 30,
          },
        }
      }

      return { error: 'no on-chain address or geckoId available for this project' }
    },
  },
}

export const coingeckoProvider: Provider = {
  name: 'coingecko',
  displayName: 'CoinGecko',
  actions,
  baseUrl: {
    byTier: {
      free: 'https://api.geckoterminal.com/api/v2',
      demo: 'https://api.coingecko.com/api/v3',
      pro: 'https://pro-api.coingecko.com/api/v3',
    },
    default: 'https://api.geckoterminal.com/api/v2',
  },
  rateLimits: {
    perMinute: {
      free: 10,
      demo: 30,
      pro: 500,
    },
  },
  resolveBaseUrl: (actionName: string, tier: ProviderTier): string | undefined => {
    // On-chain actions use GeckoTerminal on free/demo (CoinGecko /onchain/ is pro-only)
    if (GECKOTERMINAL_ACTIONS.has(actionName) && tier !== 'pro') {
      return 'https://api.geckoterminal.com/api/v2'
    }
    // CoinGecko market actions work keyless — route to CoinGecko on free tier
    if (!GECKOTERMINAL_ACTIONS.has(actionName) && tier === 'free') {
      return 'https://api.coingecko.com/api/v3'
    }
    return undefined
  },
  resolveAuth: (apiKey: string, tier: ProviderTier): Record<string, string> => {
    if (tier === 'free') return {}
    if (tier === 'demo') return { 'x-cg-demo-api-key': apiKey }
    return { 'x-cg-pro-api-key': apiKey }
  },
  mapParams: (params: Params, actionName: string) => {
    let result = params

    // Map CoinGecko chain names to GeckoTerminal network IDs
    if (NETWORK_PARAM_ACTIONS.has(actionName)) {
      const network = result.network
      if (typeof network === 'string') {
        const mapped = toGeckoTerminalNetwork(network)
        if (mapped) result = { ...result, network: mapped }
      }
    }

    // Default timeframe for OHLCV actions
    if ((actionName === 'token-ohlcv' || actionName === 'pool-ohlcv') && !result.timeframe) {
      result = result === params ? { ...result, timeframe: 'day' } : result
      result.timeframe = 'day'
    }

    return result
  },
  normalize: (body: unknown, actionName: string): unknown => {
    if (GECKOTERMINAL_ACTIONS.has(actionName)) {
      return flattenJsonApiResponse(body)
    }
    return body
  },
}
