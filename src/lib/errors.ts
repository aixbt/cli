import type { RateLimitInfo } from '../types.js'
import type { OutputFormat } from './output.js'
import * as output from './output.js'

// -- Error base class --

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: number = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
    }
  }
}

// -- Specific error types --

export class ApiError extends CliError {
  constructor(
    public readonly statusCode: number,
    message: string,
    code?: string,
  ) {
    super(message, code ?? `HTTP_${statusCode}`)
    this.name = 'ApiError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
    }
  }
}

export class AuthError extends CliError {
  constructor(message: string, code?: string) {
    super(message, code ?? 'AUTH_ERROR')
    this.name = 'AuthError'
  }
}

export class RateLimitError extends CliError {
  constructor(
    message: string,
    public readonly rateLimit: RateLimitInfo | null,
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED')
    this.name = 'RateLimitError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      rateLimit: this.rateLimit,
    }
  }
}

export class NetworkError extends CliError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR')
    this.name = 'NetworkError'
  }
}

export class PaymentRequiredError extends CliError {
  constructor(
    public readonly body: Record<string, unknown> | null,
    public readonly headers: Headers | null = null,
  ) {
    super('Payment required', 'PAYMENT_REQUIRED')
    this.name = 'PaymentRequiredError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: 'payment_required',
      ...this.body,
    }
  }
}

export class NoApiKeyError extends CliError {
  constructor() {
    super('No API key configured', 'NO_API_KEY')
    this.name = 'NoApiKeyError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: 'no_api_key',
      message: 'No API key configured',
      options: [
        {
          mode: 'api-key',
          action: 'aixbt login',
          description: 'Use your existing API key',
          cost: 'included in subscription',
          dataFreshness: 'real-time',
          obtainAt: 'https://aixbt.tech',
        },
        {
          mode: 'purchase-pass',
          action: 'aixbt login --purchase-pass',
          description: 'Purchase a time-limited pass via x402',
          cost: { '10calls': '$0.10', '1d': '$10', '1w': '$50', '4w': '$100' },
          dataFreshness: 'real-time',
          requires: ['wallet'],
        },
        {
          mode: 'pay-per-use',
          flag: '--pay-per-use',
          description: 'Pay per request via x402',
          cost: '$0.50/call',
          dataFreshness: 'real-time',
          requires: ['wallet'],
        },
        {
          mode: 'delayed',
          flag: '--delayed',
          description: 'Free tier with delayed data',
          cost: 'free',
          dataFreshness: '24h delay',
          requires: [],
        },
      ],
    }
  }

  toHumanReadable(): string {
    return [
      'No API key configured.',
      '',
      'Access options:',
      '  1. Use your existing key',
      '     Subscribe at https://aixbt.tech, generate a key, then run: aixbt login',
      '',
      '  2. Purchase a pass via x402',
      '     1 day ($10) / 1 week ($50) / 4 weeks ($100)',
      '     Run: aixbt login --purchase-pass',
      '',
      '  3. Pay per use via x402',
      '     $0.50/call, requires wallet',
      '     Run with: --pay-per-use',
      '',
      '  4. Use delayed data (free)',
      '     Data delayed 24h, no account needed',
      '     Run with: --delayed',
    ].join('\n')
  }
}

export class RecipeValidationError extends CliError {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message, 'RECIPE_VALIDATION_ERROR')
    this.name = 'RecipeValidationError'
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      issues: this.issues,
    }
  }
}

// -- Top-level error handler --

