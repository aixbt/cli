import type { Provider, ActionDefinition, ProviderTier } from './types.js'
import { flattenJsonApiResponse } from './normalize.js'

const GECKOTERMINAL_ACTIONS = new Set([
  'token-price', 'pool', 'token-pools', 'trending-pools',
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
    minTier: 'demo',
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
      demo: '/onchain/simple/networks/{network}/token_price/{addresses}',
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
      demo: '/onchain/networks/{network}/pools/{address}',
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
      demo: '/onchain/networks/{network}/tokens/{address}/pools',
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
      demo: '/onchain/networks/trending_pools',
      pro: '/onchain/networks/trending_pools',
    },
    description: 'Get trending DEX pools across all networks',
    hint: 'You need to see which liquidity pools are currently trending by volume or transactions',
    params: [
      { name: 'page', required: false, description: 'Page number' },
    ],
    minTier: 'free',
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
      free: 30,
      demo: 30,
      pro: 500,
    },
  },
  resolveAuth: (apiKey: string, tier: ProviderTier): Record<string, string> => {
    if (tier === 'free') return {}
    if (tier === 'demo') return { 'x-cg-demo-api-key': apiKey }
    return { 'x-cg-pro-api-key': apiKey }
  },
  normalize: (body: unknown, actionName: string): unknown => {
    if (GECKOTERMINAL_ACTIONS.has(actionName)) {
      return flattenJsonApiResponse(body)
    }
    return body
  },
}
