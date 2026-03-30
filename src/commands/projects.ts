import type { Command } from 'commander'
import type { SignalData } from '../types.js'
import { getClientOptions, getPublicClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'
import { formatTokenCount } from '../lib/tokens.js'
import { resolveDate } from '../lib/date.js'

// -- Response types --

interface ProjectData {
  id: string
  name: string
  description?: string
  rationale?: string
  xHandle?: string
  momentumScore?: number
  scoreDelta?: number
  popularityScore?: number
  coingeckoData?: {
    apiId: string
    type: string
    symbol: string
    slug: string
    description: string
    homepage: string
    contractAddress: string
    categories: string[]
  }
  metrics?: {
    usd: number
    usdMarketCap: number
    usd24hVol: number
    usd24hChange: number
    lastUpdatedAt: number
  }
  tokens?: Array<{ chain: string; address: string; source: string }>
  createdAt?: string
  updatedAt?: string
  reinforcedAt?: string
  signals: SignalData[]
}

interface MomentumData {
  projectId: string
  projectName: string
  data: Array<{
    timestamp: string
    momentumScore: number
    clusters: Array<{ id: string; name: string; count: number }>
  }>
}

interface RankData {
  projectId: string
  projectName: string
  data: Array<{
    timestamp: string
    rank: number
    score?: number
  }>
}

// -- Table column definitions --

const PROJECT_LIST_COLUMNS: output.TableColumn[] = [
  {
    key: 'score',
    header: 'Score',
    width: 9,
    align: 'right' as const,
    format: (v: unknown) => {
      if (typeof v !== 'string') return '-'
      const [score, delta] = v.split('|')
      const arrow = delta === '1' ? ` ${output.fmt.green('↑')}` : '  '
      return output.fmt.number(score) + arrow
    },
  },
  {
    key: 'name',
    header: 'Name',
  },
  {
    key: 'rationale',
    header: 'Rationale',
  },
  {
    key: 'change',
    header: '24h',
    width: 10,
    align: 'right' as const,
    format: (v: unknown) => {
      if (typeof v !== 'number') return '-'
      return output.formatChange(v)
    },
  },
]

const MOMENTUM_COLUMNS: output.TableColumn[] = [
  { key: 'timestamp', header: 'Time', width: 18 },
  {
    key: 'score',
    header: 'Score',
    width: 8,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : '-'),
  },
  { key: 'clusters', header: 'Clusters:mentions' },
]

const RANK_COLUMNS: output.TableColumn[] = [
  { key: 'timestamp', header: 'Time', width: 18 },
  {
    key: 'rank',
    header: 'Rank',
    width: 6,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? `#${v}` : '-'),
  },
  {
    key: 'score',
    header: 'Score',
    width: 8,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : '-'),
  },
]

// -- Command registration --

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command('projects')
    .description('Query tracked projects and momentum')
    .argument('[id]', 'Project ID to get details for')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page')
    .option('--project-ids <ids>', 'Filter by project IDs (comma-separated)')
    .option('--names <names>', 'Filter by project names (comma-separated)')
    .option('--x-handles <handles>', 'Filter by X handles (comma-separated)')
    .option('--tickers <tickers>', 'Filter by tickers (comma-separated)')
    .option('--chain <chain>', 'Filter by chain')
    .option('--address <address>', 'Filter by token address')
    .option('--min-momentum-score <score>', 'Minimum momentum score')
    .option('--sort-by <field>', 'Sort by field (momentumScore, popularityScore, createdAt, reinforcedAt)', 'momentumScore')
    .option('--has-token [bool]', 'Filter projects with/without tokens')
    .option('--exclude-stables', 'Exclude stablecoins')
    .option('--created-after <date>', 'Filter projects created after date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--created-before <date>', 'Filter projects created before date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--signal-sort <field>', 'Sort signals by field (createdAt, reinforcedAt)', 'createdAt')
    .option('--at <date>', 'Historical timestamp (ISO 8601 or relative: -24h, -7d)')
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      if (id) {
        await handleProjectDetail(id, cmd)
      } else {
        await handleProjectList(cmd)
      }
    })

  // -- chains subcommand --
  projects
    .command('chains')
    .description('List available chains')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleChains(cmd)
    })

  // -- momentum subcommand --
  projects
    .command('momentum <id>')
    .description('Get momentum history for a project')
    .option('--start <date>', 'Start date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--end <date>', 'End date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--at <date>', 'Snapshot at a past time (ISO 8601 or relative: -24h, -7d)')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await handleMomentum(id, cmd)
    })

  // -- rank subcommand --
  projects
    .command('rank <id>')
    .description('Get rank history for a project')
    .option('--start <date>', 'Start date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--end <date>', 'End date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--at <date>', 'Snapshot at a past time (ISO 8601 or relative: -24h, -7d)')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await handleRank(id, cmd)
    })
}

