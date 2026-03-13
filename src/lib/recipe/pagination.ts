import type { RateLimitInfo } from '../../types.js'
import { get, type ApiClientOptions } from '../api-client.js'
import { CliError } from '../errors.js'
import { waitIfRateLimited, type RateLimitTracker } from './foreach.js'

export const MAX_PAGE_LIMIT = 50

export interface PaginationOptions {
  path: string
  baseParams: Record<string, string | number | boolean | undefined>
  targetLimit: number
  stepId: string
  clientOptions: ApiClientOptions
  currentRateLimit: RateLimitInfo | null
}

export interface PaginationResult {
  data: unknown[]
  rateLimit: RateLimitInfo | null
  pageCount: number
  rateLimitPaused: boolean
  waitedMs: number
}

export async function paginateApiStep(options: PaginationOptions): Promise<PaginationResult> {
  const { path, baseParams, targetLimit, stepId, clientOptions } = options
  let currentRateLimit = options.currentRateLimit

  const allData: unknown[] = []
  let page = 1
  const rateLimitTracker: RateLimitTracker = { paused: false, waitedMs: 0 }

  const pageSize = MAX_PAGE_LIMIT
  const maxPages = Math.ceil(targetLimit / pageSize)

  while (page <= maxPages) {
    if (page > 1) {
      await waitIfRateLimited(currentRateLimit, rateLimitTracker)
    }

    const remaining = targetLimit - allData.length
    const perPageLimit = Math.min(pageSize, remaining)

    const pageParams = {
      ...baseParams,
      page,
      limit: perPageLimit,
    }

    let response
    try {
      response = await get(path, pageParams, clientOptions)
    } catch (err) {
      if (err instanceof CliError) {
        err.message = `Step "${stepId}" failed on page ${page}: ${err.message}`
        throw err
      }
      throw new CliError(
        `Step "${stepId}" failed on page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        'PAGINATION_FAILED',
      )
    }

    if (response.rateLimit) {
      currentRateLimit = response.rateLimit
    }

    const pageData = Array.isArray(response.data) ? response.data : [response.data]
    allData.push(...pageData)

    if (!response.pagination?.hasMore) break
    if (allData.length >= targetLimit) break

    page++
  }

  return {
    data: allData,
    rateLimit: currentRateLimit,
    pageCount: page,
    rateLimitPaused: rateLimitTracker.paused,
    waitedMs: rateLimitTracker.waitedMs,
  }
}
