import type { Command } from 'commander'

export function registerRecipeCommand(program: Command): void {
  program.command('recipe').description('Run analysis recipes')
}