// -- Handlers --

async function handleProjectList(cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat, verbosity, limit } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    page: opts.page as string,
    limit,
    projectIds: opts.projectIds as string | undefined,
    names: opts.names as string | undefined,
    xHandles: opts.xHandles as string | undefined,
    tickers: opts.tickers as string | undefined,
    chain: opts.chain as string | undefined,
    address: opts.address as string | undefined,
    minMomentumScore: opts.minMomentumScore as string | undefined,
    sortBy: opts.sortBy as string,
    hasToken: opts.hasToken as string | undefined,
    excludeStables: opts.excludeStables ? 'true' : undefined,
    createdAfter: resolveDate(opts.createdAfter as string | undefined),
    createdBefore: resolveDate(opts.createdBefore as string | undefined),
    signalSortBy: opts.signalSort as string,
    at: resolveDate(opts.at as string | undefined),
  }

  const result = await output.withSpinner(
    'Fetching projects...',
    outputFormat,
    () => withPayPerUse(
      () => get<ProjectData[]>('/v2/projects', params, clientOpts),
      authMode,
      reconstructCommand('aixbt projects', opts),
      outputFormat,
    ),
    'Failed to fetch projects',
    { silent: true },
  )

  const hints: string[] = []
  if (verbosity === 0) {
    hints.push('Use -v for details, -vv for signals')
  } else if (verbosity === 1) {
    hints.push('Use -vv for inline signals')
  }
  if (verbosity >= 2 && result.data.length > 0) {
    hints.push(`Output: ~${formatTokenCount(result.data)} tokens. In recipes, use transform: to control what reaches agents.`)
  }

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: result.data.map(p => filterProjectFields(p, verbosity)), meta: result.meta, hints }, outputFormat)
    return
  }

  if (verbosity >= 1) {
    output.cards(result.data.map((p) => buildProjectCard(p, verbosity)))
    output.showPagination(result.pagination, result.data.length)
    output.printHints(hints)

    return
  }

  const rows = result.data.map((p) => {
    const ticker = p.coingeckoData?.symbol
      ? ` ${output.fmt.dim('$' + p.coingeckoData.symbol.toUpperCase())}`
      : ''
    return {
      score: `${p.momentumScore ?? '-'}|${p.scoreDelta && p.scoreDelta > 0 ? '1' : '0'}`,
      name: `${p.name}${ticker}`,
      rationale: p.rationale ?? '-',
      change: p.metrics?.usd24hChange,
    }
  })

  output.table(rows, PROJECT_LIST_COLUMNS)
  output.showPagination(result.pagination)

  output.printHints(hints)
}

async function handleProjectDetail(id: string, cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat, verbosity } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const result = await output.withSpinner(
    'Fetching project...',
    outputFormat,
    () => withPayPerUse(
      () => get<ProjectData>(`/v2/projects/${encodeURIComponent(id)}`, {
        signalSortBy: opts.signalSort as string,
        at: resolveDate(opts.at as string | undefined),
      }, clientOpts),
      authMode,
      reconstructCommand(`aixbt projects ${id}`, opts),
      outputFormat,
    ),
    'Failed to fetch project',
    { silent: true },
  )

  const project = result.data

  const hints: string[] = []
  if (verbosity >= 2) {
    hints.push(`Output: ~${formatTokenCount(project)} tokens. In recipes, use transform: to control what reaches agents.`)
  }

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: filterProjectFields(project, verbosity), meta: result.meta, hints }, outputFormat)
    return
  }

  // Single project uses the same card layout as multi-project -v,
  // but with verbosity shifted up by 1 (default single = multi -v)
  const cardVerbosity = verbosity + 1
  output.cards([buildProjectCard(project, cardVerbosity)])

  output.printHints(hints)
}

