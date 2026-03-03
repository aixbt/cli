import type { Command } from 'commander'

export function registerConfigCommand(program: Command): void {
  program.command('config').description('Manage CLI configuration')
}
