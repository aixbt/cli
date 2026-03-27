import type { Command } from 'commander'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { withPayPerUse, reconstructCommand } from '../lib/x402.js'
import { resolveDate } from '../lib/date.js'

interface GroundingSection {
  title: string
  items: string[]
  generatedAt?: string
}

interface GroundingData {
  createdAt: string
  windowHours: number
  sections: {
    narratives: GroundingSection
    macro: GroundingSection
    geopolitics: GroundingSection
  }
}

export function registerGroundingCommand(program: Command): void {
  program
    .command('grounding')
    .description('Get market grounding snapshot (narratives, macro, geopolitics)')
    .option('--at <date>', 'Historical timestamp (ISO 8601 or relative: -24h, -7d)')
    .action(async (_opts: unknown, cmd: Command) => {
      await handleGrounding(cmd)
    })
}

async function handleGrounding(cmd: Command): Promise<void> {
  const { clientOpts, authMode, outputFormat } = getClientOptions(cmd)
  const opts = cmd.optsWithGlobals()

  const params: Record<string, string | undefined> = {
    at: resolveDate(opts.at as string | undefined),
  }

  const result = await output.withSpinner(
    'Fetching grounding...',
    outputFormat,
    () => withPayPerUse(
      () => get<GroundingData>('/v2/grounding/latest', params, clientOpts),
      authMode,
      reconstructCommand('aixbt grounding', opts),
      outputFormat,
    ),
    'Failed to fetch grounding',
    { silent: true },
  )

  if (output.isStructuredFormat(outputFormat)) {
    output.outputApiResult({ data: result.data, meta: result.meta }, outputFormat)
    return
  }

  // Human output
  const data = result.data
  const sectionOrder: (keyof typeof data.sections)[] = ['narratives', 'macro', 'geopolitics']

  for (let i = 0; i < sectionOrder.length; i++) {
    const key = sectionOrder[i]
    const section = data.sections[key]
    if (!section) continue

    if (i > 0) console.log()
    console.log(output.fmt.boldWhite(section.title))
    for (const item of section.items) {
      console.log(`  ${output.fmt.dim('•')} ${item}`)
    }
  }

  console.log()
  output.dim(`Refreshed every ${data.windowHours} hours`)
}