async function handleMomentum(id: string, cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    start: resolveDate(opts.start as string | undefined),
    end: resolveDate(opts.end as string | undefined),
    at: resolveDate(opts.at as string | undefined),
  }

  const result = await output.withSpinner(
    'Fetching momentum history...',
    outputFormat,
    () => withPayPerUse(
      () => get<MomentumData>(`/v2/projects/${encodeURIComponent(id)}/momentum`, params, clientOpts),
      authMode,
      reconstructCommand(`aixbt projects momentum ${id}`, opts),
      outputFormat,
    ),
    'Failed to fetch momentum',
    { silent: true },
  )

  const momentum = result.data

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: momentum, meta: result.meta }, outputFormat)
    return
  }

  output.label('Momentum History', momentum.projectName)
  console.log()

  if (!momentum.data || momentum.data.length === 0) {
    output.dim('No momentum data available.')
    return
  }

  // Build cluster color map across all data points
  const clusterColorMap = output.buildClusterColorMap(momentum.data)

  // Show last 10 data points
  const rows = momentum.data.slice(-10).map((point) => {
    const clusters = point.clusters.length > 0
      ? point.clusters.map((c) => `${output.clusterDot(clusterColorMap.get(c.id) ?? 0, c.name)} ${c.name}${output.fmt.dim(`:${c.count}`)}`).join('  ')
      : '-'

    return {
      timestamp: point.timestamp.replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ''),
      score: point.momentumScore,
      clusters,
    }
  })

  output.table(rows, MOMENTUM_COLUMNS)

}

async function handleRank(id: string, cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    start: resolveDate(opts.start as string | undefined),
    end: resolveDate(opts.end as string | undefined),
    at: resolveDate(opts.at as string | undefined),
  }

  const result = await output.withSpinner(
    'Fetching rank history...',
    outputFormat,
    () => withPayPerUse(
      () => get<RankData>(`/v2/projects/${encodeURIComponent(id)}/rank`, params, clientOpts),
      authMode,
      reconstructCommand(`aixbt projects rank ${id}`, opts),
      outputFormat,
    ),
    'Failed to fetch rank history',
    { silent: true },
  )

  const rank = result.data

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: rank, meta: result.meta }, outputFormat)
    return
  }

  output.label('Rank History', rank.projectName)
  console.log()

  if (!rank.data || rank.data.length === 0) {
    output.dim('No rank data available (project may not have been in the top 100).')
    return
  }

  const rows = rank.data.slice(-20).map((point) => ({
    timestamp: point.timestamp.replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ''),
    rank: point.rank,
    score: point.score,
  }))

  output.table(rows, RANK_COLUMNS)
}

async function handleChains(cmd: Command): Promise<void> {
  // Chains is a reference endpoint — always returns current data, no auth required.
  const { clientOpts, outputFormat } = getPublicClientOptions(cmd)

  const result = await output.withSpinner(
    'Fetching chains...',
    outputFormat,
    () => get<string[]>('/v2/projects/chains', undefined, clientOpts),
    'Failed to fetch chains',
    { silent: true },
  )

  const chains = result.data

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: chains, meta: result.meta }, outputFormat)
    return
  }

  if (chains.length === 0) {
    output.dim('No chains available.')
    return
  }

  for (const chain of chains) {
    console.log(chain)
  }
  console.log()
  output.dim(`${chains.length} chain${chains.length === 1 ? '' : 's'} available`)

}

// -- Shared card builder --

function buildProjectCard(p: ProjectData, verbosity: number): output.CardItem {
  return {
    title: p.name,
    subtitle: p.coingeckoData?.symbol
      ? output.fmt.dim(`$${p.coingeckoData.symbol.toUpperCase()}`)
      : undefined,
    fields: [
      { label: 'ID', value: p.id ? output.fmt.id(p.id) : undefined },
      { label: 'Score', value: typeof p.momentumScore === 'number' ? output.fmt.number(p.momentumScore.toFixed(2)) + (p.scoreDelta && p.scoreDelta > 0 ? ` ${output.fmt.green('↑')}` : '') : undefined },
      { label: 'Popularity', value: typeof p.popularityScore === 'number' ? output.fmt.number(String(p.popularityScore)) : undefined },
      { label: 'X Handle', value: p.xHandle ? `@${p.xHandle}` : undefined },
      { label: 'Description', value: p.description },
      { label: 'Rationale', value: p.rationale },
      ...(verbosity < 2 ? [{ label: 'Signals', value: output.fmt.number(String(p.signals?.length ?? 0)) }] : []),
      { label: 'Price', value: p.metrics?.usd != null ? metricsColor(p)(`$${p.metrics.usd.toFixed(6)}`) : undefined },
      { label: 'Market Cap', value: p.metrics?.usdMarketCap != null ? metricsColor(p)(`$${output.formatLargeNumber(p.metrics.usdMarketCap)}`) : undefined },
      { label: '24h Volume', value: p.metrics?.usd24hVol != null ? metricsColor(p)(`$${output.formatLargeNumber(p.metrics.usd24hVol)}`) : undefined },
      { label: '24h Change', value: p.metrics?.usd24hChange != null ? output.formatChange(p.metrics.usd24hChange) : undefined },
      { label: 'Tokens', value: p.tokens?.map(t => `${t.chain}:${output.fmt.address(t.address)}`).join('\n') },
      { label: 'Created', value: p.createdAt ? output.timeAgo(p.createdAt) : undefined },
      { label: 'Reinforced', value: p.reinforcedAt ? output.timeAgo(p.reinforcedAt) : undefined },
      ...(verbosity >= 3 && p.coingeckoData ? [
        { label: 'CG API ID', value: p.coingeckoData.apiId },
        { label: 'CG Slug', value: p.coingeckoData.slug },
        { label: 'Homepage', value: p.coingeckoData.homepage },
        { label: 'Contract', value: p.coingeckoData.contractAddress },
        { label: 'Categories', value: p.coingeckoData.categories?.join(', ') },
      ] : p.coingeckoData?.categories?.length ? [
        { label: 'Categories', value: p.coingeckoData.categories.join(', ') },
      ] : []),
      ...formatSignals(p.signals, verbosity),
    ],
  }
}

