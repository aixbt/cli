import type { Command } from 'commander'
import type { SignalData } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'

export function registerSignalsCommand(program: Command): void {
  program
    .command('signals')
    .description('Query and filter AIXBT signals')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page')
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

function buildBadges(s: SignalData): string | undefined {
  const badges: string[] = []
  if ((s.clusters?.length ?? 0) >= 3) {
    badges.push(output.fmt.red('[HOT]'))
  }
  if (s.hasOfficialSource) {
    badges.push(output.fmt.green('[OFFICIAL]'))
  }
  return badges.length > 0 ? badges.join(' ') : undefined
}

async function handleSignalList(cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat, full, limit } = getClientOptions(cmd)
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
    detectedAfter: opts.detectedAfter as string | undefined,
    detectedBefore: opts.detectedBefore as string | undefined,
    reinforcedAfter: opts.reinforcedAfter as string | undefined,
    reinforcedBefore: opts.reinforcedBefore as string | undefined,
    sortBy: opts.sortBy as string,
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

  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured(result.data, outputFormat)
    return
  }

  if (full) {
    output.cards(result.data.map((s) => ({
      title: s.projectName,
      subtitle: s.category,
      badge: buildBadges(s),
      fields: [
        { label: 'ID', value: s.id },
        { label: 'Description', value: s.description },
        { label: 'Detected', value: new Date(s.detectedAt).toLocaleString() },
        { label: 'Reinforced', value: new Date(s.reinforcedAt).toLocaleString() },
        { label: 'Clusters', value: s.clusters?.map(c => c.name).join(', ') || 'none' },
        { label: 'Project ID', value: s.projectId },
        { label: 'Official', value: s.hasOfficialSource ? 'Yes' : 'No' },
        { label: 'Activity', value: s.activity.length > 0 ? `${s.activity.length} entries` : undefined },
      ],
    })))
    output.showPagination(result.pagination)
    return
  }

  output.cards(result.data.map((s) => ({
    title: s.projectName,
    subtitle: s.category,
    badge: buildBadges(s),
    fields: [
      { label: 'Description', value: s.description },
      { label: 'Detected', value: new Date(s.detectedAt).toLocaleString() },
      { label: 'Reinforced', value: new Date(s.reinforcedAt).toLocaleString() },
      {
        label: 'Clusters',
        value: (s.clusters?.length ?? 0) > 0
          ? `${s.clusters.length} cluster${s.clusters.length !== 1 ? 's' : ''}`
          : undefined,
      },
    ],
  })))

  output.showPagination(result.pagination)
  output.fullHint()
}
