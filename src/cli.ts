#!/usr/bin/env node

import chalk from 'chalk'
import updateNotifier from 'update-notifier'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import { registerProjectsCommand } from './commands/projects.js'
import { registerIntelCommand } from './commands/intel.js'
import { registerSignalsCommand } from './commands/signals.js'
import { registerGroundingCommand } from './commands/grounding.js'
// clusters is now a subcommand of signals — see signals.ts
import { registerRecipeCommand } from './commands/recipe.js'
import { registerLoginCommand } from './commands/login.js'
import { registerProviderCommand } from './commands/provider.js'

import type { OutputFormat } from './lib/output.js'
import * as output from './lib/output.js'
import { handleTopLevelError } from './lib/errors.js'
import { resolveFormat, detectAllKeys } from './lib/config.js'
import { isExpired, isExpiringSoon, formatTimeRemaining } from './lib/auth.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export function createProgram(): Command {
  const program = new Command()

  const VALID_FORMATS = ['human', 'json', 'toon']
  const formatOption = new Option(
    '-f, --format <mode>',
    'Output format: human (default), json, toon',
  ).argParser((val: string) => {
    if (!VALID_FORMATS.includes(val)) {
      throw new Error(`Invalid format '${val}'. Choose from: ${VALID_FORMATS.join(', ')}`)
    }
    return val
  })

  program
    .name('aixbt')
    .description('')
    .version(pkg.version, '-V, --version')
    .addHelpText('before', output.banner(pkg.version))
    .addHelpText('after', () => {
      const keys = detectAllKeys()
      const lines: string[] = []
      const title = ' FOR AI AGENTS: '
      const maxWidth = Math.min(process.stdout.columns || 76, 76)
      const tail = Math.max(0, maxWidth - 1 - title.length)
      lines.push(output.fmt.dim('━' + title + '━'.repeat(tail)))
      lines.push('')
      lines.push('  AIXBT provides real-time crypto signal intelligence. Find alpha, research')
      lines.push('  projects, inform trades, and gain an edge in the market.')
      lines.push('')
      lines.push('  Start with aixbt recipe list to find analysis pipelines for your task.')
      lines.push('  For ad-hoc queries, use intel and projects with -f toon.')
      lines.push('  Full command reference: aixbt help all')
      lines.push('')
      lines.push(`  ${output.fmt.dim('docs.aixbt.tech/builders/cli.mdx')}`)
      lines.push('')
      lines.push(output.fmt.dim('━'.repeat(maxWidth)))
      if (keys.length === 0) {
        lines.push(chalk.red('no API key') + ' · run aixbt login or visit docs.aixbt.tech')
      } else {
        // Determine which key is active (first non-expired, or first if all expired)
        const activeIdx = keys.findIndex(k => !k.expiresAt || !isExpired(k.expiresAt))
        const effectiveActiveIdx = activeIdx >= 0 ? activeIdx : 0
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]
          const isActive = i === effectiveActiveIdx
          const parts: string[] = [`key loaded (${k.source})`]
          if (k.expiresAt && isExpired(k.expiresAt)) {
            parts.push(chalk.red('expired'))
          } else if (k.expiresAt && isExpiringSoon(k.expiresAt, k.keyName)) {
            parts.push(chalk.yellow(formatTimeRemaining(k.expiresAt)))
          } else if (k.expiresAt && k.expiresAt !== 'never') {
            parts.push(formatTimeRemaining(k.expiresAt))
          }
          if (isActive && keys.length > 1) parts.push(output.fmt.brand('active'))
          const line = parts.join('  ')
          lines.push(isActive ? line : output.fmt.dim(line))
        }
      }
      lines.push(output.fmt.dim('NFA. DYOR. Information Purpose Only.'))
      return '\n' + lines.join('\n') + '\n'
    })
    .option('--pay-per-use', 'Pay per API call via x402')
    .addOption(new Option('--payment-signature <base64>', 'Payment proof for x402 (base64-encoded)').hideHelp())
    .option('--api-key <key>', 'API key (overrides config and env)')
    .addOption(new Option('--api-url <url>', 'API base URL (overrides config and env)').hideHelp())
    .configureOutput({
      writeOut: (str: string) => process.stdout.write(output.colorizeHelp(str)),
      writeErr: (str: string) => process.stderr.write(output.colorizeHelp(str)),
    })

  // Hide --version from help (version is in the banner)
  program.options.find(o => o.long === '--version')?.hideHelp()

  program.addOption(formatOption)
  program.option('-v, --verbose', 'Increase verbosity (-v, -vv, -vvv)', (_: string, prev: number) => prev + 1, 0)

  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals()
    if (opts.paymentSignature && opts.payPerUse) {
      thisCommand.error('--payment-signature and --pay-per-use cannot be used together')
    }
  })

  registerLoginCommand(program)
  registerProjectsCommand(program)
  registerIntelCommand(program)
  registerSignalsCommand(program)
  registerGroundingCommand(program)
  // clusters is now a subcommand of signals
  registerRecipeCommand(program)
  registerProviderCommand(program)

  // `aixbt help all` — full reference of every command and option
  program.addHelpCommand(false)
  program
    .command('help [command]')
    .description('display help for command ("all" for full reference)')
    .action((cmdName: string | undefined, _opts: unknown, cmd: Command) => {
      if (cmdName === 'all') {
        const globalOpts = cmd.optsWithGlobals()
        const fmt = resolveFormat(globalOpts.format as string | undefined)
        printFullReference(program, fmt)
        return
      }
      if (cmdName) {
        const sub = program.commands.find(c => c.name() === cmdName)
        if (sub) sub.help()
        else program.error(`unknown command '${cmdName}'`)
      } else {
        program.help()
      }
    })

  return program
}

