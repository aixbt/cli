#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import { registerProjectsCommand } from './commands/projects.js'
import { registerSignalsCommand } from './commands/signals.js'
// clusters is now a subcommand of signals — see signals.ts
import { registerRecipeCommand } from './commands/recipe.js'
import { registerLoginCommand } from './commands/login.js'
import { registerProviderCommand } from './commands/provider.js'

import type { OutputFormat } from './lib/output.js'
import * as output from './lib/output.js'
import { handleTopLevelError } from './lib/errors.js'
import { resolveFormat, resolveConfig } from './lib/config.js'
import { getLastMeta } from './lib/api-client.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export function createProgram(): Command {
  const program = new Command()

  const formatOption = new Option(
    '-f, --format <mode>',
    'Output format: human (terminal display) | json (structured, scripting) | toon (compact structured, ~40% smaller — best for agents)',
  ).choices(['human', 'json', 'toon'])

  program
    .name('aixbt')
    .description('')
    .version(pkg.version, '-V, --version')
    .addHelpText('before', output.banner(pkg.version))
    .addHelpText('after', () => {
      const lines: string[] = []
      const config = resolveConfig({})
      if (config.apiKey) {
        lines.push(`  ${output.fmt.dim('Status:')} authenticated · real-time data`)
      } else {
        lines.push(`  ${output.fmt.dim('Status:')} no API key · run aixbt login or visit docs.aixbt.tech`)
      }
      lines.push('')
      const title = ' FOR AI AGENTS: '
      const maxWidth = Math.min(process.stdout.columns || 76, 76)
      const tail = Math.max(0, maxWidth - 1 - title.length)
      lines.push(output.fmt.dim('━' + title + '━'.repeat(tail)))
      lines.push('')
      lines.push(`  ${output.fmt.dim('1.')} Browse pipelines       aixbt recipe list`)
      lines.push(`  ${output.fmt.dim('2.')} Ad-hoc queries          aixbt signals -f toon`)
      lines.push(`  ${output.fmt.dim('3.')} Full command reference   aixbt help all`)
      lines.push('')
      lines.push(`  ${output.fmt.dim('docs.aixbt.tech/llms.txt')}`)
      return '\n' + lines.join('\n') + '\n'
    })
    .option('--delayed', 'Use free tier with delayed data (no auth required)')
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

  program.hook('postAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals()
    const fmt = resolveFormat(opts.format as string | undefined)
    if (!output.isStructuredFormat(fmt)) {
      const meta = getLastMeta()
      if (meta) output.delayedDataWarning(meta)
    }
  })

  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals()
    if (opts.delayed && opts.payPerUse) {
      thisCommand.error('--delayed and --pay-per-use cannot be used together')
    }
    if (opts.paymentSignature && opts.payPerUse) {
      thisCommand.error('--payment-signature and --pay-per-use cannot be used together')
    }
    if (opts.paymentSignature && opts.delayed) {
      thisCommand.error('--payment-signature and --delayed cannot be used together')
    }
  })

  registerLoginCommand(program)
  registerProjectsCommand(program)
  registerSignalsCommand(program)
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
  main().catch(async (err: unknown) => {
    await handleTopLevelError(err, 'human')
  })
}
