import type { Command } from 'commander'
import type { SignalData } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'

// -- Table column definitions --

const SIGNAL_LIST_COLUMNS: output.TableColumn[] = [
  { key: 'projectName', header: 'Project', width: 18 },
  { key: 'category', header: 'Category', width: 20 },
  { key: 'description', header: 'Description', width: 40 },
  {
    key: 'reinforcedAt',
    header: 'Reinforced',
    width: 20,
    format: (v: unknown) => (typeof v === 'string' ? new Date(v).toLocaleDateString() : '-'),
  },
  { key: 'clusterNames', header: 'Clusters', width: 20 },
]

// -- Command registration --

export function registerSignalsCommand(program: Command): void {
  program
    .command('signals')
    .description('Query and filter AIXBT signals')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page', '20')
    .option('--project-ids <ids>', 'Filter by project IDs (comma-separated)')
    .option('--names <names>', 'Filter by project names (comma-separated)')
    .option('--x-handles <handles>', 'Filter by X handles (comma-separated)')
    .option('--tickers <tickers>', 'Filter by tickers (comma-separated)')
    .option('--address <address>', 'Filter by token address')
    .option('--cluster-ids <ids>', 'Filter by cluster IDs (comma-separated)')
    .option('--categories <cats>', 'Filter by categories (comma-separated)')
    .option('--detected-after <date>', 'Detected after date (ISO 8601)')
    .option('--detected-before <date>', 'Detected before date (ISO 8601)')
    .option('--reinforced-after <date>', 'Reinforced after date (ISO 8601)')
    .option('--reinforced-before <date>', 'Reinforced before date (ISO 8601)')
    .option('--sort-by <field>', 'Sort by field (reinforcedAt, createdAt)', 'reinforcedAt')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleSignalList(cmd)
    })
}

// -- Handlers --

async function handleSignalList(cmd: Command): Promise<void> {
  const { clientOpts, authMode, isJson } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    page: opts.page as string,
    limit: opts.limit as string,
    projectIds: opts.projectIds as string | undefined,
    names: opts.names as string | undefined,
    xHandles: opts.xHandles as string | undefined,
    tickers: opts.tickers as string | undefined,
    address: opts.address as string | undefined,
    clusterIds: opts.clusterIds as string | undefined,
    categories: opts.categories as string | undefined,
    detectedAfter: opts.detectedAfter as string | undefined,
    detectedBefore: opts.detectedBefore as string | undefined,
    reinforcedAfter: opts.reinforcedAfter as string | undefined,
    reinforcedBefore: opts.reinforcedBefore as string | undefined,
    sortBy: opts.sortBy as string,
  }

  const result = await output.withSpinner(
    'Fetching signals...',
    isJson,
    () => withPayPerUse(
      () => get<SignalData[]>('/v2/signals', params, clientOpts),
      authMode,
      reconstructCommand('aixbt signals', opts),
      isJson,
    ),
    'Failed to fetch signals',
  )

  if (isJson) {
    output.json(result.data)
    return
  }

  const rows = result.data.map((s) => ({
    projectName: s.projectName,
    category: s.category,
    description: s.description,
    reinforcedAt: s.reinforcedAt,
    clusterNames: s.clusters.map((c) => c.name).join(', '),
  }))

  output.table(rows, SIGNAL_LIST_COLUMNS)
  output.showPagination(result.pagination)
}
