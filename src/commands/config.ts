import type { Command } from 'commander'
import { readConfig, writeConfig } from '../lib/config.js'
import { CliError } from '../lib/errors.js'
import * as output from '../lib/output.js'

const ALLOWED_KEYS = ['apiKey', 'apiUrl', 'keyType', 'expiresAt', 'scopes'] as const
type AllowedKey = (typeof ALLOWED_KEYS)[number]

function isAllowedKey(key: string): key is AllowedKey {
  return (ALLOWED_KEYS as readonly string[]).includes(key)
}

function formatValue(key: AllowedKey, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (key === 'apiKey' && typeof value === 'string') return output.maskApiKey(value)
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage CLI configuration')

  config
    .command('get [key]')
    .description('Show config value(s)')
    .action((key: string | undefined, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const isJson = opts.json === true
      const cfg = readConfig()

      if (key !== undefined) {
        if (!isAllowedKey(key)) {
          throw new CliError(`Unknown config key: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`, 'INVALID_CONFIG_KEY')
        }

        const rawValue = cfg[key]

        if (isJson) {
          output.json({ [key]: rawValue ?? null })
        } else {
          const display = formatValue(key, rawValue)
          console.log(display)
        }
        return
      }

      // Show all config values
      if (isJson) {
        output.json(cfg)
      } else {
        for (const k of ALLOWED_KEYS) {
          const val = cfg[k]
          if (val !== undefined) {
            output.keyValue(k, formatValue(k, val))
          }
        }
      }
    })

  config
    .command('set <key> <value>')
    .description('Set a config value')
    .action((key: string, value: string, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const isJson = opts.json === true

      if (!isAllowedKey(key)) {
        throw new CliError(`Unknown config key: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`, 'INVALID_CONFIG_KEY')
      }

      const cfg = readConfig()

      if (key === 'scopes') {
        cfg.scopes = value.split(',').map(s => s.trim())
      } else {
        cfg[key] = value
      }

      writeConfig(cfg)

      if (isJson) {
        output.json({ key, value: cfg[key] })
      } else {
        output.success(`Set ${key}`)
      }
    })
}
