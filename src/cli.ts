#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerProjectsCommand } from './commands/projects.js'
import { registerSignalsCommand } from './commands/signals.js'
import { registerClustersCommand } from './commands/clusters.js'
import { registerRecipeCommand } from './commands/recipe.js'
import { registerLoginCommand } from './commands/login.js'
import { registerConfigCommand } from './commands/config.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

export function createProgram(): Command {
  const program = new Command()

  program
    .name('aixbt')
    .description('AIXBT intelligence CLI')
    .version(pkg.version, '-v, --version')
    .option('--json', 'Output as JSON (machine-readable)')
    .option('--delayed', 'Use free tier with delayed data (no auth required)')
    .option('--pay-per-use', 'Pay per API call via x402')
    .option('--api-key <key>', 'API key (overrides config and env)')

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
  await program.parseAsync(process.argv)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
