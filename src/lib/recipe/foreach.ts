import type {
  ExecutionContext, ApiStep, ForeachResult,
  ForeachFailure, RateLimitInfo,
} from '../../types.js'
import { resolveActionPath, flattenParams, substitutePathParams, resolveRelativeTime } from './template.js'
import { AT_SUPPORTED_ACTIONS } from '../providers/aixbt.js'
import { applyTransforms } from '../transforms.js'
import { get, sleep } from '../api-client.js'
import { CliError } from '../errors.js'
import { fmt } from '../output.js'
import { getProvider, parseSource } from '../providers/registry.js'
import { dispatchProviderStep } from '../providers/client.js'
import { resolveProviderKey } from '../providers/config.js'
import { getTracker, deriveProviderConcurrency, waitForCapacity } from '../providers/rate-limit.js'
import { getSortedTiers } from '../providers/types.js'
import type { Provider } from '../providers/types.js'
import { AIXBT_ACTION_PATHS } from '../providers/aixbt.js'

// -- Upgrade hint helper --

function getUpgradeHint(provider: Provider, currentTier: string): string | undefined {
  const currentRank = provider.tiers[currentTier]?.rank ?? -1
  const currentRate = provider.tiers[currentTier]?.ratePerMinute ?? 0
  for (const [name, def] of getSortedTiers(provider)) {
    if (def.rank <= currentRank) continue
    if (def.keyless) continue
    if (def.ratePerMinute && def.ratePerMinute > currentRate) {
      return `upgrade to ${name} for ${def.ratePerMinute}/min: aixbt provider add ${provider.name} --tier ${name}`
    }
    return `upgrade to ${name} to unlock more actions: aixbt provider add ${provider.name} --tier ${name}`
  }
  return undefined
}

// -- Rate limit helpers --

export function deriveConcurrency(rateLimit: RateLimitInfo | null): number {
  if (!rateLimit) return 3
  const remaining = rateLimit.remainingPerMinute
  if (remaining <= 5) return 1
  if (remaining <= 20) return 3
  if (remaining <= 50) return 5
  return 10
}

export function computeWaitTime(rateLimit: RateLimitInfo): number {
  if (rateLimit.retryAfterSeconds !== undefined) {
    return rateLimit.retryAfterSeconds * 1000
  }
  if (rateLimit.resetMinute) {
    const resetTime = new Date(rateLimit.resetMinute).getTime()
    const now = Date.now()
    const waitMs = resetTime - now + 500
    if (waitMs > 0) return waitMs
  }
  return 5000
}

export interface RateLimitTracker {
  paused: boolean
  waitedMs: number
}

export async function waitIfRateLimited(
  rateLimit: RateLimitInfo | null,
  tracker: RateLimitTracker,
): Promise<void> {
  if (rateLimit && rateLimit.remainingPerMinute <= 2) {
    tracker.paused = true
    const waitMs = computeWaitTime(rateLimit)
    tracker.waitedMs += waitMs
    await sleep(waitMs)
  }
}

// -- Error marker helper --

export function isErrorMarker(item: unknown): item is { _error: true; item: unknown; error: string; status?: number } {
  return typeof item === 'object' && item !== null && '_error' in item && (item as Record<string, unknown>)._error === true
}

// -- Foreach execution --

export interface ForeachProgressEvent {
  type: 'rate_limit' | 'item_complete'
  provider: string
  waitMs: number
  completed: number
  total: number
  tier?: string
  upgradeHint?: string
}

export interface ForeachOptions {
  step: ApiStep & { 'for': string }
  items: unknown[]
  ctx: ExecutionContext
  clientOptions: import('../api-client.js').ApiClientOptions
  currentRateLimit: RateLimitInfo | null
  onProgress?: (event: ForeachProgressEvent) => void
}

