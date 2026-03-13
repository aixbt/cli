import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { KeyType } from '../types.js'
import type { OutputFormat } from './output.js'

// -- Types --

export interface AixbtConfig {
  apiKey?: string
  apiUrl?: string
  keyType?: KeyType
  expiresAt?: string    // ISO 8601 or null
  scopes?: string[]
  format?: string
  limit?: number
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

export interface ResolvedConfig {
  apiKey: string | undefined
  apiUrl: string
  keyType: KeyType | undefined
  expiresAt: string | undefined
  scopes: string[]
  format: OutputFormat
  limit: number | undefined
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

  return {
    apiKey: flags?.apiKey || process.env.AIXBT_API_KEY || config.apiKey,
    apiUrl: flags?.apiUrl || process.env.AIXBT_API_URL || config.apiUrl || DEFAULT_API_URL,
    keyType: config.keyType,
    expiresAt: config.expiresAt,
    scopes: config.scopes ?? [],
    format: validateFormat(resolvedFormat),
    limit: resolvedLimit,
  }
}

export function resolveFormat(flagValue?: string): OutputFormat {
  const config = readConfig()
  const resolved = flagValue
    || config.format
    || 'human'
  return validateFormat(resolved)
}
