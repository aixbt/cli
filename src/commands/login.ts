import type { Command } from 'commander'
import { password } from '@inquirer/prompts'
import { readConfig, writeConfig, resolveConfig, resolveFormat, detectAllKeys } from '../lib/config.js'
import { validateApiKey, formatExpiry, isExpired, isExpiringSoon, formatTimeRemaining, parseX402Period } from '../lib/auth.js'
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
      config.keyName = keyInfo.name
      config.expiresAt = keyInfo.expiresAt
      config.scopes = keyInfo.scopes
      writeConfig(config)

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          status: 'authenticated',
          keyType: keyInfo.type,
          expiresAt: keyInfo.expiresAt,
        }, outputFormat)
      } else {
        console.log(`${output.fmt.brand('✓')} API key validated`)
        console.log(`  Key type: ${keyInfo.type ?? 'unknown'}`)
        console.log(`  Expires: ${formatExpiry(keyInfo.expiresAt)}`)

        // Warn if env key will shadow this stored key
        const envKey = process.env.AIXBT_API_KEY
        if (envKey && envKey !== apiKey) {
          console.log()
          output.warn('AIXBT_API_KEY is set in your environment and will take precedence.')
          console.log(`  Run ${output.fmt.dim('unset AIXBT_API_KEY')} to use this key.`)
        }
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
      delete config.keyName
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

      const allKeys = detectAllKeys(opts.apiKey as string | undefined)

      if (allKeys.length === 0) {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ authenticated: false }, outputFormat)
        } else {
          output.info('Not authenticated. Run: aixbt login')
        }
        return
      }

      const resolved = resolveConfig({
        apiKey: opts.apiKey as string | undefined,
        apiUrl: opts.apiUrl as string | undefined,
      })

      // Validate the active key
      const keyInfo = await output.withSpinner(
        'Checking authentication...',
        outputFormat,
        () => validateApiKey(resolved.apiKey!, resolved.apiUrl),
        'Authentication check failed',
      )

      // Update config metadata if the validated key is the config key
      const config = readConfig()
      if (resolved.apiKey === config.apiKey) {
        config.keyType = keyInfo.type
        config.keyName = keyInfo.name
        config.expiresAt = keyInfo.expiresAt
        config.scopes = keyInfo.scopes
        writeConfig(config)
      }

      // Determine active key index (first non-expired, or first)
      const activeIdx = allKeys.findIndex(k => !k.expiresAt || !isExpired(k.expiresAt))
      const effectiveActiveIdx = activeIdx >= 0 ? activeIdx : 0

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          authenticated: true,
          activeKey: {
            key: output.maskApiKey(resolved.apiKey!),
            source: resolved.keySource,
            keyType: keyInfo.type,
            name: keyInfo.name,
            expiresAt: keyInfo.expiresAt,
            period: parseX402Period(keyInfo.name),
            expiringSoon: isExpiringSoon(keyInfo.expiresAt, keyInfo.name),
          },
          allKeys: allKeys.map((k, i) => ({
            source: k.source,
            key: output.maskApiKey(k.key),
            active: i === effectiveActiveIdx,
            keyType: k.keyType,
            expiresAt: k.expiresAt,
          })),
        }, outputFormat)
      } else {
        for (let i = 0; i < allKeys.length; i++) {
          const k = allKeys[i]
          const isActive = i === effectiveActiveIdx
          // For the active key, use the validated info
          const type = isActive ? (keyInfo.type ?? '') : (k.keyType ?? '')
          const name = isActive ? keyInfo.name : k.keyName
          const expiresAt = isActive ? keyInfo.expiresAt : k.expiresAt
          const period = parseX402Period(name)

          const parts: string[] = [
            k.source.padEnd(8),
            output.maskApiKey(k.key).padEnd(16),
          ]
          if (type) parts.push(type + (period ? ` ${period}` : ''))
          if (expiresAt && isExpired(expiresAt)) {
            parts.push(output.fmt.red('expired'))
          } else if (expiresAt && expiresAt !== 'never') {
            const remaining = formatTimeRemaining(expiresAt)
            if (isExpiringSoon(expiresAt, name)) {
              parts.push(output.fmt.yellow(remaining))
            } else {
              parts.push(remaining)
            }
          } else if (expiresAt === 'never') {
            parts.push('never expires')
          }
          if (isActive && allKeys.length > 1) parts.push(output.fmt.brand('active'))

          const line = parts.join('  ')
          console.log(isActive ? line : output.fmt.dim(line))
        }

        // Expiry warning for active key
        if (keyInfo.expiresAt && isExpiringSoon(keyInfo.expiresAt, keyInfo.name)) {
          console.log()
          output.warn(`API key ${formatTimeRemaining(keyInfo.expiresAt)}`)
        }
      }
    })
}
