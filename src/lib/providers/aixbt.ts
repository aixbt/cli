import type { Provider, ActionDefinition } from './types.js'

export const AIXBT_ACTION_PATHS: Record<string, string> = {
  projects: '/v2/projects',
  project: '/v2/projects/{id}',
  momentum: '/v2/projects/{id}/momentum',
  rank: '/v2/projects/{id}/rank',
  chains: '/v2/projects/chains',
  signals: '/v2/signals',
  clusters: '/v2/clusters',
  grounding: '/v2/grounding/latest',
}

const actions: Record<string, ActionDefinition> = {
  projects: {
    method: 'GET',
    path: '/v2/projects',
    description: 'List projects with momentum scores and metadata',
    hint: 'You need a list of crypto projects, filtered by chain, ticker, momentum, or name',
    params: [
      { name: 'page', required: false, description: 'Page number (1-indexed)' },
      { name: 'limit', required: false, description: 'Results per page (max 100)' },
      { name: 'projectIds', required: false, description: 'Comma-separated project IDs' },
      { name: 'names', required: false, description: 'Comma-separated project names' },
      { name: 'xHandles', required: false, description: 'Comma-separated X/Twitter handles' },
      { name: 'tickers', required: false, description: 'Comma-separated ticker symbols' },
      { name: 'chain', required: false, description: 'Filter by blockchain (e.g., ethereum, solana)' },
      { name: 'address', required: false, description: 'Filter by token contract address' },
      { name: 'minMomentumScore', required: false, description: 'Minimum momentum score (0-100)' },
      { name: 'sortBy', required: false, description: 'Sort field (momentumScore, popularityScore, detectedAt, reinforcedAt)' },
      { name: 'hasToken', required: false, description: 'Filter to projects with a token (true/false)' },
      { name: 'excludeStables', required: false, description: 'Exclude stablecoins (true/false)' },
      { name: 'signalSortBy', required: false, description: 'Sort order for embedded signals' },
      { name: 'at', required: false, description: 'Historical timestamp (ISO 8601). Returns data as of this point in time.' },
    ],
    minTier: 'free',
  },
  project: {
    method: 'GET',
    path: '/v2/projects/{id}',
    description: 'Get a single project by ID with full details and signals',
    hint: 'You have a specific project ID and need its full details, description, tokens, and recent signals',
    params: [
      { name: 'id', required: true, description: 'Project ID', inPath: true },
      { name: 'signalSortBy', required: false, description: 'Sort order for embedded signals' },
      { name: 'at', required: false, description: 'Historical timestamp (ISO 8601). Returns data as of this point in time.' },
    ],
    minTier: 'free',
  },
  momentum: {
    method: 'GET',
    path: '/v2/projects/{id}/momentum',
    description: 'Get momentum score history for a project',
    hint: 'You need historical momentum data for a project over a time range',
    params: [
      { name: 'id', required: true, description: 'Project ID', inPath: true },
      { name: 'start', required: false, description: 'Start date (ISO 8601 or relative like -7d)' },
      { name: 'end', required: false, description: 'End date (ISO 8601 or relative like -1d)' },
      { name: 'includeClusters', required: false, description: 'Include per-hour cluster breakdown (default: true, set to "false" for scores only)' },
      { name: 'at', required: false, description: 'Historical anchor (ISO 8601). Sets the end of the momentum window; start defaults to 7 days before.' },
    ],
    minTier: 'free',
  },
  rank: {
    method: 'GET',
    path: '/v2/projects/{id}/rank',
    description: 'Get rank position history for a project',
    hint: 'You need historical leaderboard rank data for a project over a time window',
    params: [
      { name: 'id', required: true, description: 'Project ID', inPath: true },
      { name: 'start', required: false, description: 'Start date (ISO 8601 or relative like -7d)' },
      { name: 'end', required: false, description: 'End date (ISO 8601 or relative like -1d)' },
      { name: 'at', required: false, description: 'Historical anchor (ISO 8601). Sets the end of the rank window; start defaults to 7 days before.' },
    ],
    minTier: 'free',
  },
  chains: {
    method: 'GET',
    path: '/v2/projects/chains',
    description: 'List all blockchain chains tracked by AIXBT',
    hint: 'You need the list of supported chains for filtering projects',
    params: [],
    minTier: 'free',
  },
  signals: {
    method: 'GET',
    path: '/v2/signals',
    description: 'List signals (insights) with filtering and sorting',
    hint: 'You need crypto market signals/insights, optionally filtered by project, cluster, category, or time range',
    params: [
      { name: 'page', required: false, description: 'Page number (1-indexed)' },
      { name: 'limit', required: false, description: 'Results per page (max 100)' },
      { name: 'projectIds', required: false, description: 'Comma-separated project IDs' },
      { name: 'names', required: false, description: 'Comma-separated project names' },
      { name: 'xHandles', required: false, description: 'Comma-separated X/Twitter handles' },
      { name: 'tickers', required: false, description: 'Comma-separated ticker symbols' },
      { name: 'address', required: false, description: 'Filter by token contract address' },
      { name: 'clusterIds', required: false, description: 'Comma-separated cluster IDs' },
      { name: 'categories', required: false, description: 'Comma-separated categories' },
      { name: 'detectedAfter', required: false, description: 'Signals detected after this date (ISO 8601)' },
      { name: 'detectedBefore', required: false, description: 'Signals detected before this date (ISO 8601)' },
      { name: 'reinforcedAfter', required: false, description: 'Signals reinforced after this date (ISO 8601)' },
      { name: 'reinforcedBefore', required: false, description: 'Signals reinforced before this date (ISO 8601)' },
      { name: 'sortBy', required: false, description: 'Sort field (e.g., detectedAt, reinforcedAt)' },
      { name: 'hasOfficialSource', required: false, description: 'Filter to signals with official sources (true/false)' },
      { name: 'at', required: false, description: 'Historical timestamp (ISO 8601). Returns signals as they existed at this point in time.' },
    ],
    minTier: 'free',
  },
  clusters: {
    method: 'GET',
    path: '/v2/clusters',
    description: 'List all signal clusters (thematic categories)',
    hint: 'You need the list of signal cluster IDs and names for filtering signals',
    params: [],
    minTier: 'free',
  },
  grounding: {
    method: 'GET',
    path: '/v2/grounding/latest',
    description: 'Get market grounding snapshot (narratives, macro, geopolitics, tradfi)',
    hint: 'You need current market context — crypto narratives, global liquidity, geopolitics, or tradfi conditions',
    params: [
      { name: 'at', required: false, description: 'Historical timestamp (ISO 8601). Returns the grounding snapshot active at this point in time.' },
      { name: 'section', required: false, description: 'Show only a specific section (e.g., narratives, macro, geopolitics, tradfi)' },
    ],
    minTier: 'free',
  },
}

