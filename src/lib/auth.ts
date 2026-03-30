import type { Command } from 'commander'
import type { KeyType } from '../types.js'
import { readConfig, resolveConfig, type KeySource, type ResolvedConfig } from './config.js'
import { NoApiKeyError, AuthError } from './errors.js'
import { get, type ApiClientOptions } from './api-client.js'
import type { OutputFormat } from './output.js'
import { setTimeAnchor } from './output.js'
import { resolveDate } from './date.js'

// Auth mode discriminated union
export type AuthMode =
  | { mode: 'api-key'; apiKey: string; config: ResolvedConfig }
  | { mode: 'delayed' }
  | { mode: 'pay-per-use' }

interface AuthModeFlags {
  delayed?: boolean
  payPerUse?: boolean
  paymentSignature?: string
  apiKey?: string
  apiUrl?: string
}

export interface ApiKeyInfo {
  id: string
  name?: string
  type: KeyType
  scopes: string[]
  expiresAt: string  // ISO 8601 or "never"
}

export function resolveAuthMode(flags: AuthModeFlags, resolved?: ResolvedConfig): AuthMode {
  if (flags.delayed) {
    return { mode: 'delayed' }
  }
  if (flags.payPerUse) {
    return { mode: 'pay-per-use' }
  }
  if (flags.paymentSignature) {
    return { mode: 'pay-per-use' }
  }
  const config = resolved ?? resolveConfig({
    apiKey: flags.apiKey,
    apiUrl: flags.apiUrl,
  })
  if (config.apiKey) {
    return { mode: 'api-key', apiKey: config.apiKey, config }
  }
  throw new NoApiKeyError()
}

export async function validateApiKey(apiKey: string, apiUrl?: string): Promise<ApiKeyInfo> {
  const result = await get<ApiKeyInfo>('/v2/api-keys/info', undefined, {
    apiKey,
    apiUrl,
  })
  return result.data
}

export function buildClientOptions(
  authMode: AuthMode,
  globalOpts: { apiUrl?: string; paymentSignature?: string },
): ApiClientOptions {
  const base: ApiClientOptions = authMode.mode === 'api-key'
    ? { apiKey: authMode.apiKey, apiUrl: authMode.config.apiUrl }
    : { noAuth: true, apiUrl: globalOpts.apiUrl }

  if (authMode.mode === 'pay-per-use') {
    base.pathPrefix = '/x402'
  }

  if (globalOpts.paymentSignature) {
    base.paymentSignature = globalOpts.paymentSignature
    base.pathPrefix = '/x402'
    base.noAuth = true
  }
  return base
}

export function formatExpiry(expiresAt: string): string {
  if (expiresAt === 'never') return 'never'
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return expiresAt
  return date.toLocaleString()
}

export function isExpiringSoon(expiresAt: string, keyName?: string): boolean {
  if (expiresAt === 'never') return false
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return false
  const hoursUntilExpiry = (date.getTime() - Date.now()) / (1000 * 60 * 60)
  if (hoursUntilExpiry <= 0) return false
  const threshold = getExpiryThresholdHours(keyName)
  return hoursUntilExpiry < threshold
}

export function isExpired(expiresAt: string): boolean {
  if (expiresAt === 'never') return false
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return false
  return date.getTime() < Date.now()
}

export function parseX402Period(name?: string): string | undefined {
  if (!name) return undefined
  const match = name.match(/^x402-(1d|1w|4w)-/)
  return match?.[1]
}

function getExpiryThresholdHours(keyName?: string): number {
  const period = parseX402Period(keyName)
  if (period === '1d') return 2
  return 24
}

export function formatTimeRemaining(expiresAt: string): string {
  if (expiresAt === 'never') return 'never expires'
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return expiresAt
  const msRemaining = date.getTime() - Date.now()
  if (msRemaining <= 0) return 'expired'
  const hours = Math.floor(msRemaining / (1000 * 60 * 60))
  const minutes = Math.floor((msRemaining % (1000 * 60 * 60)) / (1000 * 60))
  if (hours >= 48) return `${Math.floor(hours / 24)}d remaining`
  if (hours >= 1) return `${hours}h remaining`
  return `${minutes}m remaining`
}

