import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { KeyType } from '../types.js'
import type { OutputFormat } from './output.js'
import type { ProviderKeyConfig } from './providers/types.js'

// -- Types --

export interface AixbtConfig {
  apiKey?: string
  apiUrl?: string
  keyType?: KeyType
  keyName?: string      // Key name from API (x402 names encode period: "x402-1w-...")
  expiresAt?: string    // ISO 8601 or null
  scopes?: string[]
  format?: string
  limit?: number
  agent?: string
  agentAllowedTools?: string[]
  providers?: Record<string, ProviderKeyConfig>
}

// -- Config path management --

const DEFAULT_CONFIG_DIR = join(homedir(), '.aixbt')
const DEFAULT_CONFIG_FILE = join(DEFAULT_CONFIG_DIR, 'config.json')

let configPathOverride: string | undefined

export function setConfigPath(path: string): void {
  configPathOverride = path
}

export function getConfigPath(): string {
  return configPathOverride || process.env.AIXBT_CONFIG || DEFAULT_CONFIG_FILE
}

export function getConfigDir(): string {
  return dirname(getConfigPath())
}

export function getRecipesDir(): string {
  return join(getConfigDir(), 'recipes')
}

// -- Read/Write --

function ensureConfigDir(): void {
  const configDir = dirname(getConfigPath())
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
}

export function readConfig(): AixbtConfig {
  const configFile = getConfigPath()
  if (!existsSync(configFile)) {
    return {}
  }
  try {
    const raw = readFileSync(configFile, 'utf-8')
    return JSON.parse(raw) as AixbtConfig
  } catch {
    // Corrupt or unreadable config file -- return empty defaults rather than crashing.
    // The user can fix it with `aixbt config set` or delete the file.
    return {}
  }
}

export function writeConfig(config: AixbtConfig): void {
  try {
    ensureConfigDir()
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to write config to ${getConfigPath()}: ${msg}`)
  }
}

export function clearConfig(): void {
  const configFile = getConfigPath()
  try {
    unlinkSync(configFile)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to remove config file ${configFile}: ${msg}`)
  }
}

// -- Resolution (3-layer: flag > env > config) --

export const DEFAULT_API_URL = 'https://api.aixbt.tech'

export type KeySource = 'flag' | 'env' | 'config'

export interface ResolvedConfig {
  apiKey: string | undefined
  keySource: KeySource | undefined
  apiUrl: string
  keyType: KeyType | undefined
  keyName: string | undefined
  expiresAt: string | undefined
  scopes: string[]
  format: OutputFormat
  limit: number | undefined
}

export interface DetectedKey {
  source: KeySource
  key: string
  keyType?: KeyType
  keyName?: string
  expiresAt?: string
}

const VALID_FORMATS: readonly string[] = ['human', 'json', 'toon']

function validateFormat(value: string): OutputFormat {
  return VALID_FORMATS.includes(value) ? value as OutputFormat : 'human'
}

export function resolveConfig(flags?: {
  apiKey?: string
  apiUrl?: string
  format?: string
  limit?: string
}): ResolvedConfig {
  const config = readConfig()

  const resolvedFormat = flags?.format
    || config.format
    || 'human'

  const resolvedLimit = flags?.limit
    ? parseInt(flags.limit, 10)
    : config.limit

  // Determine which key wins and its source
  let apiKey: string | undefined
  let keySource: KeySource | undefined
  if (flags?.apiKey) {
    apiKey = flags.apiKey
    keySource = 'flag'
  } else if (process.env.AIXBT_API_KEY) {
    apiKey = process.env.AIXBT_API_KEY
    keySource = 'env'
  } else if (config.apiKey) {
    apiKey = config.apiKey
    keySource = 'config'
  }

  // Config metadata applies if the resolved key matches the stored key
  const configMatches = apiKey !== undefined && apiKey === config.apiKey

  return {
    apiKey,
    keySource,
    apiUrl: flags?.apiUrl || process.env.AIXBT_API_URL || config.apiUrl || DEFAULT_API_URL,
    keyType: configMatches ? config.keyType : undefined,
    keyName: configMatches ? config.keyName : undefined,
    expiresAt: configMatches ? config.expiresAt : undefined,
    scopes: configMatches ? (config.scopes ?? []) : [],
    format: validateFormat(resolvedFormat),
    limit: resolvedLimit,
  }
}

/**
 * Detect all available API keys from all sources.
 * Returns them in priority order (flag > env > config), with config metadata where available.
 */
export function detectAllKeys(flagKey?: string): DetectedKey[] {
  const config = readConfig()
  const keys: DetectedKey[] = []

  if (flagKey) {
    const configMatches = flagKey === config.apiKey
    keys.push({
      source: 'flag',
      key: flagKey,
      keyType: configMatches ? config.keyType : undefined,
      keyName: configMatches ? config.keyName : undefined,
      expiresAt: configMatches ? config.expiresAt : undefined,
    })
  }

  const envKey = process.env.AIXBT_API_KEY
  if (envKey && envKey !== flagKey) {
    const configMatches = envKey === config.apiKey
    keys.push({
      source: 'env',
      key: envKey,
      keyType: configMatches ? config.keyType : undefined,
      keyName: configMatches ? config.keyName : undefined,
      expiresAt: configMatches ? config.expiresAt : undefined,
    })
  }

  if (config.apiKey && config.apiKey !== flagKey && config.apiKey !== envKey) {
    keys.push({
      source: 'config',
      key: config.apiKey,
      keyType: config.keyType,
      keyName: config.keyName,
      expiresAt: config.expiresAt,
    })
  }

  return keys
}

export function resolveFormat(flagValue?: string): OutputFormat {
  const config = readConfig()
  const resolved = flagValue
    || config.format
    || 'human'
  return validateFormat(resolved)
}
