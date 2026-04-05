import type { Command } from 'commander'
import { getPublicClientOptions, getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { resolveDate } from '../lib/date.js'
import chalk from 'chalk'

interface GroundingSection {
  title: string
  items: string[]
  generatedAt?: string
}

interface GroundingData {
  createdAt: string
  windowHours: number
  sections: Record<string, GroundingSection>
}

interface PaginatedGroundingResponse {
  data: GroundingData[]
  pagination: {
    page: number
    limit: number
    totalCount: number
    hasMore: boolean
  }
}

// Preferred display order; unknown sections appear after in API order
const DISPLAY_ORDER = ['crypto', 'tradfi', 'macro', 'geopolitics']

// Known section colors; unknown sections get random colors from the palette
const KNOWN_COLORS: Record<string, (s: string) => string> = {
  crypto: chalk.hex('#b07de3'),
  tradfi: chalk.blue,
  macro: chalk.cyan,
  geopolitics: chalk.green,
}
const EXTRA_COLORS = [
  chalk.yellow, chalk.red, chalk.magentaBright,
  chalk.cyanBright, chalk.greenBright, chalk.blueBright,
]

/**
 * Display grounding sections with color-coded headers and bullet items.
 * Shared between handleGrounding and handleGroundingHistory.
 */
function displaySections(sections: Record<string, GroundingSection>): void {
  const apiKeys = Object.keys(sections)
  const orderedKeys = [
    ...DISPLAY_ORDER.filter(k => k in sections),
    ...apiKeys.filter(k => !DISPLAY_ORDER.includes(k)),
  ]

  let extraIdx = 0
  const getColor = (key: string) => {
    if (KNOWN_COLORS[key]) return KNOWN_COLORS[key]
    return EXTRA_COLORS[extraIdx++ % EXTRA_COLORS.length]
  }

  for (let i = 0; i < orderedKeys.length; i++) {
    const key = orderedKeys[i]
    const section = sections[key]
    if (!section) continue
    const color = getColor(key)

    if (i > 0) console.log()
    console.log(chalk.bold(color(section.title)))
    for (const item of section.items) {
      const wrapped = output.wrapIndented(item, '    ', 4)
      console.log(`  ${color('•')} ${wrapped}`)
    }
  }
}

export function registerGroundingCommand(program: Command): void {
  const grounding = program
    .command('grounding')
    .description('Get market grounding snapshot (free, no key required)')
    .option('--at <date>', 'Snapshot at a past time (ISO 8601 or relative: -24h, -7d)')
    .option('--sections <list>', 'Filter sections (comma-separated: crypto,macro,geopolitics,tradfi)')
    .option('--section <name>', 'Alias for --sections (single section)')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleGrounding(cmd)
    })

  // Hide --section from help output (it's a backward compat alias)
  const sectionOption = grounding.options.find(o => o.long === '--section')
  if (sectionOption) sectionOption.hidden = true

  grounding
    .command('history')
    .description('Get paginated grounding history (requires API key)')
    .option('--from <date>', 'Range start (ISO 8601 or relative: -7d, -48h)')
    .option('--to <date>', 'Range end (ISO 8601 or relative: -1h)')
    .option('--at <date>', 'Anchor timestamp (clamps --to)')
    .option('--sections <list>', 'Filter sections (comma-separated)')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page (max 50)', '50')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleGroundingHistory(cmd)
    })
}

async function handleGrounding(cmd: Command): Promise<void> {
  const { clientOpts, outputFormat } = getPublicClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  // Merge --section (singular, backward compat) with --sections (plural, CSV)
  const sectionsParam = opts.sections as string | undefined
    ?? opts.section as string | undefined

  const params: Record<string, string | number | boolean | undefined> = {
    at: resolveDate(opts.at as string | undefined),
    sections: sectionsParam,
  }

  const result = await output.withSpinner(
    'Fetching grounding...',
    outputFormat,
    () => get<GroundingData>('/v2/grounding/latest', params, clientOpts),
    'Failed to fetch grounding',
    { silent: true },
  )

  // Server handles section filtering — no client-side filtering needed
  const data = result.data

  if (output.isStructuredFormat(outputFormat)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { summary: _, ...groundingData } = data as unknown as Record<string, unknown>
    output.outputApiResult({ data: groundingData, meta: result.meta }, outputFormat)
    return
  }

  displaySections(data.sections)

  console.log()
  const agoMs = Date.now() - new Date(data.createdAt).getTime()
  const agoH = Math.floor(agoMs / 3600_000)
  const agoM = Math.floor((agoMs % 3600_000) / 60_000)
  const agoParts = agoH > 0 ? `${agoH}h ${agoM}m` : `${agoM}m`

  output.dim(`${agoParts} ago · refreshes hourly · ${data.windowHours}h window`)

  if (result.meta?.upgrade) {
    output.dim(`Grounding is free · For full API access: ${chalk.reset('aixbt login')}`)
  }
}

async function handleGroundingHistory(cmd: Command): Promise<void> {
  const { clientOpts, outputFormat } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    from: resolveDate(opts.from as string | undefined),
    to: resolveDate(opts.to as string | undefined),
    at: resolveDate(opts.at as string | undefined),
    sections: opts.sections as string | undefined,
    page: opts.page as string | undefined,
    limit: opts.limit as string | undefined,
  }

  const result = await output.withSpinner(
    'Fetching grounding history...',
    outputFormat,
    () => get<PaginatedGroundingResponse>(
      '/v2/grounding/history', params, clientOpts,
    ),
    'Failed to fetch grounding history',
    { silent: true },
  )

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult(result, outputFormat)
    return
  }

  const { data, pagination } = result.data as unknown as PaginatedGroundingResponse

  // Pagination header
  console.log(
    chalk.dim(`Page ${pagination.page} · ${pagination.totalCount} snapshots`)
    + (pagination.hasMore ? chalk.dim(' · --page ' + (pagination.page + 1) + ' for more') : ''),
  )
  console.log()

  // Display each snapshot with timestamp separator
  for (const snapshot of data) {
    const ts = new Date(snapshot.createdAt)
    console.log(chalk.dim('─── ') + chalk.bold(ts.toISOString()) + chalk.dim(' ───'))
    displaySections(snapshot.sections)
    console.log()
  }
}
