import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// -- Types --

export interface AixbtConfig {
  apiKey?: string
  apiUrl?: string
  keyType?: string      // 'full' | 'x402' | 'demo'
  expiresAt?: string    // ISO 8601 or null
  scopes?: string[]
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
  keyType: string | undefined
  expiresAt: string | undefined
  scopes: string[]
}

export function resolveConfig(flags?: {
  apiKey?: string
  apiUrl?: string
}): ResolvedConfig {
  const config = readConfig()

  return {
    apiKey: flags?.apiKey || process.env.AIXBT_API_KEY || config.apiKey,
    apiUrl: flags?.apiUrl || process.env.AIXBT_API_URL || config.apiUrl || DEFAULT_API_URL,
    keyType: config.keyType,
    expiresAt: config.expiresAt,
    scopes: config.scopes ?? [],
  }
}
