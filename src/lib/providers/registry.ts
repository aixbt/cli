import type { Provider } from './types.js'
import { CliError } from '../errors.js'

const providers = new Map<string, Provider>()

export function registerProvider(provider: Provider): void {
  if (providers.has(provider.name)) {
    throw new CliError(`Provider "${provider.name}" is already registered`, 'DUPLICATE_PROVIDER')
  }
  providers.set(provider.name, provider)
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name)
  if (!provider) {
    const known = [...providers.keys()].join(', ')
    throw new CliError(
      `Unknown provider "${name}". Available providers: ${known}`,
      'UNKNOWN_PROVIDER',
    )
  }
  return provider
}

export function getAllProviders(): Provider[] {
  return [...providers.values()]
}

export function getProviderNames(): string[] {
  return [...providers.keys()]
}

// Register built-in providers
import { aixbtProvider } from './aixbt.js'
registerProvider(aixbtProvider)
