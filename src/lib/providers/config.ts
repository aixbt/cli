import { readConfig, writeConfig } from '../config.js'
import type { ProviderKeyConfig, ProviderTier } from './types.js'

const PROVIDER_ENV_VARS: Record<string, string> = {
  coingecko: 'COINGECKO_API_KEY',
  defillama: 'DEFILLAMA_API_KEY',
  goplus: 'GOPLUS_ACCESS_TOKEN',
}

const DEFAULT_TIER_FOR_ENV: Record<string, ProviderTier> = {
  coingecko: 'demo',
  defillama: 'pro',
  goplus: 'free',
}

export interface ResolvedProviderKey {
  apiKey: string
  tier: ProviderTier
  source: 'flag' | 'env' | 'config'
}

export function resolveProviderKey(
  providerName: string,
  flagKey?: string,
  flagTier?: ProviderTier,
): ResolvedProviderKey | null {
  // Layer 1: CLI flag
  if (flagKey) {
    return {
      apiKey: flagKey,
      tier: flagTier ?? DEFAULT_TIER_FOR_ENV[providerName] ?? 'free',
      source: 'flag',
    }
  }

  // Layer 2: Environment variable
  const envVar = PROVIDER_ENV_VARS[providerName]
  if (envVar) {
    const envValue = process.env[envVar]
    if (envValue) {
      return {
        apiKey: envValue,
        tier: DEFAULT_TIER_FOR_ENV[providerName] ?? 'free',
        source: 'env',
      }
    }
  }

  // Layer 3: Config file
  const config = readConfig()
  const providerConfig = config.providers?.[providerName]
  if (providerConfig) {
    return {
      apiKey: providerConfig.apiKey,
      tier: providerConfig.tier,
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
