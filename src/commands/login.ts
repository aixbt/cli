import type { Command } from 'commander'
import { password } from '@inquirer/prompts'
import { readConfig, writeConfig, resolveConfig, resolveFormat } from '../lib/config.js'
import { validateApiKey, formatExpiry, isExpiringSoon } from '../lib/auth.js'
import * as output from '../lib/output.js'
import { CliError } from '../lib/errors.js'
import { handlePurchasePass, fetchPassPricing } from '../lib/x402.js'

export function registerLoginCommand(program: Command): void {
  // -- login --
  program
    .command('login')
    .description('Authenticate with the AIXBT API')
    .option('--purchase-pass [duration]', 'Purchase a time-limited pass via x402 (USDC on Base)')
    .option('--payment-signature <base64>', 'Payment signature for x402 pass purchase')
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(opts.format as string | undefined)

      // Handle purchase-pass flow
      if (opts.purchasePass !== undefined) {
        const duration = typeof opts.purchasePass === 'string' ? opts.purchasePass : undefined

        // No duration specified — show available passes with live pricing
        if (!duration) {
          if (output.isStructuredFormat(outputFormat)) {
            const pricing = await fetchPassPricing()
            output.outputStructured(pricing, outputFormat)
            return
          }

          const pricing = await output.withSpinner(
            'Fetching pass pricing...',
            outputFormat,
            () => fetchPassPricing(),
            'Failed to fetch pricing',
            { silent: true },
          )

          console.log()
          console.log('  Available passes (USDC on Base, no account needed):')
          console.log()
          console.log(`  ${output.fmt.dim('Duration'.padEnd(12))}${output.fmt.dim('Price'.padEnd(10))}${output.fmt.dim('Command')}`)
          console.log(`  ${'─'.repeat(60)}`)
          for (const p of pricing) {
            console.log(`  ${p.label.padEnd(12)}${output.fmt.number(p.price.padEnd(10))}aixbt login --purchase-pass ${p.duration}`)
          }
          console.log()
          output.dim('  Requires a wallet with USDC on Base.')
          console.log(`  ${output.fmt.boldWhite('Guide')}`)
          console.log(`  ${output.fmt.dim('humans:')} ${output.fmt.link('https://docs.aixbt.tech/builders/agent-x402-guide')}`)
          console.log(`  ${output.fmt.dim('agents:')} ${output.fmt.dim('https://docs.aixbt.tech/builders/agent-x402-guide.mdx')}`)
          return
        }

        await handlePurchasePass(
          duration,
          opts.paymentSignature as string | undefined,
          outputFormat,
        )
        return
      }

      // Resolve API key: global --api-key flag, or prompt interactively
      let apiKey: string
      if (opts.apiKey) {
        apiKey = (opts.apiKey as string).trim()
      } else {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({
            status: 'awaiting_key',
            methods: [
              { method: 'api-key', command: 'aixbt login --api-key <key>' },
              { method: 'purchase-pass', command: 'aixbt login --purchase-pass' },
            ],
          }, outputFormat)
          return
        }

        console.log()
        console.log(`  ${output.fmt.brandBold('Subscribe')}    Get an API key at ${output.fmt.link('https://aixbt.tech/subscribe', 'aixbt.tech/subscribe')}`)
        console.log(`  ${output.fmt.brandBold('x402 Pass')}    Purchase a time-limited pass: ${output.fmt.dim('aixbt login --purchase-pass')}`)
        console.log(`               ${output.fmt.dim('No account needed. USDC on Base.')}`)
        console.log()

        apiKey = await password({ message: 'Paste API key:', mask: '·', theme: output.aixbtTheme })
        apiKey = apiKey.trim()
      }

      if (!apiKey) {
        throw new CliError('API key cannot be empty', 'INVALID_INPUT')
      }

      const keyInfo = await output.withSpinner(
        'Validating API key...',
        outputFormat,
        () => validateApiKey(apiKey, opts.apiUrl as string | undefined),
        'Validation failed',
        { silent: true },
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
        console.log(`${output.fmt.brand('✓')} API key validated`)
        console.log(`  Key type: ${keyInfo.type}`)
        console.log(`  Scopes: ${keyInfo.scopes.join(', ') || 'none'}`)
        console.log(`  Expires: ${formatExpiry(keyInfo.expiresAt)}`)
      }
    })

  // -- logout --
  program
    .command('logout')
    .description('Remove stored credentials')
    .action((_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(opts.format as string | undefined)

      const config = readConfig()
      delete config.apiKey
      delete config.keyType
      delete config.expiresAt
      delete config.scopes
      writeConfig(config)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({ status: 'logged_out' }, outputFormat)
      } else {
        const tick = output.fmt.brand('✓')
        console.log(`  ${tick} API key removed`)
        console.log(`  ${tick} Logged out`)
      }
    })

  // -- whoami --
  program
    .command('whoami')
    .description('Show current authentication status')
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(opts.format as string | undefined)

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
