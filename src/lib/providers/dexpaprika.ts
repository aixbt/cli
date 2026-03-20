import type { Provider, ActionDefinition } from './types.js'

const TIMEFRAME_TO_INTERVAL: Record<string, string> = {
  'minute': '1m',
  'hour': '1h',
  'day': '24h',
}

const actions: Record<string, ActionDefinition> = {
  'token-pools': {
    method: 'GET',
    path: '/networks/{network}/tokens/{address}/pools',
    description: 'List DEX pools for a specific token',
    hint: 'You need to find liquidity pools (trading pairs) for a token on a specific chain',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "ethereum", "solana", "base")', inPath: true },
      { name: 'address', required: true, description: 'Token contract address', inPath: true },
      { name: 'limit', required: false, description: 'Number of pools to return (default: 5)' },
    ],
    minTier: 'free',
  },
  'pool-ohlcv': {
    method: 'GET',
    path: '/networks/{network}/pools/{address}/ohlcv',
    description: 'Get OHLCV candlestick data for a specific DEX pool',
    hint: 'You have a pool address and need historical price candles (OHLCV) from DEX trading data',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "ethereum", "solana", "base")', inPath: true },
      { name: 'address', required: true, description: 'Pool contract address', inPath: true },
      { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day")' },
      { name: 'limit', required: false, description: 'Number of candles to return (default: 30, max: 366)' },
      { name: 'start', required: false, description: 'Start time (Unix timestamp, RFC3339, or date)' },
    ],
    minTier: 'free',
  },
}

export const dexpaprikaProvider: Provider = {
  name: 'dexpaprika',
  displayName: 'DexPaprika',
  actions,
  baseUrl: {
    byTier: {},
    default: 'https://api.dexpaprika.com',
  },
  rateLimits: {
    perMinute: {
      free: 300,
    },
  },
  mapParams: (params, actionName) => {
    if (actionName !== 'pool-ohlcv') return params

    const result = { ...params }

    // Map timeframe to DexPaprika interval format
    const tf = String(result.timeframe ?? 'day')
    result.interval = TIMEFRAME_TO_INTERVAL[tf] ?? '24h'
    delete result.timeframe

    // Convert limit + interval to start/end date range
    const limit = Number(result.limit) || 30
    result.limit = limit
    if (!result.start) {
      const intervalMs = tf === 'minute' ? 60_000 : tf === 'hour' ? 3_600_000 : 86_400_000
      const end = new Date()
      const start = new Date(end.getTime() - limit * intervalMs)
      result.start = start.toISOString()
      result.end = end.toISOString()
    }

    return result
  },
  normalize: (body: unknown, actionName: string): unknown => {
    if (actionName === 'token-pools') {
      return normalizeTokenPools(body)
    }
    if (actionName === 'pool-ohlcv') {
      return normalizeOhlcv(body)
    }
    return body
  },
}

/** Normalize to match GeckoTerminal pool shape (address field used by client.ts) */
function normalizeTokenPools(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return []
  const envelope = body as Record<string, unknown>
  const pools = envelope.pools
  if (!Array.isArray(pools)) return []
  return pools.map((pool: Record<string, unknown>) => ({
    address: pool.id,
    name: `${pool.dex_name}`,
    dex: pool.dex_id,
    volume_usd: pool.volume_usd,
    price_usd: pool.price_usd,
    created_at: pool.created_at,
  }))
}

/** Normalize to match GeckoTerminal ohlcv shape (ohlcv_list array) */
function normalizeOhlcv(body: unknown): unknown {
  if (!Array.isArray(body)) return { ohlcv_list: [] }
  const ohlcv_list = body.map((candle: Record<string, unknown>) => {
    const timestamp = Math.floor(new Date(candle.time_open as string).getTime() / 1000)
    return [timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume]
  })
  return { ohlcv_list }
}
