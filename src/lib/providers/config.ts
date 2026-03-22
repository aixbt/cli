import { readConfig, writeConfig } from '../config.js'
import type { Provider, ProviderKeyConfig } from './types.js'
import { getKeyedTiers, getSortedTiers } from './types.js'

const PROVIDER_ENV_VARS: Record<string, { key: string; tier: string }> = {
  coingecko: { key: 'COINGECKO_API_KEY', tier: 'COINGECKO_TIER' },
  defillama: { key: 'DEFILLAMA_API_KEY', tier: 'DEFILLAMA_TIER' },
  goplus: { key: 'GOPLUS_ACCESS_TOKEN', tier: 'GOPLUS_TIER' },
}

const warnedProviders = new Set<string>()

/** Clear the warning dedup set. Useful in tests. */
export function resetProviderWarnings(): void {
  warnedProviders.clear()
}

function lowestKeyedTier(provider: Provider): string {
  const sorted = getSortedTiers(provider)
  const first = sorted.find(([, def]) => !def.keyless)
  // Fallback 'free' is defensive — unreachable for providers in PROVIDER_ENV_VARS
  // (all have keyed tiers) and provider add rejects keyless-only providers.
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
      const keyed = getKeyedTiers(provider)
      const defaultTier = lowestKeyedTier(provider)

      let tier: string
      if (tierValue && keyed.includes(tierValue)) {
        tier = tierValue
      } else {
        tier = defaultTier
        if (!warnedProviders.has(providerName)) {
          warnedProviders.add(providerName)
          const detail = tierValue
            ? `${envConfig.tier}="${tierValue}" is not a valid tier for ${provider.displayName}. Valid tiers: ${keyed.join(', ')}. Defaulting to "${defaultTier}".`
            : `${envConfig.key} set without ${envConfig.tier} — defaulting to "${defaultTier}". Set ${envConfig.tier} to suppress this warning.`
          console.error(`warning: ${detail}`)
        }
      }
      return { apiKey: envValue, tier, source: 'env' }
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
