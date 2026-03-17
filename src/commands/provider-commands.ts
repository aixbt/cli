import type { Command } from 'commander'
import type { Provider, ActionDefinition, ActionParam } from '../lib/providers/types.js'
import type { TableColumn, CardItem } from '../lib/output.js'
import { resolveFormat } from '../lib/config.js'
import { providerRequest } from '../lib/providers/client.js'
import * as output from '../lib/output.js'

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  defillama:
    'DeFi protocol analytics — TVL rankings, chain breakdowns, protocol deep-dives, ' +
    'token emission schedules, and yield/APY data. 5 free actions (60 req/min), ' +
    '2 pro actions (emissions, yields) require a DeFiLlama API key (120 req/min).',
  coingecko:
    'Market data and on-chain DEX analytics — prices, market rankings, OHLC candles, ' +
    'coin details, categories, pool liquidity, and trending tokens. 4 free actions ' +
    'via GeckoTerminal (30 req/min), 6 actions require a CoinGecko demo key or above.',
  goplus:
    'Token and contract security analysis — detect honeypots, rug pulls, malicious ' +
    'permissions, phishing sites, and approval risks across EVM, Solana, and Sui. ' +
    'All 8 actions are free (30 req/min, 120 with API key).',
}

/**
 * Register a CLI command group for a provider.
 * Creates one subcommand per action.
 */
