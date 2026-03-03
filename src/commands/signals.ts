import type { Command } from 'commander'

export function registerSignalsCommand(program: Command): void {
  program.command('signals').description('Query and filter AIXBT signals')
}
