import type { Provider, ActionDefinition } from './types.js'

const actions: Record<string, ActionDefinition> = {
  protocols: {
    method: 'GET',
    path: '/protocols',
    description: 'List all protocols with TVL data',
    hint: 'You need a comprehensive list of DeFi protocols and their total value locked',
    params: [],
    minTier: 'free',
  },
  protocol: {
    method: 'GET',
    path: '/protocol/{protocol}',
    description: 'Get detailed data for a single protocol by slug',
    hint: 'You have a protocol name/slug (e.g., "aave", "uniswap") and need its TVL breakdown, chain distribution, and history',
    params: [
      { name: 'protocol', required: true, description: 'Protocol slug (e.g., "aave", "lido")', inPath: true },
    ],
    minTier: 'free',
  },
  tvl: {
    method: 'GET',
    path: '/v2/historicalChainTvl',
    description: 'Get total TVL across all chains over time',
    hint: 'You need the aggregate DeFi TVL history across all blockchains',
    params: [],
    minTier: 'free',
  },
  chains: {
    method: 'GET',
    path: '/v2/chains',
    description: 'List all chains with their current TVL',
    hint: 'You need a list of blockchains ranked by total value locked',
    params: [],
    minTier: 'free',
  },
  'chain-tvl': {
    method: 'GET',
    path: '/v2/historicalChainTvl/{chain}',
    description: 'Get TVL history for a specific chain',
    hint: 'You need historical TVL data for a specific blockchain (e.g., "Ethereum", "Solana")',
    params: [
      { name: 'chain', required: true, description: 'Chain name (e.g., "Ethereum", "Solana", "Arbitrum")', inPath: true },
    ],
    minTier: 'free',
  },
  emissions: {
    method: 'GET',
    path: '/api/emission/{coingeckoId}',
    description: 'Get token emission/unlock schedule for a protocol',
    hint: 'You need token unlock or emission schedule data for a project (requires CoinGecko ID)',
    params: [
      { name: 'coingeckoId', required: true, description: 'CoinGecko ID for the protocol', inPath: true },
    ],
    minTier: 'pro',
  },
  yields: {
    method: 'GET',
    path: '/yields/pools',
    description: 'Get yield/APY data for DeFi pools',
    hint: 'You need yield farming APY data across DeFi protocols and pools',
    params: [],
    minTier: 'pro',
  },
}

export const defillamaProvider: Provider = {
  name: 'defillama',
  displayName: 'DeFiLlama',
  actions,
  baseUrl: {
    byTier: {
      free: 'https://api.llama.fi',
      pro: 'https://pro-api.llama.fi/{apiKey}',
    },
    default: 'https://api.llama.fi',
  },
  rateLimits: {
    perMinute: {
      free: 60,
      pro: 120,
    },
  },
  normalize: (body: unknown): unknown => {
    if (typeof body === 'object' && body !== null) {
      const obj = body as Record<string, unknown>
      if (typeof obj.body === 'string') {
        try {
          return JSON.parse(obj.body)
        } catch {
          return obj.body
        }
      }
    }
    return body
  },
}
