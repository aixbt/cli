export type ProviderTier = 'free' | 'demo' | 'pro'

/** Exhaustive tier ordering — adding a tier to ProviderTier without updating this causes a compile error */
export const TIER_RANK: Record<ProviderTier, number> = { free: 0, demo: 1, pro: 2 }

export interface ActionParam {
  name: string
  required: boolean
  description: string
  /** If true, this param is used in the URL path template (e.g., {chainId}) */
  inPath?: boolean
}

export interface ResolvedAction {
  action: string
  params: Record<string, string | number | boolean | undefined>
}

export interface ActionDefinition {
  method: 'GET'
  /** URL path template with {param} placeholders. Omit for meta-actions using `resolve`. */
  path?: string
  description: string
  /** Agent-oriented hint shown after "Use when:" in help output */
  hint: string
  params: ActionParam[]
  minTier: ProviderTier
  /** Tier-specific path overrides (e.g., CoinGecko GeckoTerminal -> CoinGecko routing) */
  pathByTier?: Partial<Record<ProviderTier, string>>
  /**
   * Dynamic resolver for meta-actions that route to other actions based on
   * available params and user tier. Return the target action + mapped params,
   * or null if no suitable path exists (triggers step fallback).
   */
  resolve?: (
    params: Record<string, string | number | boolean | undefined>,
    effectiveTier: ProviderTier,
  ) => ResolvedAction | null
}

export interface ProviderRateLimits {
  perMinute: Partial<Record<ProviderTier, number>>
}

export interface ProviderBaseUrlConfig {
  byTier: Partial<Record<ProviderTier, string>>
  default: string
}

export interface Provider {
  name: string
  displayName: string
  actions: Record<string, ActionDefinition>
  baseUrl: ProviderBaseUrlConfig
  rateLimits: ProviderRateLimits
  /** Header name for API key authentication (e.g., 'X-API-Key', 'Authorization') */
  authHeader?: string
  /**
   * Build the auth header value from the raw API key.
   * Default: use the key directly. Override for 'Bearer <key>' or similar.
   */
  buildAuthValue?: (apiKey: string) => string
  /**
   * Normalize the raw JSON response from the provider.
   * Returns the payload that becomes step result data.
   */
  normalize: (body: unknown, actionName: string) => unknown
  /**
   * Resolve auth headers dynamically based on tier.
   * Used by providers with different auth headers per tier (e.g., CoinGecko).
   */
  resolveAuth?: (apiKey: string, tier: ProviderTier) => Record<string, string>
  /**
   * Transform params before the request — used for chain ID mapping, etc.
   * Called after template resolution, before path substitution and query params.
   */
  mapParams?: (params: Record<string, string | number | boolean | undefined>, actionName: string) => Record<string, string | number | boolean | undefined>
}

export interface ProviderKeyConfig {
  apiKey: string
  tier: ProviderTier
}