export async function executeForeach(options: ForeachOptions): Promise<ForeachResult> {
  const { step, items, ctx, clientOptions, currentRateLimit, onProgress } = options
  const startedAt = new Date()

  if (items.length === 0) {
    const completedAt = new Date()
    return {
      stepId: step.id,
      data: [],
      rateLimit: currentRateLimit,
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
      items: [],
      failures: [],
    }
  }

  const isExternalProvider = step.source !== undefined && step.source !== 'aixbt'

  let concurrency: number
  let providerTracker: import('../providers/rate-limit.js').ProviderRateTracker | null = null
  let providerTier: string | undefined
  let providerUpgradeHint: string | undefined
  if (isExternalProvider) {
    const { providerName } = parseSource(step.source!)
    const provider = getProvider(providerName)
    const resolvedKey = resolveProviderKey(provider)
    const tier = resolvedKey?.tier ?? 'free'
    providerTier = tier
    providerUpgradeHint = getUpgradeHint(provider, tier)
    const rateLimit = provider.tiers[tier]?.ratePerMinute ?? null
    providerTracker = rateLimit ? getTracker(step.source!, rateLimit) : null
    concurrency = providerTracker ? deriveProviderConcurrency(providerTracker) : 10
  } else {
    concurrency = deriveConcurrency(currentRateLimit)
  }

  let latestRateLimit = currentRateLimit
  const results: unknown[] = []
  const rateLimitTracker: RateLimitTracker = { paused: false, waitedMs: 0 }
  const fallbackCounts = new Map<string, { count: number; names: string[] }>()
  let completedCount = 0
  let providerWaitMs = 0
  let providerWaitCount = 0

  // Worker pool: keep `concurrency` slots filled at all times.
  // As soon as one request completes, start the next — no idle slots.
  type ItemResult =
    | { success: true; item: unknown; data: unknown; rateLimit: RateLimitInfo | null }
    | { success: false; item: unknown; error: string; status?: number }

  const pending = new Set<Promise<void>>()
  let nextIdx = 0

  const processResult = (result: ItemResult) => {
    completedCount++
    onProgress?.({
      type: 'item_complete',
      provider: isExternalProvider ? step.source! : 'aixbt',
      waitMs: 0,
      completed: completedCount,
      total: items.length,
    })
    if (result.success) {
      let data = result.data

      if (step.transform) {
        data = applyTransforms(data, step.transform)
      }

      // Carry forward identifying fields from source item so agents
      // can correlate external provider data back to the parent item.
      if (result.item && typeof result.item === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const src = result.item as Record<string, unknown>
        const dst = data as Record<string, unknown>
        for (const key of ['id', '_id', 'name', 'symbol', 'slug']) {
          if (src[key] !== undefined && dst[`_source_${key}`] === undefined) {
            dst[`_source_${key}`] = src[key]
          }
        }
      }

      results.push(data)
      if (result.rateLimit) {
        latestRateLimit = result.rateLimit
      }
    } else {
      if (step.fallback) {
        const entry = fallbackCounts.get(result.error) ?? { count: 0, names: [] }
        entry.count++
        const src = result.item && typeof result.item === 'object' ? result.item as Record<string, unknown> : null
        const name = (src?.name ?? src?.symbol ?? src?.slug) as string | undefined
        if (name) entry.names.push(name)
        fallbackCounts.set(result.error, entry)
        const fallbackEntry: Record<string, unknown> = { _fallback: true }
        if (result.item && typeof result.item === 'object') {
          const src = result.item as Record<string, unknown>
          for (const key of ['id', '_id', 'name', 'symbol', 'slug']) {
            if (src[key] !== undefined) fallbackEntry[key] = src[key]
          }
        }
        results.push(fallbackEntry)
      } else {
        results.push({
          _error: true,
          item: result.item,
          error: result.error,
          status: result.status,
        })
      }
    }
  }

  const runItem = async (item: unknown): Promise<void> => {
    let result: ItemResult

    if (isExternalProvider) {
      // Pre-flight: wait for rate limit capacity before dispatching
      if (providerTracker) {
        const waitMs = waitForCapacity(providerTracker)
        if (waitMs > 0) {
          providerWaitMs += waitMs
          providerWaitCount++
          onProgress?.({
            type: 'rate_limit',
            provider: step.source!,
            waitMs,
            completed: completedCount,
            total: items.length,
            tier: providerTier,
            upgradeHint: providerUpgradeHint,
          })
          await sleep(waitMs)
        }
      }

      try {
        const data = await dispatchProviderStep(step.source!, step.action, step.params, ctx, item)
        result = { success: true, item, data, rateLimit: null }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        result = { success: false, item, error, status }
      }
    } else {
      // AIXBT rate-limit check before each request
      if (latestRateLimit && latestRateLimit.remainingPerMinute <= 2) {
        const waitMs = computeWaitTime(latestRateLimit)
        onProgress?.({
          type: 'rate_limit',
          provider: 'aixbt',
          waitMs,
          completed: completedCount,
          total: items.length,
        })
      }
      await waitIfRateLimited(latestRateLimit, rateLimitTracker)

      const actionPath = AIXBT_ACTION_PATHS[step.action] ?? step.action
      const resolvedParams = flattenParams(step.params, ctx, item)

      // Auto-inject `at` from recipe-level params (same as engine.ts)
      if (ctx.params.at && resolvedParams.at === undefined) {
        if (AT_SUPPORTED_ACTIONS.has(step.action)) {
          resolvedParams.at = resolveRelativeTime(ctx.params.at)
        }
      }

      const substitutedPath = substitutePathParams(actionPath, resolvedParams)
      const { path } = resolveActionPath(substitutedPath, ctx, item)

      try {
        const response = await get(path, resolvedParams, clientOptions)
        result = { success: true, item, data: response.data, rateLimit: response.rateLimit }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        result = { success: false, item, error, status }
      }
    }

    processResult(result)
  }

  const startNext = () => {
    if (nextIdx >= items.length) return
    const item = items[nextIdx++]
    const p = runItem(item).then(() => {
      pending.delete(p)
      startNext()
    })
    pending.add(p)
  }

  // Fill initial slots
  for (let i = 0; i < concurrency && i < items.length; i++) {
    startNext()
  }

  // Wait for all to complete
  while (pending.size > 0) {
    await Promise.race(pending)
  }

  if (fallbackCounts.size > 0) {
    process.stderr.write('\n')
    for (const [error, { count, names }] of fallbackCounts) {
      const namesSuffix = names.length > 0 ? ` [${names.join(', ')}]` : ''
      console.error(`${fmt.dim('⚠')} ${fmt.dim(step.id)}: ${count}/${items.length} used fallback${fmt.dim(namesSuffix)} ${fmt.dim(`(${error})`)}`)
    }
    if (step.fallback) {
      const totalFallbacks = [...fallbackCounts.values()].reduce((sum, { count }) => sum + count, 0)
      let fallbackText = step.fallback.replace(/\.$/, '').toLowerCase()
      if (totalFallbacks > 1) {
        fallbackText = fallbackText.replace(/\bthis project\b/, 'these projects').replace(/\bthis chain\b/, 'these chains')
      }
      console.error(fmt.yellow(`└ ${totalFallbacks}/${items.length}: agent will be asked to use its available tools to ${fallbackText}`))
    }
  }

  // Build a collated fallback note for agents
  let fallbackNote: string | undefined
  const fallbackItems = results.filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && (r as Record<string, unknown>)._fallback === true,
  )
  if (fallbackItems.length > 0 && step.fallback) {
    const names = fallbackItems
      .map((f) => f.name || f.slug || f.symbol || f.id || 'unknown')
      .map(String)
    fallbackNote = `${step.fallback.replace(/\.$/, '')} for: ${names.join(', ')}`
  }

  const failures = results.filter(isErrorMarker)
  if (failures.length > 0) {
    const firstError = (failures[0] as { error: string }).error
    if (failures.length === items.length) {
      throw new CliError(
        `Foreach step "${step.id}": all ${items.length} items failed. First error: ${firstError}`,
        'FOREACH_ALL_FAILED',
      )
    }
    console.error(`${fmt.dim('⚠')} ${fmt.dim(step.id)}: ${failures.length}/${items.length} items failed`)
  }

  const completedAt = new Date()

  return {
    stepId: step.id,
    data: results,
    rateLimit: latestRateLimit,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(rateLimitTracker.paused ? { rateLimitPaused: true, waitedMs: rateLimitTracker.waitedMs } : {}),
      ...(providerWaitMs > 0 ? { providerRateLimited: true, providerWaitMs, providerWaitCount } : {}),
    },
    items: results.filter((item) => !isErrorMarker(item)),
    failures: failures as ForeachFailure[],
    ...(fallbackNote ? { _fallbackNote: fallbackNote } : {}),
  }
}
