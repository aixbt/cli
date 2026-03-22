export type ProviderTier = string

export interface ProviderTierDef {
  /** Rank for tier ordering. Higher rank = more capable. */
  rank: number
  /** Requests per minute. Omit for providers with no rate limiting on this tier. */
  ratePerMinute?: number
  /** When true, this tier requires no API key. */
  keyless?: boolean
}

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
  minTier: string
  /** Tier-specific path overrides (e.g., CoinGecko GeckoTerminal -> CoinGecko routing) */
  pathByTier?: Record<string, string>
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

export interface ProviderBaseUrlConfig {
  byTier: Record<string, string>
  default: string
}

export interface Provider {
  name: string
  displayName: string
  actions: Record<string, ActionDefinition>
  /** Provider-specific tier definitions. Key is the tier name. */
  tiers: Record<string, ProviderTierDef>
  /** Base URL config. Required for concrete providers; omit for virtual providers. */
  baseUrl?: ProviderBaseUrlConfig
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
  resolveAuth?: (apiKey: string, tier: string) => Record<string, string>
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
  resolveBaseUrl?: (actionName: string, tier: string) => string | undefined
}

/** Returns true if this provider handles HTTP requests directly (has baseUrl) */
export function isConcreteProvider(provider: Provider): boolean {
  return provider.baseUrl !== undefined
}

export interface ProviderKeyConfig {
  apiKey: string
  tier: string
}

/**
 * Returns true if effectiveTier has sufficient rank for requiredTier
 * according to the provider's tier definitions. Returns false if either
 * tier is unknown to the provider (fail-closed).
 */
export function isTierSufficient(
  provider: Provider,
  effectiveTier: string,
  requiredTier: string,
): boolean {
  const effective = provider.tiers[effectiveTier]
  const required = provider.tiers[requiredTier]
  if (!effective || !required) return false
  return effective.rank >= required.rank
}

/** Return tier names that accept API keys (i.e., not keyless-only). */
export function getKeyedTiers(provider: Provider): string[] {
  return Object.entries(provider.tiers)
    .filter(([, def]) => !def.keyless)
    .map(([name]) => name)
}

/** Return tier entries sorted by rank ascending. */
export function getSortedTiers(provider: Provider): [string, ProviderTierDef][] {
  return Object.entries(provider.tiers).sort((a, b) => a[1].rank - b[1].rank)
}
