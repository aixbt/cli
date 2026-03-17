import type { Command } from 'commander'
import { coingeckoProvider } from '../lib/providers/coingecko.js'
import { registerProviderCommands } from './provider-commands.js'

export function registerCoingeckoCommand(program: Command): void {
  registerProviderCommands(program, coingeckoProvider)
}
