import { readConfig, writeConfig } from '../config.js'
import type { Provider, ProviderKeyConfig } from './types.js'
import { getKeyedTiers, getSortedTiers } from './types.js'

const PROVIDER_ENV_VARS: Record<string, { key: string; tier: string }> = {
  coingecko: { key: 'COINGECKO_API_KEY', tier: 'COINGECKO_TIER' },
  defillama: { key: 'DEFILLAMA_API_KEY', tier: 'DEFILLAMA_TIER' },
  goplus: { key: 'GOPLUS_ACCESS_TOKEN', tier: 'GOPLUS_TIER' },
}

const warnedProviders = new Set<string>()

function lowestKeyedTier(provider: Provider): string {
  const sorted = getSortedTiers(provider)
  const first = sorted.find(([, def]) => !def.keyless)
  return first ? first[0] : 'free'
}

export interface ResolvedProviderKey {
  apiKey: string
  tier: string
  source: 'flag' | 'env' | 'config'
}

export function resolveProviderKey(
  provider: Provider,
  flagKey?: string,
  flagTier?: string,
): ResolvedProviderKey | null {
  const providerName = provider.name

  // Layer 1: CLI flag
  if (flagKey) {
    return {
      apiKey: flagKey,
      tier: flagTier ?? lowestKeyedTier(provider),
      source: 'flag',
    }
  }

  // Layer 2: Environment variable
  const envConfig = PROVIDER_ENV_VARS[providerName]
  if (envConfig) {
    const envValue = process.env[envConfig.key]
    if (envValue) {
      const tierValue = process.env[envConfig.tier]
      if (tierValue) {
        // Validate the tier value against provider's keyed tiers
        const keyed = getKeyedTiers(provider)
        if (keyed.includes(tierValue)) {
          return { apiKey: envValue, tier: tierValue, source: 'env' }
        }
        // Invalid tier value -- warn and default
        if (!warnedProviders.has(providerName)) {
          warnedProviders.add(providerName)
          console.error(
            `warning: ${envConfig.tier}="${tierValue}" is not a valid tier for ${provider.displayName}. ` +
            `Valid tiers: ${keyed.join(', ')}. Defaulting to "${lowestKeyedTier(provider)}".`,
          )
        }
        return { apiKey: envValue, tier: lowestKeyedTier(provider), source: 'env' }
      } else {
        // No companion tier env var -- default and warn
        const defaultTier = lowestKeyedTier(provider)
        if (!warnedProviders.has(providerName)) {
          warnedProviders.add(providerName)
          console.error(
            `warning: ${envConfig.key} set without ${envConfig.tier} — defaulting to "${defaultTier}". ` +
            `Set ${envConfig.tier} to suppress this warning.`,
          )
        }
        return { apiKey: envValue, tier: defaultTier, source: 'env' }
      }
    }
  }

  // Layer 3: Config file
  const config = readConfig()
  const providerConfig = config.providers?.[providerName]
  if (providerConfig) {
    return {
      apiKey: providerConfig.apiKey,
      tier: providerConfig.tier ?? lowestKeyedTier(provider),
      source: 'config',
    }
  }

  return null
}

export function saveProviderKey(
  providerName: string,
  keyConfig: ProviderKeyConfig,
): void {
  const config = readConfig()
  if (!config.providers) {
    config.providers = {}
  }
  config.providers[providerName] = keyConfig
  writeConfig(config)
}

export function removeProviderKey(providerName: string): boolean {
  const config = readConfig()
  if (!config.providers?.[providerName]) {
    return false
  }
  delete config.providers[providerName]
  if (Object.keys(config.providers).length === 0) {
    delete config.providers
  }
  writeConfig(config)
  return true
}
