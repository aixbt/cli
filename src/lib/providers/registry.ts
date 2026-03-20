import type { Provider } from './types.js'
import { CliError } from '../errors.js'
import { aixbtProvider } from './aixbt.js'
import { defillamaProvider } from './defillama.js'
import { coingeckoProvider } from './coingecko.js'
import { goplusProvider } from './goplus.js'
import { dexpaprikaProvider } from './dexpaprika.js'
import { marketProvider, securityProvider, defiProvider } from './virtual.js'

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

/**
 * Parse a dotted source like "market.coingecko" into provider name + routing hint.
 * Plain sources like "coingecko" return no hint.
 */
export function parseSource(source: string): { providerName: string; hint?: string } {
  const dotIndex = source.indexOf('.')
  if (dotIndex >= 0) {
    return { providerName: source.slice(0, dotIndex), hint: source.slice(dotIndex + 1) }
  }
  return { providerName: source }
}

export function getAllProviders(): Provider[] {
  return [...providers.values()]
}

export function getProviderNames(): string[] {
  return [...providers.keys()]
}

// Register built-in providers
registerProvider(aixbtProvider)
registerProvider(defillamaProvider)
registerProvider(coingeckoProvider)
registerProvider(goplusProvider)
registerProvider(dexpaprikaProvider)
registerProvider(marketProvider)
registerProvider(securityProvider)
registerProvider(defiProvider)
