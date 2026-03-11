import type { Command } from 'commander'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { NoApiKeyError } from './errors.js'
import { get, type ApiClientOptions } from './api-client.js'
import type { OutputFormat } from './output.js'

// Auth mode discriminated union
export type AuthMode =
  | { mode: 'api-key'; apiKey: string; config: ResolvedConfig }
  | { mode: 'delayed' }
  | { mode: 'pay-per-use' }

interface AuthModeFlags {
  delayed?: boolean
  payPerUse?: boolean
  apiKey?: string
  apiUrl?: string
}

export interface ApiKeyInfo {
  id: string
  type: 'demo' | 'full' | 'x402'
  scopes: string[]
  expiresAt: string  // ISO 8601 or "never"
}

export function resolveAuthMode(flags: AuthModeFlags): AuthMode {
  if (flags.delayed) {
    return { mode: 'delayed' }
  }
  if (flags.payPerUse) {
    return { mode: 'pay-per-use' }
  }
  const config = resolveConfig({
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

  if (globalOpts.paymentSignature) {
    base.paymentSignature = globalOpts.paymentSignature
  }
  return base
}

export function formatExpiry(expiresAt: string): string {
  if (expiresAt === 'never') return 'never'
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return expiresAt
  return date.toLocaleString()
}

export function isExpiringSoon(expiresAt: string): boolean {
  if (expiresAt === 'never') return false
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return false
  const hoursUntilExpiry = (date.getTime() - Date.now()) / (1000 * 60 * 60)
  return hoursUntilExpiry > 0 && hoursUntilExpiry < 24
}

export function getClientOptions(cmd: Command): {
  clientOpts: ApiClientOptions
  authMode: AuthMode
  outputFormat: OutputFormat
  full: boolean
} {
  const opts = cmd.optsWithGlobals()
  const outputFormat = (opts.format as OutputFormat) ?? 'table'
  const full = Boolean(opts.full)
  const authMode = resolveAuthMode({
    delayed: opts.delayed as boolean | undefined,
    payPerUse: opts.payPerUse as boolean | undefined,
    apiKey: opts.apiKey as string | undefined,
    apiUrl: opts.apiUrl as string | undefined,
  })
  const clientOpts = buildClientOptions(authMode, {
    apiUrl: opts.apiUrl as string | undefined,
    paymentSignature: opts.paymentSignature as string | undefined,
  })
  return { clientOpts, authMode, outputFormat, full }
}
