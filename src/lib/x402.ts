import type { AuthMode } from './auth.js'
import { readConfig, writeConfig } from './config.js'
import { CliError, PaymentRequiredError } from './errors.js'
import * as output from './output.js'
import { apiRequest } from './api-client.js'

// -- Types --

/**
 * Decoded PAYMENT-REQUIRED header content.
 * Matches the x402 v2 PaymentRequired schema from @x402/core.
 */
export interface X402PaymentRequired {
  x402Version: number
  error?: string
  resource: {
    url: string
    description: string
    mimeType: string
  }
  accepts: Array<{
    scheme: string
    network: string
    asset?: string
    amount?: string
    payTo: string
    maxTimeoutSeconds?: number
    extra?: Record<string, unknown>
  }>
  extensions?: Record<string, unknown>
}

export interface X402PaymentDetails {
  status: 'payment_required'
  x402Version: number
  resource: { url: string; description: string }
  payment: {
    scheme: string
    network: string
    amount: string
    amountRaw: string
    asset?: string
    payTo: string
  }
  retryCommand: string
}

interface PurchasePassResult {
  apiKey: string
  expiresAt: string
  period: string
  type: string
  scopes: string[]
  rateLimit: { requestsPerMinute: number; requestsPerDay: number }
  warning: string
}

// -- Constants --

/** API key purchase endpoints (duration -> path) */
export const X402_API_KEY_ENDPOINTS: Record<string, string> = {
  '10c': '/x402/v2/api-keys/10c',
  '1d': '/x402/v2/api-keys/1d',
  '1w': '/x402/v2/api-keys/1w',
  '4w': '/x402/v2/api-keys/4w',
}

const VALID_DURATIONS = Object.keys(X402_API_KEY_ENDPOINTS)

// -- Header decoding --

/**
 * Decode the PAYMENT-REQUIRED header from a 402 response.
 * The header is base64-encoded JSON.
 */
export function decodePaymentRequiredHeader(headers: Headers): X402PaymentRequired | null {
  const raw = headers.get('payment-required')
  if (!raw) return null

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    return JSON.parse(decoded) as X402PaymentRequired
  } catch {
    return null
  }
}

// -- Amount formatting --

/**
 * Convert a raw USDC amount string (6 decimals) to a human-readable dollar string.
 * e.g. "500000" -> "$0.50"
 */
export function formatUsdcAmount(rawAmount: string): string {
  const value = parseInt(rawAmount, 10)
  if (isNaN(value)) return rawAmount
  const dollars = value / 1_000_000
  return `$${dollars.toFixed(2)}`
}

// -- Command reconstruction --

/**
 * Build a retry command string from the command name and options.
 * Converts camelCase option keys to kebab-case flags.
 * Removes --pay-per-use (replaced by --payment-signature in retry).
 * Removes undefined/false/null values.
 */
export function reconstructCommand(commandName: string, opts: Record<string, unknown>): string {
  const parts = [commandName]

  for (const [key, value] of Object.entries(opts)) {
    // Skip options that shouldn't appear in the retry command
    if (key === 'payPerUse' || key === 'apiKey' || key === 'apiUrl') continue
    if (value === undefined || value === null || value === false) continue

    const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase()

    if (value === true) {
      parts.push(`--${kebab}`)
    } else {
      parts.push(`--${kebab} ${String(value)}`)
    }
  }

  return parts.join(' ')
}

// -- Purchase pass flow --

/**
 * Handle the login --purchase-pass flow.
 *
 * Step 1 (no paymentSignature): POST to trigger 402, extract payment details, output retry command.
 * Step 2 (with paymentSignature): POST with payment proof, receive API key, store in config.
 */
