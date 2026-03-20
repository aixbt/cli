import type { Provider, ActionDefinition } from './types.js'

/**
 * Virtual providers are thin routing layers that delegate to concrete providers.
 * Recipes reference these (e.g. `source: charts`) instead of concrete providers,
 * so the underlying data source can change without affecting recipes.
 */

function hasValue(v: string | number | boolean | undefined): boolean {
  return v !== undefined && v !== ''
}

// ---------------------------------------------------------------------------
// charts — price/OHLCV data
//   on-chain (network + address) → dexpaprika (fast, keyless)
//   CEX-only (geckoId) → coingecko
// ---------------------------------------------------------------------------

const chartsActions: Record<string, ActionDefinition> = {
  'price-history': {
    method: 'GET',
    description: 'Get historical price candles for a token (on-chain DEX or CEX data)',
    hint: 'You need historical price candles and have a token address and/or CoinGecko ID',
    params: [
      { name: 'network', required: false, description: 'Network ID — from tokens[].chain' },
      { name: 'address', required: false, description: 'Token contract address — from tokens[].address' },
      { name: 'geckoId', required: false, description: 'CoinGecko coin ID — from coingeckoData.apiId' },
      { name: 'timeframe', required: false, description: 'Candle timeframe: "day", "hour", or "minute" (default: "day")' },
      { name: 'limit', required: false, description: 'Number of candles / days of data (default: 30)' },
      { name: 'currency', required: false, description: 'Quote currency (default: "usd")' },
    ],
    minTier: 'free',
    resolve: (params) => {
      // On-chain path: DexPaprika (pool lookup + OHLCV, no rate limit)
      if (hasValue(params.network) && hasValue(params.address)) {
        return {
          provider: 'dexpaprika',
          action: 'token-ohlcv',
          params: {
            network: params.network,
            address: params.address,
            timeframe: params.timeframe ?? 'day',
            limit: params.limit,
          },
        }
      }
      // CEX path: CoinGecko OHLC (requires geckoId)
      if (hasValue(params.geckoId)) {
        return {
          provider: 'coingecko',
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
  'token-pools': {
    method: 'GET',
    description: 'List DEX pools for a token',
    hint: 'You need to find liquidity pools (trading pairs) for a token on a specific chain',
    params: [
      { name: 'network', required: true, description: 'Network ID (e.g., "ethereum", "solana")', inPath: true },
      { name: 'address', required: true, description: 'Token contract address', inPath: true },
    ],
    minTier: 'free',
    resolve: (params) => ({
      provider: 'dexpaprika',
      action: 'token-pools',
      params,
    }),
  },
}

export const chartsProvider: Provider = {
  name: 'charts',
  displayName: 'Charts',
  actions: chartsActions,
  baseUrl: { byTier: {}, default: '' },
  rateLimits: { perMinute: { free: 600 } },
  normalize: (body) => body,
}

// ---------------------------------------------------------------------------
// security — token/address security scanning (routes to goplus)
// ---------------------------------------------------------------------------

const securityActions: Record<string, ActionDefinition> = {
  'token-scan': {
    method: 'GET',
    description: 'Security scan for a token — honeypot, holder concentration, contract risks',
    hint: 'You have a token address and chain and need security analysis',
    params: [
      { name: 'chain', required: true, description: 'Chain name (e.g., "ethereum", "solana")' },
      { name: 'address', required: true, description: 'Token contract address' },
    ],
    minTier: 'free',
    resolve: (params) => ({
      provider: 'goplus',
      action: 'security-check',
      params,
    }),
  },
  'address-scan': {
    method: 'GET',
    description: 'Security scan for a wallet or contract address',
    hint: 'You need to check if a wallet or contract address is associated with malicious activity',
    params: [
      { name: 'chain_id', required: true, description: 'Numeric chain ID (e.g., "1" for Ethereum)', inPath: true },
      { name: 'address', required: true, description: 'Wallet or contract address' },
    ],
    minTier: 'free',
    resolve: (params) => ({
      provider: 'goplus',
      action: 'address-security',
      params,
    }),
  },
}

export const securityProvider: Provider = {
  name: 'security',
  displayName: 'Security',
  actions: securityActions,
  baseUrl: { byTier: {}, default: '' },
  rateLimits: { perMinute: {} },
  normalize: (body) => body,
}

// ---------------------------------------------------------------------------
// defi — DeFi protocol data (routes to defillama)
// ---------------------------------------------------------------------------

const defiActions: Record<string, ActionDefinition> = {
  protocol: {
    method: 'GET',
    description: 'Get detailed DeFi data for a protocol including TVL breakdown',
    hint: 'You have a protocol name/slug and need its TVL, chain distribution, and history',
    params: [
      { name: 'protocol', required: true, description: 'Protocol slug (e.g., "aave", "lido")', inPath: true },
    ],
    minTier: 'free',
    resolve: (params) => ({
      provider: 'defillama',
      action: 'protocol',
      params,
    }),
  },
  tvl: {
    method: 'GET',
    description: 'Get total DeFi TVL across all chains over time',
    hint: 'You need aggregate DeFi TVL history across all blockchains',
    params: [],
    minTier: 'free',
    resolve: () => ({
      provider: 'defillama',
      action: 'tvl',
      params: {},
    }),
  },
  chains: {
    method: 'GET',
    description: 'List all chains with their current TVL',
    hint: 'You need a list of blockchains ranked by total value locked',
    params: [],
    minTier: 'free',
    resolve: () => ({
      provider: 'defillama',
      action: 'chains',
      params: {},
    }),
  },
  'chain-tvl': {
    method: 'GET',
    description: 'Get TVL history for a specific chain',
    hint: 'You need historical TVL data for a specific blockchain',
    params: [
      { name: 'chain', required: true, description: 'Chain name (e.g., "Ethereum", "Solana")', inPath: true },
    ],
    minTier: 'free',
    resolve: (params) => ({
      provider: 'defillama',
      action: 'chain-tvl',
      params,
    }),
  },
  yields: {
    method: 'GET',
    description: 'Get yield/APY data for DeFi pools',
    hint: 'You need yield farming APY data across DeFi protocols and pools',
    params: [],
    minTier: 'pro',
    resolve: () => ({
      provider: 'defillama',
      action: 'yields',
      params: {},
    }),
  },
}

export const defiProvider: Provider = {
  name: 'defi',
  displayName: 'DeFi',
  actions: defiActions,
  baseUrl: { byTier: {}, default: '' },
  rateLimits: { perMinute: {} },
  normalize: (body) => body,
}
