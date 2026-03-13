import type {
  ExecutionContext, ForeachStep, ForeachResult,
  ForeachFailure, RateLimitInfo,
} from '../../types.js'
import { resolveEndpoint, flattenParams } from './template.js'
import { applyTransforms } from '../transforms.js'
import { get, sleep } from '../api-client.js'

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

  let concurrency = deriveConcurrency(currentRateLimit)
  let latestRateLimit = currentRateLimit
  const successItems: unknown[] = []
  const failures: ForeachFailure[] = []
  const rateLimitTracker: RateLimitTracker = { paused: false, waitedMs: 0 }

  let offset = 0
  while (offset < items.length) {
    await waitIfRateLimited(latestRateLimit, rateLimitTracker)

    const batch = items.slice(offset, offset + concurrency)
    offset += batch.length

    const batchPromises = batch.map(async (item) => {
      const { path } = resolveEndpoint(step.endpoint, ctx, item)
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

        successItems.push(data)
        if (result.rateLimit) {
          latestRateLimit = result.rateLimit
        }
      } else {
        failures.push({
          item: result.item,
          error: result.error,
          status: result.status,
        })
      }
    }

    // Recalculate concurrency based on latest rate limit info
    concurrency = deriveConcurrency(latestRateLimit)
  }

  const completedAt = new Date()

  return {
    stepId: step.id,
    data: successItems,
    rateLimit: latestRateLimit,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(rateLimitTracker.paused ? { rateLimitPaused: true, waitedMs: rateLimitTracker.waitedMs } : {}),
    },
    items: successItems,
    failures,
  }
}
