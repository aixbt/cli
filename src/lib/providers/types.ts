export type ProviderTier = 'free' | 'demo' | 'pro'

export interface ActionParam {
  name: string
  required: boolean
  description: string
  /** If true, this param is used in the URL path template (e.g., {chainId}) */
  inPath?: boolean
}

export interface ActionDefinition {
  method: 'GET'
  /** URL path template with {param} placeholders */
  path: string
  description: string
  /** Agent-oriented hint shown after "Use when:" in help output */
  hint: string
  params: ActionParam[]
  minTier: ProviderTier
  /** Tier-specific path overrides (e.g., CoinGecko GeckoTerminal -> CoinGecko routing) */
  pathByTier?: Partial<Record<ProviderTier, string>>
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
  /** Header name for API key authentication (e.g., 'x-cg-pro-api-key') */
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
}

export interface ProviderKeyConfig {
  apiKey: string
  tier: ProviderTier
}
