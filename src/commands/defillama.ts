import type { Command } from 'commander'
import { defillamaProvider } from '../lib/providers/defillama.js'
import { registerProviderCommands } from './provider-commands.js'

export function registerDefillamaCommand(program: Command): void {
  registerProviderCommands(program, defillamaProvider)
}