/**
 * Get the fallback API key when the active key fails auth.
 * Only falls back from env → config. Flag keys don't fall back (user was explicit).
 */
export function getFallbackApiKey(activeSource: KeySource | undefined): string | undefined {
  if (activeSource !== 'env') return undefined
  const config = readConfig()
  const envKey = process.env.AIXBT_API_KEY
  if (config.apiKey && config.apiKey !== envKey) return config.apiKey
  return undefined
}

/**
 * Wrap an async API call with auth fallback.
 * If the primary key gets a 401 and a fallback key is available, retries with it.
 */
export async function withAuthFallback<T>(
  fn: (clientOpts: ApiClientOptions) => Promise<T>,
  clientOpts: ApiClientOptions,
  keySource: KeySource | undefined,
  onFallback?: () => void,
): Promise<T> {
  try {
    return await fn(clientOpts)
  } catch (err) {
    if (err instanceof AuthError) {
      const fallbackKey = getFallbackApiKey(keySource)
      if (fallbackKey) {
        onFallback?.()
        return fn({ ...clientOpts, apiKey: fallbackKey })
      }
    }
    throw err
  }
}

export function getClientOptions(cmd: Command): {
  clientOpts: ApiClientOptions
  authMode: AuthMode
  outputFormat: OutputFormat
  verbosity: number
  limit: number | undefined
} {
  const opts = cmd.optsWithGlobals()

  const resolved = resolveConfig({
    apiKey: opts.apiKey as string | undefined,
    apiUrl: opts.apiUrl as string | undefined,
    format: opts.format as string | undefined,
    limit: opts.limit as string | undefined,
  })

  const outputFormat = resolved.format
  const verbosity = (opts.verbose as number) ?? 0
  const limit = resolved.limit ?? (outputFormat === 'human' ? 25 : undefined)

  const authMode = resolveAuthMode({
    delayed: opts.delayed as boolean | undefined,
    payPerUse: opts.payPerUse as boolean | undefined,
    paymentSignature: opts.paymentSignature as string | undefined,
  }, resolved)

  const clientOpts = buildClientOptions(authMode, {
    apiUrl: opts.apiUrl as string | undefined,
    paymentSignature: opts.paymentSignature as string | undefined,
  })

  // Set time anchor for relative displays when --at is active
  const atValue = resolveDate(opts.at as string | undefined)
  if (atValue) {
    const anchor = new Date(atValue)
    if (!isNaN(anchor.getTime())) setTimeAnchor(anchor)
  }

  return { clientOpts, authMode, outputFormat, verbosity, limit }
}

/**
 * Like getClientOptions but never throws on missing API key.
 * For public reference endpoints (clusters, chains) that return current
 * data for everyone — use the key if available, otherwise unauthenticated.
 */
export function getPublicClientOptions(cmd: Command): {
  clientOpts: ApiClientOptions
  outputFormat: OutputFormat
  verbosity: number
} {
  const opts = cmd.optsWithGlobals()

  const resolved = resolveConfig({
    apiKey: opts.apiKey as string | undefined,
    apiUrl: opts.apiUrl as string | undefined,
    format: opts.format as string | undefined,
    limit: opts.limit as string | undefined,
  })

  const outputFormat = resolved.format
  const verbosity = (opts.verbose as number) ?? 0

  // Use the key if available for better rate limits, otherwise go unauthenticated
  const authMode: AuthMode = resolved.apiKey
    ? { mode: 'api-key', apiKey: resolved.apiKey, config: resolved }
    : { mode: 'delayed' }

  const clientOpts = buildClientOptions(authMode, {
    apiUrl: opts.apiUrl as string | undefined,
  })

  return { clientOpts, outputFormat, verbosity }
}
