import type { Command } from 'commander'
import { getPublicClientOptions } from '../lib/auth.js'
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

export function registerGroundingCommand(program: Command): void {
  program
    .command('grounding')
    .description('Get market grounding snapshot (free, no key required)')
    .option('--at <date>', 'Snapshot at a past time (ISO 8601 or relative: -24h, -7d)')
    .option('--section <name>', 'Show only a specific section (e.g., narratives, macro, geopolitics, tradfi)')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleGrounding(cmd)
    })
}

async function handleGrounding(cmd: Command): Promise<void> {
  const { clientOpts, outputFormat } = getPublicClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | number | boolean | undefined> = {
    at: resolveDate(opts.at as string | undefined),
  }

  const result = await output.withSpinner(
    'Fetching grounding...',
    outputFormat,
    () => get<GroundingData>('/v2/grounding/latest', params, clientOpts),
    'Failed to fetch grounding',
    { silent: true },
  )

  const sectionFilter = opts.section as string | undefined
  const data = result.data

  // Filter to a single section if --section specified
  if (sectionFilter) {
    const key = sectionFilter.toLowerCase()
    if (!data.sections[key]) {
      const available = Object.keys(data.sections).join(', ')
      console.error(`Unknown section "${sectionFilter}". Available: ${available}`)
      process.exit(1)
    }
    data.sections = { [key]: data.sections[key] }
  }

  if (output.isStructuredFormat(outputFormat)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { summary: _, ...groundingData } = data as unknown as Record<string, unknown>
    output.outputApiResult({ data: groundingData, meta: result.meta }, outputFormat)
    return
  }

  // Preferred display order; unknown sections appear after in API order
  const displayOrder = ['crypto', 'tradfi', 'macro', 'geopolitics']
  const apiKeys = Object.keys(data.sections)
  const orderedKeys = [
    ...displayOrder.filter(k => k in data.sections),
    ...apiKeys.filter(k => !displayOrder.includes(k)),
  ]

  // Known section colors; unknown sections get random colors from the palette
  const knownColors: Record<string, (s: string) => string> = {
    crypto: chalk.hex('#b07de3'),
    tradfi: chalk.blue,
    macro: chalk.cyan,
    geopolitics: chalk.green,
  }
  const extraColors = [
    chalk.yellow, chalk.red, chalk.magentaBright,
    chalk.cyanBright, chalk.greenBright, chalk.blueBright,
  ]
  let extraIdx = 0
  const getColor = (key: string) => {
    if (knownColors[key]) return knownColors[key]
    return extraColors[extraIdx++ % extraColors.length]
  }

  for (let i = 0; i < orderedKeys.length; i++) {
    const key = orderedKeys[i]
    const section = data.sections[key]
    if (!section) continue
    const color = getColor(key)

    if (i > 0) console.log()
    console.log(chalk.bold(color(section.title)))
    for (const item of section.items) {
      const wrapped = output.wrapIndented(item, '    ', 4)
      console.log(`  ${color('•')} ${wrapped}`)
    }
  }

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