/** Actions that accept the `at` query param for historical queries. */
export const AT_SUPPORTED_ACTIONS = new Set(
  Object.entries(actions)
    .filter(([, a]) => a.params.some(p => p.name === 'at'))
    .map(([name]) => name),
)

/**
 * Resolve CoinGecko CEX OHLC routing based on tier and before_timestamp.
 * Paid tier → ohlc-range with precise from/to.
 * Free/demo → ohlc with before_timestamp passthrough (mapParams expands days, client crops).
 */
export function resolveGeckoOhlc(
  geckoId: string | number | boolean,
  params: { days: string | number | boolean | undefined; beforeTs: string | number | boolean | undefined; currency: string | number | boolean | undefined },
  tier: string,
): { action: string; params: Record<string, string | number | boolean | undefined> } {
  const days = params.days ?? 30

  if (tier === 'paid' && params.beforeTs !== undefined && params.beforeTs !== '') {
    const to = Number(params.beforeTs)
    const from = to - Number(days) * 86400
    return {
      action: 'ohlc-range',
      params: {
        id: geckoId,
        vs_currency: params.currency ?? 'usd',
        from,
        to,
        interval: 'daily',
      },
    }
  }

  return {
    action: 'ohlc',
    params: {
      id: geckoId,
      vs_currency: params.currency ?? 'usd',
      days,
      before_timestamp: params.beforeTs,
    },
  }
}

export const aixbtProvider: Provider = {
  name: 'aixbt',
  displayName: 'AIXBT',
  actions,
  baseUrl: {
    byTier: {
      free: 'https://api.aixbt.tech',
    },
    default: 'https://api.aixbt.tech',
  },
  tiers: {
    free: { rank: 0, keyless: true },
  },
  authHeader: 'X-API-Key',
  normalize: (body: unknown): unknown => {
    if (typeof body === 'object' && body !== null && 'data' in body) {
      return (body as Record<string, unknown>).data
    }
    return body
  },
}
