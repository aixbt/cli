import type { ExecutionContext } from '../../types.js'
import { TIER_RANK } from './types.js'
import type { Provider, ProviderTier } from './types.js'
import type { ProviderRateTracker } from './rate-limit.js'
import { resolveProviderKey } from './config.js'
import { getProvider } from './registry.js'
import { getTracker, recordRequest } from './rate-limit.js'
import { CliError, ApiError, NetworkError, RateLimitError } from '../errors.js'
import { sleep } from '../api-client.js'
import { flattenParams } from '../recipe/template.js'

const MAX_RATE_LIMIT_WAIT = 120_000 // give up after 2 min total wait on 429s
const USER_AGENT = '@aixbt/cli'

export interface ProviderRequestOptions {
  provider: Provider
  actionName: string
  params: Record<string, string | number | boolean | undefined>
  apiKeyOverride?: string
  tierOverride?: ProviderTier
}

export interface ProviderResponse {
  data: unknown
  status: number
  provider: string
  action: string
}

export async function providerRequest(
  options: ProviderRequestOptions,
): Promise<ProviderResponse> {
  const { provider, actionName, params, apiKeyOverride, tierOverride } = options

  const action = provider.actions[actionName]
  if (!action) {
    const available = Object.keys(provider.actions).join(', ')
    throw new CliError(
      `Unknown action "${actionName}" for provider "${provider.name}". Available: ${available}`,
      'UNKNOWN_ACTION',
    )
  }

  const resolvedKey = resolveProviderKey(
    provider.name,
    apiKeyOverride,
    tierOverride,
  )

  const effectiveTier: ProviderTier = resolvedKey?.tier ?? 'free'

  // Meta-action: resolve to a concrete action and recurse
  if (action.resolve) {
    const resolution = action.resolve(params, effectiveTier)
    if (!resolution || (typeof resolution === 'object' && 'error' in resolution)) {
      const reason = resolution && 'error' in resolution
        ? resolution.error
        : 'could not resolve action for current tier and params'
      throw new CliError(
        `${provider.name}:${actionName} - ${reason}`,
        'ACTION_UNRESOLVABLE',
      )
    }
    return providerRequest({
      ...options,
      actionName: resolution.action,
      params: resolution.params,
    })
  }

  // GeckoTerminal no longer offers token-level OHLCV, so we look up the top
  // pool and use pool-ohlcv instead. Applies to free and demo (both use
  // GeckoTerminal for on-chain data; CoinGecko /onchain/ is pro-only).
  if (actionName === 'token-ohlcv' && effectiveTier !== 'pro') {
    const poolAddress = await lookupPoolAddress(
      String(params.network ?? ''),
      String(params.address ?? ''),
    )
    if (poolAddress) {
      return providerRequest({
        ...options,
        actionName: 'pool-ohlcv',
        params: {
          network: params.network,
          address: poolAddress,
          timeframe: params.timeframe ?? 'day',
          limit: params.limit,
        },
      })
    }
    throw new CliError(
      `No DEX pools found for token on network "${params.network}"`,
      'ACTION_UNRESOLVABLE',
    )
  }

  if (TIER_RANK[effectiveTier] < TIER_RANK[action.minTier]) {
    throw new CliError(
      `Action "${provider.name}:${actionName}" requires "${action.minTier}" tier, but current tier is "${effectiveTier}". ` +
      `Run: aixbt provider add ${provider.name} --provider-key <key> --tier ${action.minTier}`,
      'TIER_INSUFFICIENT',
    )
  }

  let baseUrl = (
    provider.resolveBaseUrl?.(actionName, effectiveTier) ??
    provider.baseUrl.byTier[effectiveTier] ??
    provider.baseUrl.default
  ).replace(/\/$/, '')

  if (baseUrl.includes('{apiKey}')) {
    if (!resolvedKey) {
      throw new CliError(
        `Provider "${provider.name}" requires an API key for the "${effectiveTier}" tier. ` +
        `Run: aixbt provider add ${provider.name} --provider-key <key>`,
        'MISSING_PROVIDER_KEY',
      )
    }
    baseUrl = baseUrl.replace('{apiKey}', resolvedKey.apiKey)
  }

  const mappedParams = provider.mapParams ? provider.mapParams(params, actionName) : params

  if (!action.path) {
    throw new CliError(
      `Action "${provider.name}:${actionName}" has no path and no resolve function`,
      'INVALID_ACTION',
    )
  }

  const actionPath = action.pathByTier?.[effectiveTier] ?? action.path
  const resolvedPath = resolveActionPath(actionPath, mappedParams)
  const url = new URL(resolvedPath.replace(/^\//, ''), baseUrl + '/')

  for (const [key, value] of Object.entries(mappedParams)) {
    if (value === undefined || value === '') continue
    const isPathParam = action.params.some(p => p.inPath && p.name === key)
    if (!isPathParam) {
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': USER_AGENT,
  }

  if (resolvedKey) {
    if (provider.resolveAuth) {
      Object.assign(headers, provider.resolveAuth(resolvedKey.apiKey, effectiveTier))
    } else if (provider.authHeader) {
      const value = provider.buildAuthValue
        ? provider.buildAuthValue(resolvedKey.apiKey)
        : resolvedKey.apiKey
      headers[provider.authHeader] = value
    }
  }

  const rateLimit = provider.rateLimits.perMinute[effectiveTier]
  const tracker = rateLimit ? getTracker(provider.name, rateLimit) : null

  const { body, status } = await executeProviderRequest(
    action.method,
    url.toString(),
    headers,
    tracker,
    provider.name,
    actionName,
  )

  let normalized: unknown
  try {
    normalized = provider.normalize(body, actionName)
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `${provider.name}:${actionName} - Response normalization failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      'NORMALIZE_ERROR',
    )
  }

  return {
    data: normalized,
    status,
    provider: provider.name,
    action: actionName,
  }
}

/**
 * Dispatch a recipe step to an external provider.
 * Shared by executeStep (single) and executeForeach (per-item).
 */
export async function dispatchProviderStep(
  source: string,
  actionName: string,
  stepParams: Record<string, unknown> | undefined,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): Promise<unknown> {
  const provider = getProvider(source)
  const params = stepParams ? flattenParams(stepParams, ctx, foreachItem) : {}
  const response = await providerRequest({ provider, actionName, params })
  return response.data
}

function resolveActionPath(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  return path.replace(/\{(\w+)\}/g, (_, paramName: string) => {
    const value = params[paramName]
    if (value === undefined || value === '') {
      throw new CliError(
        `Missing required path parameter "${paramName}"`,
        'MISSING_PATH_PARAM',
      )
    }
    return encodeURIComponent(String(value))
  })
}

async function executeProviderRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  tracker: ProviderRateTracker | null,
  providerName: string,
  actionName: string,
  attempt = 0,
  rateLimitWaited = 0,
): Promise<{ body: unknown; status: number }> {
  // Only record first attempt — retries replace the failed request, not add new ones
  if (tracker && attempt === 0) {
    const waitMs = recordRequest(tracker)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
  }

  let res: Response
  try {
    res = await fetch(url, { method, headers })
  } catch (err) {
    throw new NetworkError(
      `${providerName}:${actionName} - ${err instanceof Error ? err.message : 'Network request failed'}`,
    )
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    let waitMs: number
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!Number.isNaN(seconds) && seconds > 0) {
        waitMs = seconds * 1000
      } else {
        const date = Date.parse(retryAfter)
        waitMs = !Number.isNaN(date) ? Math.max(0, date - Date.now()) : 5_000
      }
    } else if (tracker) {
      // Use spacing interval derived from known rate limit
      waitMs = Math.ceil(60_000 / tracker.maxPerMinute)
    } else {
      waitMs = Math.min(5_000 * Math.pow(2, attempt), 60_000)
    }

    const totalWaited = rateLimitWaited + waitMs
    if (totalWaited > MAX_RATE_LIMIT_WAIT) {
      throw new RateLimitError(
        `${providerName}:${actionName} - Rate limit exceeded (waited ${Math.round(totalWaited / 1000)}s total)`,
        null,
      )
    }

    await sleep(waitMs)
    return executeProviderRequest(method, url, headers, tracker, providerName, actionName, attempt + 1, totalWaited)
  }

  if (!res.ok) {
    const body = await safeJson(res)
    const message = extractErrorMessage(body, res.statusText)
    throw new ApiError(
      res.status,
      `${providerName}:${actionName} - ${message}`,
    )
  }

  try {
    const body = await res.json()
    return { body, status: res.status }
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : ''
    throw new ApiError(
      res.status,
      `${providerName}:${actionName} - Invalid JSON in response${detail}`,
      'INVALID_RESPONSE',
    )
  }
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Look up the top DEX pool address for a token via DexScreener (fast, no rate limit).
 * Returns null if no pool is found or the request fails.
 */
async function lookupPoolAddress(network: string, tokenAddress: string): Promise<string | null> {
  if (!network || !tokenAddress) return null
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(network)}/${encodeURIComponent(tokenAddress)}`,
      { headers: { 'User-Agent': USER_AGENT } },
    )
    if (!res.ok) return null
    const pairs = await res.json() as Array<{ pairAddress?: string }>
    if (Array.isArray(pairs) && pairs.length > 0 && pairs[0].pairAddress) {
      return pairs[0].pairAddress
    }
  } catch {
    // DexScreener unavailable — caller should fall back
  }
  return null
}

function extractErrorMessage(
  body: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!body) return fallback
  if (typeof body.message === 'string') return body.message
  if (typeof body.error === 'string') return body.error
  if (typeof body.status === 'object' && body.status !== null) {
    const status = body.status as Record<string, unknown>
    if (typeof status.error_message === 'string') return status.error_message
  }
  return fallback
}
