import type { Command } from 'commander'
import type { SignalData } from '../types.js'
import { getClientOptions, getPublicClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'
import { formatTokenCount } from '../lib/tokens.js'
import { resolveDate } from '../lib/date.js'

interface ClusterData {
  id: string
  name: string
  description: string
}

interface SignalCategoryData {
  id: string
  name: string
  description: string
}

export function registerSignalsCommand(program: Command): void {
  const signals = program
    .command('signals')
    .description('Query real-time signal intelligence')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page')
    .option('--project-ids <ids>', 'Filter by project IDs (comma-separated)')
    .option('--names <names>', 'Filter by project names (comma-separated)')
    .option('--x-handles <handles>', 'Filter by X handles (comma-separated)')
    .option('--tickers <tickers>', 'Filter by tickers (comma-separated)')
    .option('--address <address>', 'Filter by token address')
    .option('--cluster-ids <ids>', 'Filter by cluster IDs (comma-separated)')
    .option('--categories <cats>', 'Filter by categories (comma-separated)')
    .option('--detected-after <date>', 'Detected after date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--detected-before <date>', 'Detected before date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--reinforced-after <date>', 'Reinforced after date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--reinforced-before <date>', 'Reinforced before date (ISO 8601 or relative: -7d, -24h, -30m)')
    .option('--official', 'Show only signals with official sources')
    .option('--sort-by <field>', 'Sort by field (createdAt, reinforcedAt)', 'createdAt')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleSignalList(cmd)
    })

  signals
    .command('clusters')
    .description('List signal clusters with IDs and names (-v for descriptions)')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleClusters(cmd)
    })

  signals
    .command('categories')
    .description('List available signal categories')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleCategories(cmd)
    })
}

function buildBadges(s: SignalData): string | undefined {
  const badges: string[] = []
  if ((s.clusters?.length ?? 0) >= 3) {
    badges.push(output.fmt.tag('HOT', '#e05b73'))
  }
  if (s.hasOfficialSource) {
    badges.push(output.fmt.tag('OFFICIAL', '#87ceeb'))
  }
  return badges.length > 0 ? badges.join(' ') : undefined
}

async function handleSignalList(cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat, verbosity, limit } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    page: opts.page as string,
    limit,
    projectIds: opts.projectIds as string | undefined,
    names: opts.names as string | undefined,
    xHandles: opts.xHandles as string | undefined,
    tickers: opts.tickers as string | undefined,
    address: opts.address as string | undefined,
    clusterIds: opts.clusterIds as string | undefined,
    categories: opts.categories as string | undefined,
    detectedAfter: resolveDate(opts.detectedAfter as string | undefined),
    detectedBefore: resolveDate(opts.detectedBefore as string | undefined),
    reinforcedAfter: resolveDate(opts.reinforcedAfter as string | undefined),
    reinforcedBefore: resolveDate(opts.reinforcedBefore as string | undefined),
    sortBy: opts.sortBy as string,
    hasOfficialSource: opts.official ? true : undefined,
  }

  const result = await output.withSpinner(
    'Fetching signals...',
    outputFormat,
    () => withPayPerUse(
      () => get<SignalData[]>('/v2/signals', params, clientOpts),
      authMode,
      reconstructCommand('aixbt signals', opts),
      outputFormat,
    ),
    'Failed to fetch signals',
    { silent: true },
  )

  const hints: string[] = []
  if (verbosity < 1) hints.push('Use -v for activity details')
  hints.push('For pipeline analysis, try: aixbt recipe run signal_scanner -f toon')
  if (verbosity >= 2 && result.data.length > 0) {
    hints.push(`Output: ~${formatTokenCount(result.data)} tokens. In recipes, use transform: to control what reaches agents.`)
  }

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: result.data.map(s => filterSignalFields(s, verbosity)), meta: result.meta, hints }, outputFormat)
    return
  }

  // Build stable cluster color map across all signals
  const clusterColorMap = output.buildClusterColorMap(result.data)

  for (let i = 0; i < result.data.length; i++) {
    const s = result.data[i]
    if (i > 0) console.log()

    // Title line: name  CATEGORY  [HOT] [OFFICIAL]
    const badge = buildBadges(s)
    const badgePart = badge ? ` ${badge}` : ''
    console.log(`${output.fmt.boldWhite(s.projectName)}  ${output.fmt.tag(s.category || 'UNCATEGORIZED')}${badgePart}`)

    // Description
    console.log(s.description)

    // Meta line
    const updates = s.activity?.length ?? 0
    console.log(output.fmt.dim(`Detected ${output.timeAgo(s.detectedAt)} · Reinforced ${output.timeAgo(s.reinforcedAt)} · ${updates} update${updates !== 1 ? 's' : ''}`))

    // Cluster dots
    const clusterTags = (s.clusters ?? []).map(c =>
      `${output.clusterDot(clusterColorMap.get(c.id) ?? 0, c.name)} ${output.fmt.dim(c.name)}`,
    ).join('  ')
    if (clusterTags) console.log(clusterTags)

    // Activity (verbose)
    if (verbosity >= 1 && (s.activity?.length ?? 0) > 1) {
      console.log(output.fmt.boldWhite('activity'))
      const entries = output.formatActivity(s.activity, clusterColorMap)
      for (let j = 0; j < entries.length; j++) {
        if (j > 0) console.log()
        console.log(entries[j])
      }
    }
  }

  console.log()
  output.showPagination(result.pagination, result.data.length)

  output.printHints(hints)
}

