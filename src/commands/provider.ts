import { type Command } from 'commander'
import { isConcreteProvider, getKeyedTiers } from '../lib/providers/types.js'
import { resolveFormat } from '../lib/config.js'
import { getProviderNames, getProvider } from '../lib/providers/registry.js'
import { resolveProviderKey, saveProviderKey, removeProviderKey } from '../lib/providers/config.js'
import { providerRequest } from '../lib/providers/client.js'
import { CliError } from '../lib/errors.js'
import { registerProviderCommands } from './provider-commands.js'
import * as output from '../lib/output.js'

function getExternalProviderNames(): string[] {
  return getProviderNames().filter(n => n !== 'aixbt')
}

/** Concrete providers that accept API keys (excludes virtual providers like market, security, defi) */
function getConcreteProviderNames(): string[] {
  return getExternalProviderNames().filter(n => isConcreteProvider(getProvider(n)))
}

function validateConcreteProviderName(name: string): void {
  const validNames = getConcreteProviderNames()
  if (!validNames.includes(name)) {
    throw new CliError(
      `Unknown provider "${name}". Providers with API keys: ${validNames.join(', ')}`,
      'UNKNOWN_PROVIDER',
    )
  }
}

// -- Probe actions --

const PROBE_ACTIONS: Record<string, string> = {
  defillama: 'chains',
  coingecko: 'trending',
  goplus: 'supported-chains',
}

const FREE_PROBE_ACTIONS: Record<string, string> = {
  defillama: 'chains',
  coingecko: 'trending-pools',
  goplus: 'supported-chains',
}

// -- Command registration --