async function renderNoApiKeyError(outputFormat: OutputFormat): Promise<void> {
  console.log()
  console.log(`  ${output.fmt.boldWhite('Not authenticated')}`)
  console.log()
  console.log(`  ${output.fmt.brandBold('1. Subscribe')}`)
  console.log(`     Get an API key at ${output.fmt.link('https://aixbt.tech/subscribe', 'aixbt.tech/subscribe')}`)
  console.log(`     Then run: ${output.fmt.dim('aixbt login')}`)
  console.log()
  console.log(`  ${output.fmt.brandBold('2. x402 Pass')}`)
  console.log(`     ${output.fmt.dim('No account needed. USDC on Base.')}`)

  // Fetch live pricing (dynamic import to avoid circular dep)
  try {
    const { fetchPassPricing } = await import('./x402.js')
    const pricing = await output.withSpinner(
      '     Fetching pricing...',
      outputFormat,
      () => fetchPassPricing(),
      'Could not fetch pricing',
      { silent: true },
    )
    if (pricing.length > 0) {
      console.log()
      console.log(`     ${output.fmt.dim('Duration'.padEnd(12))}${output.fmt.dim('Price'.padEnd(10))}${output.fmt.dim('Command')}`)
      console.log(`     ${'─'.repeat(55)}`)
      for (const p of pricing) {
        console.log(`     ${p.label.padEnd(12)}${output.fmt.number(p.price.padEnd(10))}aixbt login --purchase-pass ${p.duration}`)
      }
    }
  } catch {
    console.log(`     Run: ${output.fmt.dim('aixbt login --purchase-pass')}`)
  }

  console.log()
  console.log(`  ${output.fmt.brandBold('3. Pay per use')}`)
  console.log(`     Append ${output.fmt.dim('--pay-per-use')} to any command`)
  console.log()
  console.log(`  ${output.fmt.brandBold('4. Delayed data')} ${output.fmt.dim('(free)')}`)
  console.log(`     Append ${output.fmt.dim('--delayed')} to any command (data delayed 24h)`)
  console.log()
  console.log(`  ${output.fmt.boldWhite('Docs')}`)
  console.log(`  ${output.fmt.dim('humans:')} ${output.fmt.link('https://docs.aixbt.tech/builders')}`)
  console.log(`  ${output.fmt.dim('agents:')} ${output.fmt.dim('https://docs.aixbt.tech/builders.mdx')}`)
  console.log()
}

export async function handleTopLevelError(err: unknown, outputFormat: OutputFormat): Promise<never> {
  if (err instanceof NoApiKeyError) {
    if (output.isStructuredFormat(outputFormat)) {
      output.outputStructured(err.toJSON(), outputFormat)
    } else {
      await renderNoApiKeyError(outputFormat)
    }
    process.exit(1)
  }

  if (err instanceof CliError) {
    if (output.isStructuredFormat(outputFormat)) {
      output.outputStructured(err.toJSON(), outputFormat)
    } else {
      console.error(`error: ${err.message}`)

      if (err instanceof AuthError) {
        if (err.code === 'API_KEY_EXPIRED') {
          console.error('\nYour API key has expired. Run: aixbt login')
        } else if (err.code === 'INVALID_API_KEY') {
          console.error('\nYour API key is invalid. Run: aixbt login')
        }
      }
      if (err instanceof RateLimitError && err.rateLimit) {
        const resetTime = err.rateLimit.retryAfterSeconds
          ? `${err.rateLimit.retryAfterSeconds}s`
          : err.rateLimit.resetMinute
        console.error(`\nRetry after: ${resetTime}`)
      }
      if (err instanceof NetworkError) {
        console.error('\nCheck your internet connection and try again.')
      }
      if (err instanceof PaymentRequiredError) {
        console.error('\nPayment required. Run: aixbt login --purchase-pass')
      }
      if (err instanceof RecipeValidationError) {
        for (const issue of err.issues) {
          console.error(`  ${issue.path}: ${issue.message}`)
        }
      }
    }
    process.exit(err.exitCode)
  }

  // Unknown error
  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured({
      error: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'An unexpected error occurred',
    }, outputFormat)
  } else {
    console.error(`error: ${err instanceof Error ? err.message : 'An unexpected error occurred'}`)
  }
  process.exit(1)
}
