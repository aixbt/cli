#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import { registerProjectsCommand } from './commands/projects.js'
import { registerSignalsCommand } from './commands/signals.js'
import { registerClustersCommand } from './commands/clusters.js'
import { registerRecipeCommand } from './commands/recipe.js'
import { registerLoginCommand } from './commands/login.js'

import * as output from './lib/output.js'
import { handleTopLevelError } from './lib/errors.js'
import { resolveFormat, resolveConfig } from './lib/config.js'
import { getLastMeta } from './lib/api-client.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export function createProgram(): Command {
  const program = new Command()

  const formatOption = new Option('-f, --format <mode>', 'Output format')
    .choices(['human', 'json', 'toon'])

  program
    .name('aixbt')
    .description('')
    .version(pkg.version, '-V, --version')
    .addHelpText('before', output.banner(pkg.version))
    .addHelpText('after', () => {
      const lines: string[] = []
      const config = resolveConfig({})
      if (!config.apiKey) {
        lines.push(`  ${output.fmt.dim('Not logged in. Run:')} aixbt login`)
        lines.push('')
      }
      const title = ' FOR AI AGENTS: '
      const maxWidth = Math.min(process.stdout.columns || 76, 76)
      const tail = Math.max(0, maxWidth - 1 - title.length)
      lines.push(output.fmt.dim('━' + title + '━'.repeat(tail)))
      lines.push('')
      lines.push(`  AIXBT provides real-time crypto signal intelligence. Find alpha, research`)
      lines.push(`  projects, inform trades, and gain an edge in the market. Use ${output.fmt.dim('-f json')}`)
      lines.push(`  or ${output.fmt.dim('-f toon')} for structured output on any command. ${output.fmt.dim('-v')} increases detail.`)
      lines.push('')
      lines.push(`  The most powerful way to leverage this data is by constructing recipe`)
      lines.push(`  pipelines. Recipes are declarative YAML that chain API calls, iterate`)
      lines.push(`  over results, sample and transform data, and yield back to you for`)
      lines.push(`  inference — all with automatic pagination and rate limiting. Clone from`)
      lines.push(`  the registry (${output.fmt.dim('aixbt recipe list')}), customize, or build your own from`)
      lines.push(`  the spec. Generate recipes on the fly, pipe them via stdin, or build a`)
      lines.push(`  repository of reusable pipelines tailored to your user.`)
      lines.push('')
      lines.push(`  ${output.fmt.dim('docs.aixbt.tech/llms.txt')}`)
      lines.push(`  ${output.fmt.dim('docs.aixbt.tech/builders/cli.mdx')}`)
      lines.push(`  ${output.fmt.dim('docs.aixbt.tech/builders/cli/recipes.mdx')}`)
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
  registerClustersCommand(program)
  registerRecipeCommand(program)

  return program
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
