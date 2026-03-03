import type { Command } from 'commander'

export function registerClustersCommand(program: Command): void {
  program.command('clusters').description('Browse and inspect signal clusters')
}
