import type { Command } from 'commander'
import { readConfig, writeConfig, resolveFormat } from '../lib/config.js'
import { CliError } from '../lib/errors.js'
import * as output from '../lib/output.js'

const ALLOWED_KEYS = ['format', 'apiUrl', 'limit'] as const
type AllowedKey = (typeof ALLOWED_KEYS)[number]

const VALID_FORMATS = ['human', 'json', 'toon'] as const

function isAllowedKey(key: string): key is AllowedKey {
  return (ALLOWED_KEYS as readonly string[]).includes(key)
}

function formatValue(key: AllowedKey, value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

function validateAndCoerce(key: AllowedKey, value: string): string | number {
  if (key === 'format') {
    if (!(VALID_FORMATS as readonly string[]).includes(value)) {
      throw new CliError(
        `Invalid format: ${value}. Must be one of: ${VALID_FORMATS.join(', ')}`,
        'INVALID_CONFIG_VALUE',
      )
    }
    return value
  }
  if (key === 'limit') {
    const n = parseInt(value, 10)
    if (isNaN(n) || n < 1) {
      throw new CliError(
        `Invalid limit: ${value}. Must be a positive integer`,
        'INVALID_CONFIG_VALUE',
      )
    }
    return n
  }
  return value
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config', { hidden: true })
    .description('Manage CLI configuration')

  config
    .command('get [key]')
    .description('Show config value(s)')
    .action((key: string | undefined, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(opts.format as string | undefined)
      const cfg = readConfig()

      if (key !== undefined) {
        if (!isAllowedKey(key)) {
          throw new CliError(`Unknown config key: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`, 'INVALID_CONFIG_KEY')
        }

        const rawValue = cfg[key]

        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ [key]: rawValue ?? null }, outputFormat)
        } else {
          const display = formatValue(key, rawValue)
          console.log(display)
        }
        return
      }

      // Show all config values
      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured(cfg, outputFormat)
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
      const outputFormat = resolveFormat(opts.format as string | undefined)

      if (!isAllowedKey(key)) {
        throw new CliError(`Unknown config key: ${key}. Allowed keys: ${ALLOWED_KEYS.join(', ')}`, 'INVALID_CONFIG_KEY')
      }

      const coerced = validateAndCoerce(key, value)
      const cfg = readConfig()

      if (key === 'limit') {
        cfg.limit = coerced as number
      } else if (key === 'format') {
        cfg.format = coerced as string
      } else if (key === 'apiUrl') {
        cfg.apiUrl = coerced as string
      }

      writeConfig(cfg)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({ key, value: cfg[key] }, outputFormat)
      } else {
        output.success(`Set ${key}`)
      }
    })
}
