#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerProjectsCommand } from './commands/projects.js'
import { registerSignalsCommand } from './commands/signals.js'
import { registerClustersCommand } from './commands/clusters.js'
import { registerRecipeCommand } from './commands/recipe.js'
import { registerLoginCommand } from './commands/login.js'
import { registerConfigCommand } from './commands/config.js'
import * as output from './lib/output.js'
import { handleTopLevelError } from './lib/errors.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export function createProgram(): Command {
  const program = new Command()

  program
    .name('aixbt')
    .description('')
    .version(pkg.version, '-v, --version')
    .addHelpText('before', output.banner(pkg.version))
    .option('--json', 'Output as JSON (machine-readable)')
    .option('--delayed', 'Use free tier with delayed data (no auth required)')
    .option('--pay-per-use', 'Pay per API call via x402')
    .option('--payment-signature <base64>', 'Payment proof for x402 (base64-encoded)')
    .option('--api-key <key>', 'API key (overrides config and env)')
    .option('--api-url <url>', 'API base URL (overrides config and env)')
    .configureOutput({
      writeOut: (str: string) => process.stdout.write(output.colorizeHelp(str)),
      writeErr: (str: string) => process.stderr.write(output.colorizeHelp(str)),
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
  registerConfigCommand(program)
  registerProjectsCommand(program)
  registerSignalsCommand(program)
  registerClustersCommand(program)
  registerRecipeCommand(program)

  return program
}

async function main(): Promise<void> {
  const program = createProgram()
  try {
    await program.parseAsync(process.argv)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      console.log()
      process.exit(0)
    }
    handleTopLevelError(err, program.opts().json)
  }
}

const isDirectRun = process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((err: unknown) => {
    handleTopLevelError(err, false)
  })
}
