import type { RateLimitInfo, ApiResponse } from '../types.js'
import { resolveConfig } from './config.js'
import { ApiError, RateLimitError, AuthError, NetworkError, PaymentRequiredError } from './errors.js'

export type { ApiClientOptions }

interface ApiClientOptions {
  apiKey?: string
  apiUrl?: string
  noAuth?: boolean
  pathPrefix?: string
  paymentSignature?: string
  userAgent?: string
}

function parseRateLimitHeaders(headers: Headers): RateLimitInfo | null {
  const limitMinute = headers.get('x-ratelimit-limit-minute')
  if (!limitMinute) return null

  return {
    limitPerMinute: parseInt(limitMinute, 10),
    remainingPerMinute: parseInt(headers.get('x-ratelimit-remaining-minute') ?? '0', 10),
    resetMinute: headers.get('x-ratelimit-reset-minute') ?? '',
    limitPerDay: parseInt(headers.get('x-ratelimit-limit-day') ?? '0', 10),
    remainingPerDay: parseInt(headers.get('x-ratelimit-remaining-day') ?? '0', 10),
    resetDay: headers.get('x-ratelimit-reset-day') ?? '',
    retryAfterSeconds: headers.has('retry-after')
      ? parseInt(headers.get('retry-after')!, 10)
      : undefined,
  }
}

import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'))
const DEFAULT_USER_AGENT = `@aixbt/cli/${pkg.version}`
const MAX_RETRIES = 3

export async function apiRequest<T>(
  method: string,
  path: string,
  options: ApiClientOptions = {},
  queryParams?: Record<string, string | number | boolean | undefined>,
): Promise<ApiResponse<T>> {
  const config = resolveConfig({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
  })

  const baseUrl = config.apiUrl.replace(/\/$/, '')
  const finalPath = options.pathPrefix ? `${options.pathPrefix}${path}` : path
  const url = new URL(finalPath, baseUrl)

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
  }

  if (!options.noAuth) {
    const apiKey = options.apiKey ?? config.apiKey
    if (apiKey) {
      headers['X-API-Key'] = apiKey
    }
  }

  if (options.paymentSignature) {
    headers['PAYMENT-SIGNATURE'] = options.paymentSignature
  }

  return executeWithBackoff<T>(method, url.toString(), headers)
}

/**
 * Make an authenticated POST request returning the raw JSON response body.
 * Unlike apiRequest(), this does not assume the standard { status, data } wrapper.
 */
export async function postRaw<T>(
  path: string,
  body: unknown,
  options: ApiClientOptions = {},
): Promise<T> {
  const config = resolveConfig({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
  })

  const baseUrl = config.apiUrl.replace(/\/$/, '')
  const finalPath = options.pathPrefix ? `${options.pathPrefix}${path}` : path
  const url = new URL(finalPath, baseUrl)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
  }

  if (!options.noAuth) {
    const apiKey = options.apiKey ?? config.apiKey
    if (apiKey) {
      headers['X-API-Key'] = apiKey
    }
  }

  if (options.paymentSignature) {
    headers['PAYMENT-SIGNATURE'] = options.paymentSignature
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : 'Network request failed',
    )
  }

  if (res.status === 401) {
    const resBody = await safeJson(res)
    throw new AuthError(
      resBody?.message as string ?? 'Unauthorized',
      resBody?.code as string | undefined,
    )
  }

  if (res.status === 402) {
    const resBody = await safeJson(res)
    throw new PaymentRequiredError(resBody, res.headers)
  }

  if (!res.ok) {
    const resBody = await safeJson(res)
    throw new ApiError(
      res.status,
      (resBody?.error ?? resBody?.message ?? res.statusText) as string,
      resBody?.code as string | undefined,
    )
  }

  try {
    return await res.json() as T
  } catch {
    throw new ApiError(res.status, 'Invalid JSON in API response', 'INVALID_RESPONSE')
  }
}

async function executeWithBackoff<T>(
  method: string,
  url: string,
  headers: Record<string, string>,
  attempt = 0,
): Promise<ApiResponse<T>> {
  let res: Response
  try {
    res = await fetch(url, { method, headers })
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : 'Network request failed',
    )
  }

  const rateLimit = parseRateLimitHeaders(res.headers)

  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new RateLimitError(
        'Rate limit exceeded after maximum retries',
        rateLimit,
      )
    }

    const retryAfter = rateLimit?.retryAfterSeconds ?? 60
    await sleep(retryAfter * 1000)
    return executeWithBackoff<T>(method, url, headers, attempt + 1)
  }

  if (res.status === 401) {
    const body = await safeJson(res)
    throw new AuthError(
      body?.message as string ?? 'Unauthorized',
      body?.code as string | undefined,
    )
  }

  if (res.status === 402) {
    const body = await safeJson(res)
    throw new PaymentRequiredError(body, res.headers)
  }

  if (!res.ok) {
    const body = await safeJson(res)
    throw new ApiError(
      res.status,
      (body?.error ?? body?.message ?? res.statusText) as string,
      body?.code as string | undefined,
    )
  }

  let body: { status: number; data: T; error?: string; meta?: unknown; pagination?: unknown }
  try {
    body = await res.json() as typeof body
  } catch {
    throw new ApiError(res.status, 'Invalid JSON in API response', 'INVALID_RESPONSE')
  }

  const paymentResponse = decodeBase64JsonHeader<Record<string, unknown>>(res.headers, 'payment-response')

  const meta = body.meta as ApiResponse<T>['meta']

  return {
    status: body.status,
    data: body.data,
    meta,
    pagination: body.pagination as ApiResponse<T>['pagination'],
    rateLimit,
    paymentResponse,
  }
}

export async function get<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options?: ApiClientOptions,
): Promise<ApiResponse<T>> {
  return apiRequest<T>('GET', path, options, params)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Decode a base64-encoded JSON header value.
 * Returns null if the header is missing or malformed.
 */
export function decodeBase64JsonHeader<T>(headers: Headers, name: string): T | null {
  const raw = headers.get(name)
  if (!raw) return null

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    return JSON.parse(decoded) as T
  } catch {
    return null
  }
}
