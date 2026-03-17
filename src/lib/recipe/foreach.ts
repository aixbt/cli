import type {
  ExecutionContext, ForeachStep, ForeachResult,
  ForeachFailure, RateLimitInfo,
} from '../../types.js'
import { resolveActionPath, flattenParams } from './template.js'
import { applyTransforms } from '../transforms.js'
import { get, sleep } from '../api-client.js'
import { CliError } from '../errors.js'
import { getProvider } from '../providers/registry.js'
import { dispatchProviderStep } from '../providers/client.js'
import { resolveProviderKey } from '../providers/config.js'
import { getTracker, deriveProviderConcurrency } from '../providers/rate-limit.js'
import { AIXBT_ACTION_PATHS } from '../providers/aixbt.js'

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

export interface ForeachOptions {
  step: ForeachStep
  items: unknown[]
  ctx: ExecutionContext
  clientOptions: import('../api-client.js').ApiClientOptions
  currentRateLimit: RateLimitInfo | null
}

export async function executeForeach(options: ForeachOptions): Promise<ForeachResult> {
  const { step, items, ctx, clientOptions, currentRateLimit } = options
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
  if (isExternalProvider) {
    const provider = getProvider(step.source!)
    const resolvedKey = resolveProviderKey(provider.name)
    const tier = resolvedKey?.tier ?? 'free'
    const rateLimit = provider.rateLimits.perMinute[tier] ?? null
    const tracker = rateLimit ? getTracker(step.source!, rateLimit) : null
    concurrency = tracker ? deriveProviderConcurrency(tracker) : 3
  } else {
    concurrency = deriveConcurrency(currentRateLimit)
  }

  let latestRateLimit = currentRateLimit
  const results: unknown[] = []
  const rateLimitTracker: RateLimitTracker = { paused: false, waitedMs: 0 }

  let offset = 0
  while (offset < items.length) {
    // waitIfRateLimited is AIXBT-specific; external providers handle rate limiting internally
    if (!isExternalProvider) {
      await waitIfRateLimited(latestRateLimit, rateLimitTracker)
    }

    const batch = items.slice(offset, offset + concurrency)
    offset += batch.length

    const batchPromises = batch.map(async (item) => {
      // External provider path
      if (isExternalProvider) {
        try {
          const data = await dispatchProviderStep(step.source!, step.action, step.params, ctx, item)
          return { success: true as const, data, rateLimit: null as RateLimitInfo | null }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          const status = (err as { status?: number }).status
          return { success: false as const, item, error, status }
        }
      }

      // AIXBT path — use existing resolveActionPath() + get()
      const actionPath = AIXBT_ACTION_PATHS[step.action] ?? step.action
      const { path } = resolveActionPath(actionPath, ctx, item)
      const resolvedParams = flattenParams(step.params, ctx, item)

      try {
        const response = await get(path, resolvedParams, clientOptions)
        return { success: true as const, data: response.data, rateLimit: response.rateLimit }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        return { success: false as const, item, error, status }
      }
    })

    const batchResults = await Promise.all(batchPromises)

    for (const result of batchResults) {
      if (result.success) {
        let data = result.data

        if (step.transform) {
          data = applyTransforms(data, step.transform)
        }

        results.push(data)
        if (result.rateLimit) {
          latestRateLimit = result.rateLimit
        }
      } else {
        results.push({
          _error: true,
          item: result.item,
          error: result.error,
          status: result.status,
        })
      }
    }

    // Recalculate concurrency based on latest rate limit info
    if (!isExternalProvider) {
      concurrency = deriveConcurrency(latestRateLimit)
    }
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
    console.error(`warning: foreach step "${step.id}": ${failures.length}/${items.length} items failed`)
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
    },
    items: results.filter((item) => !isErrorMarker(item)),
    failures: failures as ForeachFailure[],
  }
}