export function registerProviderCommand(program: Command): void {
  const providerCmd = program
    .command('provider')
    .description('External data providers — DeFiLlama, CoinGecko, GoPlus')
    .enablePositionalOptions()

  providerCmd.addHelpText('after', () => {
    const lines: string[] = ['']
    lines.push(`  ${output.fmt.dim('Environment variables:')}`)
    lines.push(`    COINGECKO_API_KEY, DEFILLAMA_API_KEY, GOPLUS_ACCESS_TOKEN`)
    lines.push('')
    return lines.join('\n')
  })

  // -- add --

  providerCmd
    .command('add <name>')
    .description('Add or update a provider API key')
    .requiredOption('--provider-key <key>', 'API key for the provider')
    .option('--tier <tier>', 'Key tier (provider-specific)')
    .option('--skip-verify', 'Skip API key verification probe')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const fmt = resolveFormat(globalOpts.format as string | undefined)

      validateConcreteProviderName(name)

      const provider = getProvider(name)
      const keyedTiers = getKeyedTiers(provider)

      // Reject keyless-only providers
      if (keyedTiers.length === 0) {
        throw new CliError(
          `${provider.displayName} does not accept API keys — it is fully keyless.`,
          'PROVIDER_KEYLESS',
        )
      }

      const apiKey = opts.providerKey as string
      const tierFlag = opts.tier as string | undefined
      const skipVerify = opts.skipVerify as boolean | undefined

      // Validate --tier flag if provided
      if (tierFlag && !keyedTiers.includes(tierFlag)) {
        throw new CliError(
          `Invalid tier "${tierFlag}" for ${provider.displayName}. Valid tiers: ${keyedTiers.join(', ')}`,
          'INVALID_TIER',
        )
      }

      // Auto-select when --tier is omitted
      let tier: string
      if (tierFlag) {
        tier = tierFlag
      } else if (keyedTiers.length === 1) {
        tier = keyedTiers[0]
      } else {
        throw new CliError(
          `${provider.displayName} has multiple tiers. Specify one with --tier: ${keyedTiers.join(', ')}`,
          'TIER_REQUIRED',
        )
      }

      // Probe unless skipped
      if (!skipVerify) {
        const probeActions = tier === 'free' ? FREE_PROBE_ACTIONS : PROBE_ACTIONS
        const probeAction = probeActions[name]
        if (probeAction) {
          await output.withSpinner(
            `Verifying ${provider.displayName} API key...`,
            fmt,
            () => providerRequest({
              provider,
              actionName: probeAction,
              params: {},
              apiKeyOverride: apiKey,
              tierOverride: tier,
            }),
            `${provider.displayName} API key verification failed`,
            { silent: true },
          )
        }
      }

      saveProviderKey(name, { apiKey, tier })

      if (output.isStructuredFormat(fmt)) {
        output.outputStructured({
          status: 'added',
          provider: name,
          tier,
          verified: !skipVerify,
        }, fmt)
      } else {
        output.success(`${name} provider configured (tier: ${tier})`)
      }
    })

  // -- list --

  providerCmd
    .command('list')
    .description('List all supported providers and their configuration status')
    .action((_opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const fmt = resolveFormat(globalOpts.format as string | undefined)

      const providers = getExternalProviderNames().map(n => getProvider(n))
      const rows = providers.map(p => {
        const resolved = resolveProviderKey(p)
        return {
          name: p.name,
          displayName: p.displayName,
          configured: !!resolved,
          tier: resolved?.tier ?? 'free',
          source: resolved?.source ?? 'default',
          actionCount: Object.keys(p.actions).length,
        }
      })

      if (output.isStructuredFormat(fmt)) {
        output.outputStructured(rows, fmt)
        return
      }

      output.table(rows as unknown as Record<string, unknown>[], [
        { key: 'name', header: 'Provider' },
        { key: 'displayName', header: 'Display Name' },
        {
          key: 'configured',
          header: 'Status',
          format: (v: unknown) => v ? output.fmt.green('configured') : output.fmt.dim('not set'),
        },
        {
          key: 'tier',
          header: 'Tier',
          format: (v: unknown) => v ? String(v) : output.fmt.dim('-'),
        },
        {
          key: 'source',
          header: 'Source',
          format: (v: unknown) => v ? String(v) : output.fmt.dim('-'),
        },
        {
          key: 'actionCount',
          header: 'Actions',
          align: 'right' as const,
        },
      ])
    })

  // -- remove --

  providerCmd
    .command('remove <name>')
    .description('Remove a stored provider API key')
    .action((name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const fmt = resolveFormat(globalOpts.format as string | undefined)

      validateConcreteProviderName(name)

      const removed = removeProviderKey(name)

      if (output.isStructuredFormat(fmt)) {
        output.outputStructured({
          status: removed ? 'removed' : 'not_found',
          provider: name,
        }, fmt)
      } else if (removed) {
        output.success(`${name} provider key removed`)
      } else {
        output.dim(`No stored key found for ${name}`)
      }
    })

  // -- test --

  providerCmd
    .command('test <name>')
    .description('Test a provider API connection with a probe request')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const fmt = resolveFormat(globalOpts.format as string | undefined)

      validateConcreteProviderName(name)

      const provider = getProvider(name)
      const resolved = resolveProviderKey(provider)
      const tier = resolved?.tier ?? 'free'

      const probeActions = tier === 'free' ? FREE_PROBE_ACTIONS : PROBE_ACTIONS
      const probeAction = probeActions[name]

      if (!probeAction) {
        throw new CliError(
          `No probe action defined for provider "${name}"`,
          'NO_PROBE_ACTION',
        )
      }

      const response = await output.withSpinner(
        `Testing ${provider.displayName} (${probeAction})...`,
        fmt,
        () => providerRequest({
          provider,
          actionName: probeAction,
          params: {},
          apiKeyOverride: resolved?.apiKey,
          tierOverride: tier,
        }),
        `${provider.displayName} probe failed`,
        { silent: true },
      )

      if (output.isStructuredFormat(fmt)) {
        output.outputStructured({
          status: 'ok',
          provider: name,
          tier,
          source: resolved?.source ?? 'none',
          probeAction,
          httpStatus: response.status,
        }, fmt)
      } else {
        output.success(`${provider.displayName} is reachable`)
        output.keyValue('Tier', tier, 18)
        output.keyValue('Source', resolved?.source ?? 'none (no key)', 18)
        output.keyValue('Probe action', probeAction, 18)
      }
    })

  // -- data commands (one subcommand group per provider) --

  for (const name of getExternalProviderNames()) {
    registerProviderCommands(providerCmd, getProvider(name))
  }
}
