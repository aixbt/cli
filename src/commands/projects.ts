import type { Command } from 'commander'
import type { SignalData } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'

// -- Response types --

interface ProjectData {
  id: string
  name: string
  description?: string
  rationale?: string
  xHandle?: string
  momentumScore?: number
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

// -- Table column definitions --

const PROJECT_LIST_COLUMNS: output.TableColumn[] = [
  { key: 'name', header: 'Name', width: 22 },
  {
    key: 'momentumScore',
    header: 'Momentum',
    width: 10,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '-'),
  },
  {
    key: 'popularityScore',
    header: 'Pop',
    width: 5,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? String(v) : '-'),
  },
  {
    key: 'xHandle',
    header: 'X Handle',
    width: 18,
    format: (v: unknown) => (v ? `@${v}` : '-'),
  },
  {
    key: 'signalCount',
    header: 'Signals',
    width: 8,
    align: 'right' as const,
    format: (v: unknown) => String(v ?? 0),
  },
]

const MOMENTUM_COLUMNS: output.TableColumn[] = [
  { key: 'timestamp', header: 'Time', width: 22 },
  {
    key: 'score',
    header: 'Score',
    width: 8,
    align: 'right' as const,
    format: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : '-'),
  },
  { key: 'topCluster', header: 'Top Cluster', width: 20 },
  { key: 'mentions', header: 'Mentions', width: 10, align: 'right' as const },
]

// -- Command registration --

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command('projects')
    .description('List and search AIXBT projects')
    .argument('[id]', 'Project ID to get details for')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page', '20')
    .option('--project-ids <ids>', 'Filter by project IDs (comma-separated)')
    .option('--names <names>', 'Filter by project names (comma-separated)')
    .option('--x-handles <handles>', 'Filter by X handles (comma-separated)')
    .option('--tickers <tickers>', 'Filter by tickers (comma-separated)')
    .option('--chain <chain>', 'Filter by chain')
    .option('--address <address>', 'Filter by token address')
    .option('--min-momentum <score>', 'Minimum momentum score')
    .option('--sort-by <field>', 'Sort by field', 'momentumScore')
    .option('--has-token [bool]', 'Filter projects with/without tokens')
    .option('--exclude-stables', 'Exclude stablecoins')
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
    .option('--start <date>', 'Start date (ISO 8601)')
    .option('--end <date>', 'End date (ISO 8601)')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await handleMomentum(id, cmd)
    })
}

// -- Handlers --

async function handleProjectList(cmd: Command): Promise<void> {
  const { clientOpts, authMode, isJson } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    page: opts.page as string,
    limit: opts.limit as string,
    projectIds: opts.projectIds as string | undefined,
    names: opts.names as string | undefined,
    xHandles: opts.xHandles as string | undefined,
    tickers: opts.tickers as string | undefined,
    chain: opts.chain as string | undefined,
    address: opts.address as string | undefined,
    minMomentum: opts.minMomentum as string | undefined,
    sortBy: opts.sortBy as string,
    hasToken: opts.hasToken as string | undefined,
    excludeStables: opts.excludeStables ? 'true' : undefined,
  }

  const result = await output.withSpinner(
    'Fetching projects...',
    isJson,
    () => withPayPerUse(
      () => get<ProjectData[]>('/v2/projects', params, clientOpts),
      authMode,
      reconstructCommand('aixbt projects', opts),
      isJson,
    ),
    'Failed to fetch projects',
  )

  if (isJson) {
    output.json(result.data)
    return
  }

  const rows = result.data.map((p) => ({
    name: p.name,
    momentumScore: p.momentumScore,
    popularityScore: p.popularityScore,
    xHandle: p.xHandle,
    signalCount: p.signals?.length ?? 0,
  }))

  output.table(rows, PROJECT_LIST_COLUMNS)
  output.showPagination(result.pagination)
}

