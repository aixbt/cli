// Shared types for @aixbt/cli

export interface RateLimitInfo {
  limitPerMinute: number
  remainingPerMinute: number
  resetMinute: string         // ISO 8601
  limitPerDay: number
  remainingPerDay: number
  resetDay: string            // ISO 8601
  retryAfterSeconds?: number  // Only present on 429
}

export interface ApiResponse<T> {
  status: number
  data: T
  rateLimit: RateLimitInfo | null
}

export interface PaginatedApiResponse<T> {
  status: number
  data: T[]
  pagination: {
    page: number
    limit: number
    totalCount: number
    hasMore: boolean
  }
  rateLimit: RateLimitInfo | null
}
