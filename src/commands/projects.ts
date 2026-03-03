import type { Command } from 'commander'

export function registerProjectsCommand(program: Command): void {
  program.command('projects').description('List and search AIXBT projects')
}
