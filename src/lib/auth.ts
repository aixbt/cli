import { resolveConfig, type ResolvedConfig } from './config.js'
import { NoApiKeyError } from './errors.js'
import { get, type ApiClientOptions } from './api-client.js'

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

export function buildClientOptions(authMode: AuthMode, globalOpts: { apiUrl?: string }): ApiClientOptions {
  if (authMode.mode === 'api-key') {
    return { apiKey: authMode.apiKey, apiUrl: authMode.config.apiUrl }
  }
  return { noAuth: true, apiUrl: globalOpts.apiUrl }
}