export async function handlePurchasePass(
  duration: string,
  paymentSignature: string | undefined,
  isJson: boolean,
): Promise<void> {
  // Validate duration
  if (!VALID_DURATIONS.includes(duration)) {
    throw new CliError(
      `Invalid duration: ${duration}. Valid: ${VALID_DURATIONS.join(', ')}`,
      'INVALID_DURATION',
    )
  }

  const endpoint = X402_API_KEY_ENDPOINTS[duration]

  if (!paymentSignature) {
    // Step 1: POST to trigger 402, get payment details
    const spin = !isJson ? output.spinner(`Requesting pass pricing for ${duration}...`) : null

    try {
      await apiRequest('POST', endpoint, { noAuth: true })
      // Unexpected success without payment
      spin?.succeed('Pass generated without payment (unexpected)')
    } catch (err) {
      spin?.stop()
      if (err instanceof PaymentRequiredError) {
        handlePaymentRequired(
          err,
          `aixbt login --purchase-pass ${duration}`,
          isJson,
        )
      }
      throw err
    }
  } else {
    // Step 2: POST with payment proof
    const result = await output.withSpinner(
      'Completing pass purchase...',
      isJson,
      () => apiRequest<PurchasePassResult>('POST', endpoint, {
        noAuth: true,
        paymentSignature,
      }),
      'Pass purchase failed',
    )

    const passData = result.data

    // Store the new API key in config
    const config = readConfig()
    writeConfig({
      ...config,
      apiKey: passData.apiKey,
      keyType: passData.type,
      expiresAt: passData.expiresAt,
      scopes: passData.scopes,
    })

    if (isJson) {
      output.json({
        status: 'authenticated',
        apiKey: passData.apiKey,
        type: passData.type,
        scopes: passData.scopes,
        expiresAt: passData.expiresAt,
        period: passData.period,
        rateLimit: passData.rateLimit,
        warning: passData.warning,
      })
    } else {
      output.success('Pass purchased and key stored')
      output.warn(passData.warning)
      output.keyValue('API Key', passData.apiKey)
      output.keyValue('Type', passData.type)
      output.keyValue('Expires', passData.expiresAt)
      output.keyValue('Period', passData.period)
      output.keyValue('Rate Limit', `${passData.rateLimit.requestsPerMinute}/min, ${passData.rateLimit.requestsPerDay}/day`)
      output.keyValue('Scopes', passData.scopes.join(', '))
    }
  }
}

// -- Main handler --

/**
 * Handle a payment-required (402) response in pay-per-use mode.
 * Decodes the PAYMENT-REQUIRED header, formats the payment details, and outputs them.
 * Exits with code 0 (payment required is an expected flow step, not an error).
 */
export function handlePaymentRequired(
  err: PaymentRequiredError,
  commandStr: string,
  isJson: boolean,
): never {
  const paymentInfo = err.headers ? decodePaymentRequiredHeader(err.headers) : null

  if (!paymentInfo) {
    if (isJson) {
      output.json({
        status: 'payment_required',
        error: 'Payment required but no PAYMENT-REQUIRED header found',
        body: err.body,
      })
    } else {
      output.error('Payment required but could not extract payment details')
      output.dim('The server may be using an unsupported x402 protocol version')
    }
    process.exit(1)
  }

  const primaryAccept = paymentInfo.accepts[0]

  if (!primaryAccept) {
    if (isJson) {
      output.json({
        status: 'payment_required',
        error: 'No payment options available from the server',
      })
    } else {
      output.error('Payment required but no payment options available')
    }
    process.exit(1)
  }

  const retryCommand = `${commandStr} --payment-signature <BASE64_PAYMENT_PROOF>`

  const details: X402PaymentDetails = {
    status: 'payment_required',
    x402Version: paymentInfo.x402Version,
    resource: {
      url: paymentInfo.resource.url,
      description: paymentInfo.resource.description,
    },
    payment: {
      scheme: primaryAccept.scheme,
      network: primaryAccept.network,
      amount: primaryAccept.amount ? formatUsdcAmount(primaryAccept.amount) : 'unknown',
      amountRaw: primaryAccept.amount ?? 'unknown',
      asset: primaryAccept.asset,
      payTo: primaryAccept.payTo,
    },
    retryCommand,
  }

  if (isJson) {
    output.json(details)
  } else {
    console.log()
    output.info('Payment required')
    output.keyValue('Amount', details.payment.amount)
    output.keyValue('Network', details.payment.network)
    output.keyValue('Pay to', details.payment.payTo)
    if (details.payment.asset) {
      output.keyValue('Asset', details.payment.asset)
    }
    output.keyValue('Description', details.resource.description)
    console.log()
    output.dim('After completing payment, retry with:')
    console.log(`  ${retryCommand}`)
  }

  process.exit(0)
}

// -- Wrapper for command handlers --

/**
 * Wrap an API call to handle pay-per-use 402 responses.
 * If the auth mode is pay-per-use and a 402 is received, output payment details and exit.
 * Otherwise, rethrow the error.
 */
export async function withPayPerUse<T>(
  fn: () => Promise<T>,
  authMode: AuthMode,
  commandStr: string,
  isJson: boolean,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof PaymentRequiredError && authMode.mode === 'pay-per-use') {
      handlePaymentRequired(err, commandStr, isJson)
    }
    throw err
  }
}