async function handleProjectDetail(id: string, cmd: Command): Promise<void> {
  const { clientOpts, authMode, isJson } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const result = await output.withSpinner(
    'Fetching project...',
    isJson,
    () => withPayPerUse(
      () => get<ProjectData>(`/v2/projects/${encodeURIComponent(id)}`, undefined, clientOpts),
      authMode,
      reconstructCommand(`aixbt projects ${id}`, opts),
      isJson,
    ),
    'Failed to fetch project',
  )

  const project = result.data

  if (isJson) {
    output.json(project)
    return
  }

  // Header
  output.label('Project', project.name)
  console.log()

  // Basic info
  output.keyValue('ID', project.id)
  if (project.xHandle) output.keyValue('X Handle', `@${project.xHandle}`)
  if (project.description) output.keyValue('Description', project.description)
  if (project.rationale) output.keyValue('Rationale', project.rationale)
  if (typeof project.momentumScore === 'number') output.keyValue('Momentum', project.momentumScore.toFixed(2))
  if (typeof project.popularityScore === 'number') output.keyValue('Popularity', String(project.popularityScore))

  // Metrics
  if (project.metrics) {
    const m = project.metrics
    console.log()
    output.label('Metrics', '')
    if (typeof m.usd === 'number') output.keyValue('Price (USD)', `$${m.usd.toFixed(6)}`)
    if (typeof m.usdMarketCap === 'number') output.keyValue('Market Cap', `$${formatLargeNumber(m.usdMarketCap)}`)
    if (typeof m.usd24hVol === 'number') output.keyValue('24h Volume', `$${formatLargeNumber(m.usd24hVol)}`)
    if (typeof m.usd24hChange === 'number') output.keyValue('24h Change', `${m.usd24hChange >= 0 ? '+' : ''}${m.usd24hChange.toFixed(2)}%`)
  }

  // Tokens
  if (project.tokens && project.tokens.length > 0) {
    console.log()
    output.label('Tokens', '')
    for (const token of project.tokens) {
      output.keyValue(token.chain, token.address)
    }
  }

  // CoinGecko info
  if (project.coingeckoData) {
    console.log()
    output.label('CoinGecko', '')
    output.keyValue('Symbol', project.coingeckoData.symbol)
    if (project.coingeckoData.categories.length > 0) {
      output.keyValue('Categories', project.coingeckoData.categories.join(', '))
    }
  }

  // Recent signals
  if (project.signals && project.signals.length > 0) {
    console.log()
    output.label('Recent Signals', `(${project.signals.length})`)
    for (const signal of project.signals.slice(0, 5)) {
      output.dim(`  [${signal.category}] ${signal.description.slice(0, 80)}${signal.description.length > 80 ? '...' : ''}`)
    }
    if (project.signals.length > 5) {
      output.dim(`  ... and ${project.signals.length - 5} more`)
    }
  }

  // Timestamps
  console.log()
  if (project.createdAt) output.keyValue('Created', new Date(project.createdAt).toLocaleString())
  if (project.updatedAt) output.keyValue('Updated', new Date(project.updatedAt).toLocaleString())
  if (project.reinforcedAt) output.keyValue('Reinforced', new Date(project.reinforcedAt).toLocaleString())
}

async function handleMomentum(id: string, cmd: Command): Promise<void> {
  const { clientOpts, authMode, isJson } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    start: opts.start as string | undefined,
    end: opts.end as string | undefined,
  }

  const result = await output.withSpinner(
    'Fetching momentum history...',
    isJson,
    () => withPayPerUse(
      () => get<MomentumData>(`/v2/projects/${encodeURIComponent(id)}/momentum`, params, clientOpts),
      authMode,
      reconstructCommand(`aixbt projects momentum ${id}`, opts),
      isJson,
    ),
    'Failed to fetch momentum',
  )

  const momentum = result.data

  if (isJson) {
    output.json(momentum)
    return
  }

  output.label('Momentum History', momentum.projectName)
  console.log()

  if (!momentum.data || momentum.data.length === 0) {
    output.dim('No momentum data available.')
    return
  }

  // Show last 10 data points
  const rows = momentum.data.slice(-10).map((point) => {
    const topCluster =
      point.clusters.length > 0
        ? point.clusters.reduce((a, b) => (a.count > b.count ? a : b))
        : null

    return {
      timestamp: new Date(point.timestamp).toLocaleString(),
      score: point.momentumScore,
      topCluster: topCluster ? topCluster.name : '-',
      mentions: topCluster ? String(topCluster.count) : '-',
    }
  })

  output.table(rows, MOMENTUM_COLUMNS)
}

async function handleChains(cmd: Command): Promise<void> {
  const { clientOpts, authMode, isJson } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const result = await output.withSpinner(
    'Fetching chains...',
    isJson,
    () => withPayPerUse(
      () => get<string[]>('/v2/projects/chains', undefined, clientOpts),
      authMode,
      reconstructCommand('aixbt projects chains', opts),
      isJson,
    ),
    'Failed to fetch chains',
  )

  const chains = result.data

  if (isJson) {
    output.json(chains)
    return
  }

  if (chains.length === 0) {
    output.dim('No chains available.')
    return
  }

  for (const chain of chains) {
    console.log(`  ${chain}`)
  }
  console.log()
  output.dim(`${chains.length} chain${chains.length === 1 ? '' : 's'} available`)
}

// -- Utility --

function formatLargeNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return n.toFixed(2)
}
