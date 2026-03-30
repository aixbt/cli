import type { Provider, ActionDefinition, Params } from './types.js'

/**
 * Create a virtual provider that proxies all actions from a concrete provider.
 *
 * All source actions are auto-exposed with their original names.
 * When `aliases` is provided, additional virtual actions are added that map
 * to source actions under different names — these are the curated,
 * provider-agnostic entry points (like `token-scan` → `security-check`)
 * that can evolve to route across providers later.
 */
export function createAliasProvider(
  name: string,
  displayName: string,
  source: Provider,
  aliases?: Record<string, string>,
): Provider {
  const actions: Record<string, ActionDefinition> = {}

  // Auto-expose all source actions with original names
  for (const [actionName, action] of Object.entries(source.actions)) {
    actions[actionName] = proxyAction(source.name, actionName, action)
  }

  // Add curated aliases (virtual action name → concrete action name)
  if (aliases) {
    for (const [virtualName, concreteName] of Object.entries(aliases)) {
      const action = source.actions[concreteName]
      if (!action) throw new Error(`Alias provider "${name}": source "${source.name}" has no action "${concreteName}"`)
      actions[virtualName] = proxyAction(source.name, concreteName, action)
    }
  }

  return { name, displayName, actions, tiers: {} }
}

/**
 * Create a single proxied action definition that resolves to a concrete provider action.
 * Copies params, description, hint, and minTier from the source action.
 * The resolve function routes to the target provider, optionally using the hint for override.
 */
export function proxyAction(
  targetProvider: string,
  targetAction: string,
  sourceAction: ActionDefinition,
  defaultProvider?: string,
): ActionDefinition {
  return {
    method: sourceAction.method,
    description: sourceAction.description,
    hint: sourceAction.hint,
    params: sourceAction.params,
    minTier: sourceAction.minTier,
    resolve: (_params: Params, ctx) => ({
      provider: ctx.hint ?? defaultProvider ?? targetProvider,
      action: targetAction,
      params: _params,
    }),
  }
}

/**
 * Shared resolve for token-ohlcv: look up top pool, then fetch pool-ohlcv.
 * Used by both dexpaprika and coingecko (non-pro) to handle token-level OHLCV
 * when only pool-level OHLCV is available from the API.
 */
export async function resolveTokenOhlcvViaPool(
  params: Params,
  request: (opts: { provider?: string; action: string; params: Params }) => Promise<{ data: unknown }>,
): Promise<{ action: string; params: Params } | { error: string }> {
  const poolsResponse = await request({
    action: 'token-pools',
    params: { network: params.network, address: params.address },
  })
  const pools = poolsResponse.data
  if (Array.isArray(pools) && pools.length > 0) {
    const poolAddress = (pools[0] as Record<string, unknown>).address as string
    if (poolAddress) {
      return {
        action: 'pool-ohlcv',
        params: {
          network: params.network,
          address: poolAddress,
          timeframe: params.timeframe ?? 'day',
          limit: params.limit,
          before_timestamp: params.before_timestamp,
        },
      }
    }
  }
  return { error: `No DEX pools found for token on network "${params.network}"` }
}