export function registerProviderCommands(program: Command, provider: Provider): void {
  const description = PROVIDER_DESCRIPTIONS[provider.name] ?? `${provider.displayName} data provider`
  const group = program
    .command(provider.name)
    .description(description)
    .configureHelp({
      visibleCommands: () => [],
    })

  group.addHelpText('after', () => {
    const lines: string[] = ['', `${output.fmt.boldWhite('Actions:')}`, '']
    for (const [name, action] of Object.entries(provider.actions)) {
      const tierBadge = action.minTier !== 'free' ? ` ${output.fmt.dim(`[${action.minTier}]`)}` : ''
      lines.push(`  ${output.fmt.brandBold(name)}${tierBadge}`)
      lines.push(`    ${action.description}`)
      if (action.hint) {
        lines.push(`    ${output.fmt.dim(`Use when: ${action.hint}`)}`)
      }
      if (action.params.length > 0) {
        const paramDescs = action.params.map(p => {
          const req = p.required ? output.fmt.red('*') : ''
          return `${p.name}${req}`
        })
        lines.push(`    ${output.fmt.dim('Params:')} ${paramDescs.join(', ')}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  })

  // Register one subcommand per action
  for (const [actionName, action] of Object.entries(provider.actions)) {
    registerActionSubcommand(group, provider, actionName, action)
  }
}

function registerActionSubcommand(
  group: Command,
  provider: Provider,
  actionName: string,
  action: ActionDefinition,
): void {
  // Build the command signature with positional args for path params
  const pathParams = action.params.filter(p => p.inPath && p.required)
  const positionalParts = pathParams.map(p => `<${p.name}>`)
  const cmdSignature = positionalParts.length > 0
    ? `${actionName} ${positionalParts.join(' ')}`
    : actionName

  const cmd = group
    .command(cmdSignature)
    .description(action.description)

  // Register non-path params as options
  for (const param of action.params) {
    if (param.inPath && param.required) continue // already a positional arg
    if (param.required) {
      cmd.requiredOption(`--${param.name} <value>`, param.description)
    } else {
      cmd.option(`--${param.name} <value>`, param.description)
    }
  }

  // Provider key override
  cmd.option('--provider-key <key>', `API key override for ${provider.displayName}`)

  // After-help hint
  if (action.hint) {
    cmd.addHelpText('after', `\n  Use when: ${action.hint}\n`)
  }

  cmd.action(async (...args: unknown[]) => {
    // Commander passes (pathArg1, pathArg2, ..., opts, cmd)
    const cmdObj = args[args.length - 1] as Command
    const opts = args[args.length - 2] as Record<string, unknown>
    const globalOpts = cmdObj.optsWithGlobals()
    const fmt = resolveFormat(globalOpts.format as string | undefined)

    // Collect params
    const params: Record<string, string | number | boolean | undefined> = {}

    // Path params from positional args
    for (let i = 0; i < pathParams.length; i++) {
      params[pathParams[i].name] = args[i] as string
    }

    // Non-path params from options
    for (const param of action.params) {
      if (param.inPath && param.required) continue
      const val = opts[camelCase(param.name)] as string | undefined
      if (val !== undefined) {
        params[param.name] = val
      }
    }

    const providerKeyOverride = opts.providerKey as string | undefined

    const response = await output.withSpinner(
      `${provider.displayName}: ${actionName}`,
      fmt,
      () => providerRequest({
        provider,
        actionName,
        params,
        apiKeyOverride: providerKeyOverride,
      }),
      `${provider.displayName}: ${actionName} failed`,
      { silent: true },
    )

    if (output.isStructuredFormat(fmt)) {
      output.outputStructured({ data: response.data }, fmt)
      return
    }

    renderHumanOutput(response.data, globalOpts.verbose as number | undefined)
  })
}

/**
 * Render data in human-readable format with auto-detection.
 */
function renderHumanOutput(
  data: unknown,
  verbose?: number,
): void {
  if (data === null || data === undefined) {
    output.dim('No data returned.')
    return
  }

  if (typeof data !== 'object') {
    console.log(String(data))
    return
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      output.dim('No results.')
      return
    }

    // Arrays with 4+ items -> table; small arrays or verbose -> cards
    if (data.length >= 4 && !verbose) {
      const columns = deriveTableColumns(data)
      if (columns.length > 0) {
        output.table(data as Record<string, unknown>[], columns)
        return
      }
    }

    // Cards for small arrays or verbose
    const cards = data.map((item, i) => itemToCard(item, i))
    output.cards(cards)
    return
  }

  // Single object -> card
  const cards = [itemToCard(data, 0)]
  output.cards(cards)
}

/**
 * Auto-derive up to 5 scalar columns from the first few items in an array.
 */
function deriveTableColumns(data: unknown[]): TableColumn[] {
  const sample = data.slice(0, 5)
  const keyCounts = new Map<string, number>()

  for (const item of sample) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
      if (isScalar(val)) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
      }
    }
  }

  // Pick the keys that appear in at least half the sample, up to 5
  const threshold = Math.ceil(sample.length / 2)
  const columns: TableColumn[] = []

  for (const [key, count] of keyCounts) {
    if (count >= threshold && columns.length < 5) {
      columns.push({
        key,
        header: key,
        format: (v: unknown) => formatScalar(v),
      })
    }
  }

  return columns
}

function isScalar(val: unknown): boolean {
  return val === null || val === undefined || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
}

function formatScalar(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Math.abs(val) > 1_000_000) {
      return output.formatLargeNumber(val)
    }
    return String(val)
  }
  return String(val)
}

function itemToCard(item: unknown, index: number): CardItem {
  if (typeof item !== 'object' || item === null) {
    return {
      title: `Item ${index + 1}`,
      fields: [{ label: 'value', value: String(item) }],
    }
  }

  const obj = item as Record<string, unknown>
  const titleKey = findTitleKey(obj)
  const title = titleKey ? String(obj[titleKey]) : `Item ${index + 1}`

  const fields = Object.entries(obj)
    .filter(([key]) => key !== titleKey)
    .filter(([, val]) => isScalar(val) || (typeof val === 'string'))
    .slice(0, 12)
    .map(([key, val]) => ({
      label: key,
      value: formatScalar(val),
    }))

  return { title, fields }
}

function findTitleKey(obj: Record<string, unknown>): string | undefined {
  const candidates = ['name', 'id', 'title', 'symbol', 'slug']
  for (const key of candidates) {
    if (typeof obj[key] === 'string' && obj[key]) return key
  }
  return undefined
}

/**
 * Convert kebab-case or snake_case option name to camelCase
 * (Commander auto-converts option flags to camelCase).
 */
function camelCase(name: string): string {
  return name.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
}
