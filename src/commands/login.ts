import type { Command } from 'commander'
import { password } from '@inquirer/prompts'
import { readConfig, writeConfig, resolveConfig } from '../lib/config.js'
import { validateApiKey, formatExpiry, isExpiringSoon } from '../lib/auth.js'
import * as output from '../lib/output.js'
import type { OutputFormat } from '../lib/output.js'
import { CliError } from '../lib/errors.js'
import { handlePurchasePass } from '../lib/x402.js'

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
      const outputFormat = (opts.format as OutputFormat) ?? 'table'

      // Handle purchase-pass flow
      if (opts.purchasePass !== undefined) {
        const duration = typeof opts.purchasePass === 'string' ? opts.purchasePass : '1d'
        await handlePurchasePass(
          duration,
          opts.paymentSignature as string | undefined,
          outputFormat,
        )
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
      const keyInfo = await output.withSpinner(
        'Validating API key...',
        outputFormat,
        () => validateApiKey(apiKey, opts.apiUrl as string | undefined),
        'Validation failed',
      )

      // Store in config
      const config = readConfig()
      config.apiKey = apiKey
      config.keyType = keyInfo.type
      config.expiresAt = keyInfo.expiresAt
      config.scopes = keyInfo.scopes
      writeConfig(config)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          status: 'authenticated',
          keyType: keyInfo.type,
          scopes: keyInfo.scopes,
          expiresAt: keyInfo.expiresAt,
        }, outputFormat)
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
      const outputFormat = (opts.format as OutputFormat) ?? 'table'

      const config = readConfig()
      delete config.apiKey
      delete config.keyType
      delete config.expiresAt
      delete config.scopes
      writeConfig(config)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({ status: 'logged_out' }, outputFormat)
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
      const outputFormat = (opts.format as OutputFormat) ?? 'table'

      const resolved = resolveConfig({
        apiKey: opts.apiKey as string | undefined,
        apiUrl: opts.apiUrl as string | undefined,
      })

      if (!resolved.apiKey) {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ authenticated: false }, outputFormat)
        } else {
          output.info('Not authenticated. Run: aixbt login')
        }
        return
      }

      // Always validate against API
      const keyInfo = await output.withSpinner(
        'Checking authentication...',
        outputFormat,
        () => validateApiKey(resolved.apiKey!, resolved.apiUrl),
        'Authentication check failed',
      )

      // Check expiry warning
      const expiryWarning = isExpiringSoon(keyInfo.expiresAt)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          authenticated: true,
          key: output.maskApiKey(resolved.apiKey),
          keyType: keyInfo.type,
          scopes: keyInfo.scopes,
          expiresAt: keyInfo.expiresAt,
          expiringSoon: expiryWarning,
        }, outputFormat)
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