// -- Utility --

function metricsColor(p: { metrics?: { usd24hChange?: number } }): (s: string) => string {
  const change = p.metrics?.usd24hChange
  if (change == null) return output.fmt.yellow
  return change >= 0 ? output.fmt.green : output.fmt.red
}


function formatSignals(signals: SignalData[] | undefined, verbosity: number): output.CardField[] {
  if (verbosity < 2 || !signals || signals.length === 0) return []

  // Build a stable color map across all clusters in all signals
  const clusterColorMap = output.buildClusterColorMap(signals)

  const fields: output.CardField[] = []
  fields.push({ label: 'signals', value: '', section: true })
  for (const s of signals) {
    const updates = s.activity?.length ?? 0
    const clusterTags = (s.clusters ?? []).map(c =>
      `${output.clusterDot(clusterColorMap.get(c.id) ?? 0, c.name)} ${output.fmt.dim(c.name)}`,
    ).join('  ')
    const meta = output.fmt.dim(`Detected ${output.timeAgo(s.detectedAt)} · Reinforced ${output.timeAgo(s.reinforcedAt)} · ${updates} update${updates !== 1 ? 's' : ''}`)
    const valueParts = [s.description, meta]
    if (clusterTags) valueParts.push(clusterTags)
    if (verbosity >= 3 && (s.activity?.length ?? 0) > 1) {
      // Account for keyValue indent (2 + pad + 2 = 22 with default pad 18)
      const activityWidth = (process.stdout.columns || 80) - 22
      const entries = output.formatActivity(s.activity, clusterColorMap, { width: activityWidth })
      valueParts.push(output.fmt.boldWhite('activity'))
      for (let i = 0; i < entries.length; i++) {
        if (i > 0) valueParts.push('')
        valueParts.push(entries[i])
      }
      valueParts.push('')
    }
    fields.push({ label: s.category || 'UNCATEGORIZED', value: valueParts.join('\n'), noColon: true, keyStyle: output.fmt.tag, fill: true })
  }
  return fields
}

function filterProjectFields(p: ProjectData, verbosity: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: p.name,
    momentumScore: p.momentumScore,
    rationale: p.rationale,
  }

  if (p.coingeckoData?.symbol) {
    result.symbol = p.coingeckoData.symbol
  }
  if (p.metrics?.usd24hChange != null) {
    result.usd24hChange = p.metrics.usd24hChange
  }

  // v1: full project details
  if (verbosity >= 1) {
    result.id = p.id
    result.description = p.description
    result.xHandle = p.xHandle
    result.popularityScore = p.popularityScore
    result.metrics = p.metrics
    result.tokens = p.tokens
    result.createdAt = p.createdAt
    result.updatedAt = p.updatedAt
    result.reinforcedAt = p.reinforcedAt
    delete result.symbol
    delete result.usd24hChange
    if (p.coingeckoData) {
      result.coingeckoData = {
        symbol: p.coingeckoData.symbol,
        categories: p.coingeckoData.categories,
      }
    }
  }

  // v2: signals without activity
  if (verbosity >= 2) {
    result.signals = p.signals?.map(s => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { activity: _activity, ...rest } = s
      return rest
    })
  }

  // v3: full signals with activity + full coingeckoData
  if (verbosity >= 3) {
    result.signals = p.signals
    if (p.coingeckoData) {
      result.coingeckoData = p.coingeckoData
    }
  }

  return result
}

