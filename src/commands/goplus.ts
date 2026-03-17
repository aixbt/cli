import type { Command } from 'commander'
import { goplusProvider } from '../lib/providers/goplus.js'
import { registerProviderCommands } from './provider-commands.js'

export function registerGoplusCommand(program: Command): void {
  registerProviderCommands(program, goplusProvider)
}
