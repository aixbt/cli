import type { Command } from 'commander'
import { password } from '@inquirer/prompts'
import { readConfig, writeConfig, resolveConfig } from '../lib/config.js'
import { validateApiKey, type ApiKeyInfo } from '../lib/auth.js'
import * as output from '../lib/output.js'
import { CliError } from '../lib/errors.js'

export function registerLoginCommand(program: Command): void {
  // -- login --
  program
    .command('login')
    .description('Authenticate with AIXBT API')
    .option('--api-key <key>', 'API key (non-interactive)')
    .option('--purchase-pass [duration]', 'Purchase a time-limited pass via x402')
    .option('--payment-signature <base64>', 'Payment signature for x402 pass purchase')
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const isJson = opts.json === true

      // Handle purchase-pass stub
      if (opts.purchasePass !== undefined) {
        if (isJson) {
          output.json({ error: 'not_implemented', message: 'Pass purchase via x402 is not yet implemented' })
        } else {
          output.warn('Pass purchase via x402 is not yet implemented.')
        }
        return
      }

      // Get API key: flag, or interactive prompt
      let apiKey: string
      if (opts.apiKey) {
        apiKey = opts.apiKey as string
      } else {
        apiKey = await password({
          message: 'Paste your API key:',
          mask: '*',
          theme: output.aixbtTheme,
        })
      }

      if (!apiKey.trim()) {
        throw new CliError('API key cannot be empty', 'INVALID_INPUT')
      }
      apiKey = apiKey.trim()

      // Validate key against API
      let spin: ReturnType<typeof output.spinner> | undefined
      if (!isJson) {
        spin = output.spinner('Validating API key...')
      }

      let keyInfo: ApiKeyInfo
      try {
        keyInfo = await validateApiKey(apiKey, opts.apiUrl as string | undefined)
      } catch (err) {
        spin?.fail('Validation failed')
        throw err
      }

      spin?.succeed('API key validated')

      // Store in config
      const config = readConfig()
      config.apiKey = apiKey
      config.keyType = keyInfo.type
      config.expiresAt = keyInfo.expiresAt
      config.scopes = keyInfo.scopes
      writeConfig(config)

      if (isJson) {
        output.json({
          status: 'authenticated',
          keyType: keyInfo.type,
          scopes: keyInfo.scopes,
          expiresAt: keyInfo.expiresAt,
        })
      } else {
        output.success('Authenticated successfully')
        output.keyValue('Key type', keyInfo.type)
        output.keyValue('Scopes', keyInfo.scopes.join(', ') || 'none')
        output.keyValue('Expires', formatExpiry(keyInfo.expiresAt))
      }
    })

  // -- logout --
  program
    .command('logout')
    .description('Remove stored API credentials')
    .action((_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const isJson = opts.json === true

      const config = readConfig()
      delete config.apiKey
      delete config.keyType
      delete config.expiresAt
      delete config.scopes
      writeConfig(config)

      if (isJson) {
        output.json({ status: 'logged_out' })
      } else {
        output.success('Logged out. API key removed from config.')
      }
    })

  // -- whoami --
  program
    .command('whoami')
    .description('Show current authentication status')
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const isJson = opts.json === true

      const resolved = resolveConfig({
        apiKey: opts.apiKey as string | undefined,
        apiUrl: opts.apiUrl as string | undefined,
      })

      if (!resolved.apiKey) {
        if (isJson) {
          output.json({ authenticated: false })
        } else {
          output.info('Not authenticated. Run: aixbt login')
        }
        return
      }

      // Always validate against API
      let spin: ReturnType<typeof output.spinner> | undefined
      if (!isJson) {
        spin = output.spinner('Checking authentication...')
      }

      let keyInfo: ApiKeyInfo
      try {
        keyInfo = await validateApiKey(resolved.apiKey, resolved.apiUrl)
      } catch (err) {
        spin?.fail('Authentication check failed')
        throw err
      }

      spin?.succeed('Authenticated')

      // Check expiry warning
      const expiryWarning = isExpiringSoon(keyInfo.expiresAt)

      if (isJson) {
        output.json({
          authenticated: true,
          key: output.maskApiKey(resolved.apiKey),
          keyType: keyInfo.type,
          scopes: keyInfo.scopes,
          expiresAt: keyInfo.expiresAt,
          expiringSoon: expiryWarning,
        })
      } else {
        output.keyValue('Key', output.maskApiKey(resolved.apiKey))
        output.keyValue('Key type', keyInfo.type)
        output.keyValue('Scopes', keyInfo.scopes.join(', ') || 'none')
        output.keyValue('Expires', formatExpiry(keyInfo.expiresAt))
        if (expiryWarning) {
          output.warn('API key expires in less than 24 hours!')
        }
      }
    })
}

function formatExpiry(expiresAt: string): string {
  if (expiresAt === 'never') return 'never'
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return expiresAt
  return date.toLocaleString()
}

function isExpiringSoon(expiresAt: string): boolean {
  if (expiresAt === 'never') return false
  const date = new Date(expiresAt)
  if (isNaN(date.getTime())) return false
  const hoursUntilExpiry = (date.getTime() - Date.now()) / (1000 * 60 * 60)
  return hoursUntilExpiry > 0 && hoursUntilExpiry < 24
}
