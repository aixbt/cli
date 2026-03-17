import type { Provider, ActionDefinition } from './types.js'

export const AIXBT_ACTION_PATHS: Record<string, string> = {
  projects: '/v2/projects',
  project: '/v2/projects/{id}',
  momentum: '/v2/projects/{id}/momentum',
  chains: '/v2/projects/chains',
  signals: '/v2/signals',
  clusters: '/v2/clusters',
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
      { name: 'minMomentum', required: false, description: 'Minimum momentum score (0-100)' },
      { name: 'sortBy', required: false, description: 'Sort field (e.g., momentumScore, name)' },
      { name: 'hasToken', required: false, description: 'Filter to projects with a token (true/false)' },
      { name: 'excludeStables', required: false, description: 'Exclude stablecoins (true/false)' },
      { name: 'signalSortBy', required: false, description: 'Sort order for embedded signals' },
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
  rateLimits: {
    perMinute: {},
  },
  authHeader: 'X-API-Key',
  normalize: (body: unknown): unknown => {
    if (typeof body === 'object' && body !== null && 'data' in body) {
      return (body as Record<string, unknown>).data
    }
    return body
  },
}