async function handleClusters(cmd: Command): Promise<void> {
  const { clientOpts, outputFormat, verbosity } = getPublicClientOptions(cmd)

  const result = await output.withSpinner(
    'Fetching clusters...',
    outputFormat,
    () => get<ClusterData[]>('/v2/clusters', undefined, clientOpts),
    'Failed to fetch clusters',
    { silent: true },
  )

  const hints: string[] = []
  if (verbosity < 1) hints.push('Use -v for cluster descriptions')

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: result.data, meta: result.meta, hints }, outputFormat)
    return
  }

  output.cards(result.data.map((c) => ({
    title: c.name,
    fields: [
      { label: 'ID', value: output.fmt.id(c.id) },
      ...(verbosity >= 1 ? [{ label: 'Description', value: c.description }] : []),
    ],
  })))

  if (result.data.length > 0) {
    console.log()
    output.dim(`${result.data.length} clusters`)
  }

  output.printHints(hints)
}

const CATEGORY_COLUMNS: output.TableColumn[] = [
  { key: 'name', header: 'Category', width: 24 },
  { key: 'description', header: 'Description' },
]

async function handleCategories(cmd: Command): Promise<void> {
  const { clientOpts, outputFormat } = getPublicClientOptions(cmd)

  const result = await output.withSpinner(
    'Fetching categories...',
    outputFormat,
    () => get<SignalCategoryData[]>('/v2/signal-categories', undefined, clientOpts),
    'Failed to fetch categories',
    { silent: true },
  )

  const categories = result.data

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: categories, meta: result.meta }, outputFormat)
    return
  }

  if (categories.length === 0) {
    output.dim('No categories available.')
    return
  }

  const rows = categories.map((c) => ({
    name: c.name,
    description: c.description,
  }))

  output.table(rows, CATEGORY_COLUMNS)
  console.log()
  output.dim(`${categories.length} ${categories.length === 1 ? 'category' : 'categories'}`)
}

function filterSignalFields(s: SignalData, verbosity: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    projectName: s.projectName,
    category: s.category,
    description: s.description,
    detectedAt: s.detectedAt,
    reinforcedAt: s.reinforcedAt,
    clusterCount: s.clusters?.length ?? 0,
  }

  // v1: + identifiers, full clusters, official source, activity
  if (verbosity >= 1) {
    result.id = s.id
    result.projectId = s.projectId
    result.clusters = s.clusters
    result.hasOfficialSource = s.hasOfficialSource
    result.activity = s.activity
    delete result.clusterCount
  }

  return result
}
