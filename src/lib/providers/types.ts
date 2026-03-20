export type ProviderTier = 'free' | 'demo' | 'pro'

/** Exhaustive tier ordering — adding a tier to ProviderTier without updating this causes a compile error */
export const TIER_RANK: Record<ProviderTier, number> = { free: 0, demo: 1, pro: 2 }

export type Params = Record<string, string | number | boolean | undefined>

export interface ActionParam {
  name: string
  required: boolean
  description: string
  /** If true, this param is used in the URL path template (e.g., {chainId}) */
  inPath?: boolean
}

export interface ResolvedAction {
  /** Target provider name. When set, resolution crosses to a different provider. */
  provider?: string
  action: string
  params: Params
}

/** Context passed to action resolve functions */
export interface ResolveContext {
  /** Routing hint from dotted source syntax (e.g. "coingecko" from "market.coingecko") */
  hint?: string
  /** Effective API key tier for the current provider */
  tier: ProviderTier
  /** Make a sub-request to the current or another provider (for multi-step resolves like pool lookup) */
  request: (opts: { provider?: string; action: string; params: Params }) => Promise<ProviderResponse>
}

export interface ProviderResponse {
  data: unknown
  status: number
  provider: string
  action: string
}

export interface ActionDefinition {
  method: 'GET'
  /** URL path template with {param} placeholders. Omit for resolve-only actions. */
  path?: string
  description: string
  /** Agent-oriented hint shown after "Use when:" in help output */
  hint: string
  params: ActionParam[]
  minTier: ProviderTier
  /** Tier-specific path overrides (e.g., CoinGecko GeckoTerminal -> CoinGecko routing) */
  pathByTier?: Partial<Record<ProviderTier, string>>
  /**
   * Dynamic resolver for meta-actions that route to other actions.
   *
   * Return values:
   *   ResolvedAction — recurse into the target provider/action
   *   { error: string } — hard error, abort
   *   null — fall through to normal HTTP dispatch (action must have a path)
   */
  resolve?: (
    params: Params,
    ctx: ResolveContext,
  ) => ResolvedAction | { error: string } | null | Promise<ResolvedAction | { error: string } | null>
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
  /** Base URL config. Required for concrete providers; omit for virtual providers. */
  baseUrl?: ProviderBaseUrlConfig
  /** Rate limits. Required for concrete providers; omit for virtual providers. */
  rateLimits?: ProviderRateLimits
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
   * Defaults to identity (return body as-is).
   */
  normalize?: (body: unknown, actionName: string) => unknown
  /**
   * Resolve auth headers dynamically based on tier.
   * Used by providers with different auth headers per tier (e.g., CoinGecko).
   */
  resolveAuth?: (apiKey: string, tier: ProviderTier) => Record<string, string>
  /**
   * Transform params before the request — used for chain ID mapping, etc.
   * Called after template resolution, before path substitution and query params.
   */
  mapParams?: (params: Params, actionName: string) => Params
  /**
   * Override the base URL for specific action+tier combinations.
   * Used when a provider has actions that route to a different API surface
   * (e.g., CoinGecko on-chain actions route to GeckoTerminal on non-pro tiers).
   * Return undefined to use the standard baseUrl.byTier resolution.
   */
  resolveBaseUrl?: (actionName: string, tier: ProviderTier) => string | undefined
}

/** Returns true if this provider handles HTTP requests directly (has baseUrl) */
export function isConcreteProvider(provider: Provider): boolean {
  return provider.baseUrl !== undefined
}

export interface ProviderKeyConfig {
  apiKey: string
  tier: ProviderTier
}
