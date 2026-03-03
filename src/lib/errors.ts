import type { RateLimitInfo } from '../types.js'

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
          dataFreshness: '12-24h delay',
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
      '     Data delayed 12-24h, no account needed',
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

export function handleTopLevelError(err: unknown, isJson: boolean): never {
  if (err instanceof NoApiKeyError) {
    if (isJson) {
      console.log(JSON.stringify(err.toJSON(), null, 2))
    } else {
      console.error(err.toHumanReadable())
    }
    process.exit(1)
  }

  if (err instanceof CliError) {
    if (isJson) {
      console.log(JSON.stringify(err.toJSON(), null, 2))
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
  if (isJson) {
    console.log(JSON.stringify({
      error: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'An unexpected error occurred',
    }, null, 2))
  } else {
    console.error(`error: ${err instanceof Error ? err.message : 'An unexpected error occurred'}`)
  }
  process.exit(1)
}