function printFullReference(program: Command, fmt?: OutputFormat): void {
  if (fmt && output.isStructuredFormat(fmt)) {
    output.outputStructured(buildStructuredReference(program), fmt)
    return
  }

  const lines: string[] = []
  lines.push(output.banner(pkg.version))
  lines.push('')

  function printCommand(cmd: Command, prefix: string): void {
    const usage = cmd.usage()
    const fullName = prefix ? `${prefix} ${cmd.name()}` : cmd.name()
    lines.push(output.fmt.boldWhite(`${fullName}`) + output.fmt.dim(usage ? ` ${usage}` : ''))
    const desc = cmd.description()
    if (desc) lines.push(`  ${desc}`)

    const opts = cmd.options.filter(o => !o.hidden)
    if (opts.length > 0) {
      for (const opt of opts) {
        const flags = opt.flags.padEnd(32)
        lines.push(`  ${output.fmt.dim(flags)}${opt.description || ''}`)
      }
    }
    lines.push('')

    for (const sub of cmd.commands) {
      if (sub.name() === 'help') continue
      printCommand(sub, fullName)
    }
  }

  // Global options
  lines.push(output.fmt.boldWhite('Global Options'))
  const globalOpts = program.options.filter(o => !o.hidden)
  for (const opt of globalOpts) {
    const flags = opt.flags.padEnd(32)
    lines.push(`  ${output.fmt.dim(flags)}${opt.description || ''}`)
  }
  lines.push('')

  // All commands
  for (const cmd of program.commands) {
    if (cmd.name() === 'help') continue
    printCommand(cmd, 'aixbt')
  }

  process.stdout.write(output.colorizeHelp(lines.join('\n') + '\n'))
}

function buildStructuredReference(program: Command): Record<string, unknown> {
  function serializeCommand(cmd: Command): Record<string, unknown> {
    const opts = cmd.options.filter(o => !o.hidden).map(o => ({
      flags: o.flags,
      description: o.description || '',
    }))

    const subcommands = cmd.commands
      .filter(c => c.name() !== 'help')
      .map(c => serializeCommand(c))

    const result: Record<string, unknown> = {
      name: cmd.name(),
      description: cmd.description() || '',
    }

    if (opts.length > 0) result.options = opts
    if (subcommands.length > 0) result.subcommands = subcommands

    return result
  }

  const globalOpts = program.options.filter(o => !o.hidden).map(o => ({
    flags: o.flags,
    description: o.description || '',
  }))

  const commands = program.commands
    .filter(c => c.name() !== 'help')
    .map(c => serializeCommand(c))

  return {
    name: 'aixbt',
    version: pkg.version,
    globalOptions: globalOpts,
    commands,
  }
}

function expandVerboseFlags(argv: string[]): string[] {
  return argv.flatMap(arg => {
    if (/^-v{2,}$/.test(arg)) return Array(arg.length - 1).fill('-v')
    return [arg]
  })
}

async function main(): Promise<void> {
  const program = createProgram()
  try {
    await program.parseAsync(expandVerboseFlags(process.argv))
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log()
      process.exit(0)
    }
    const outputFormat = resolveFormat(program.opts().format as string | undefined)
    await handleTopLevelError(err, outputFormat)
  }
}

const isDirectRun = process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const notifier = updateNotifier({ pkg })
  notifier.notify()
  if (notifier.update) {
    output.setUpdateInfo({
      current: notifier.update.current,
      latest: notifier.update.latest,
      type: notifier.update.type,
    })
  }
  main().catch(async (err: unknown) => {
    await handleTopLevelError(err, 'human')
  })
}
