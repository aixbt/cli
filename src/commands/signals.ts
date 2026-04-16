import type { Command } from 'commander'

const SHIM_MESSAGE = 'aixbt signals is deprecated — use `aixbt intel` instead. Sunset: 2026-07-15.'

function shim(): never {
  process.stderr.write(SHIM_MESSAGE + '\n')
  process.exit(2)
}

export function registerSignalsCommand(program: Command): void {
  const signals = program
    .command('signals', { hidden: true })
    .description('[Deprecated] Use `aixbt intel`')
    .action(shim)

  signals
    .command('clusters', { hidden: true })
    .description('[Deprecated] Use `aixbt intel clusters`')
    .action(shim)

  signals
    .command('categories', { hidden: true })
    .description('[Deprecated] Use `aixbt intel categories`')
    .action(shim)
}
