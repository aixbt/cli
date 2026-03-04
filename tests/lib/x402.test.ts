import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  decodePaymentRequiredHeader,
  formatUsdcAmount,
  reconstructCommand,
  handlePaymentRequired,
  handlePurchasePass,
  withPayPerUse,
  X402_API_KEY_ENDPOINTS,
} from '../../src/lib/x402.js'

import type { X402PaymentRequired } from '../../src/lib/x402.js'
import type { AuthMode } from '../../src/lib/auth.js'
import { PaymentRequiredError } from '../../src/lib/errors.js'
import { setConfigPath, readConfig } from '../../src/lib/config.js'
import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally (needed for handlePurchasePass tests) --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- Mock ora (suppress spinners in tests) --

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}))

// -- Test data --

const MOCK_PAYMENT_REQUIRED: X402PaymentRequired = {
  x402Version: 2,
  resource: {
    url: 'https://api.aixbt.tech/v2/projects',
    description: 'Surging projects',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '500000',
      payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  ],
}

function encodePaymentRequired(payload: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// -- decodePaymentRequiredHeader --

describe('decodePaymentRequiredHeader', () => {
  it('should decode a valid base64-encoded x402 payment required JSON', () => {
    const encoded = encodePaymentRequired(MOCK_PAYMENT_REQUIRED)
    const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })

    const result = decodePaymentRequiredHeader(headers)

    expect(result).toEqual(MOCK_PAYMENT_REQUIRED)
  })

  it('should return null when no PAYMENT-REQUIRED header is present', () => {
    const headers = new Headers()

    const result = decodePaymentRequiredHeader(headers)

    expect(result).toBeNull()
  })

  it('should return null on invalid base64', () => {
    const headers = new Headers({ 'PAYMENT-REQUIRED': '!!!not-valid-base64!!!' })

    const result = decodePaymentRequiredHeader(headers)

    // Buffer.from with 'base64' is lenient, so it may decode to garbage
    // that fails JSON.parse -- either way, we expect null
    expect(result).toBeNull()
  })

  it('should return null on valid base64 that is not JSON', () => {
    const notJson = Buffer.from('this is not json').toString('base64')
    const headers = new Headers({ 'PAYMENT-REQUIRED': notJson })

    const result = decodePaymentRequiredHeader(headers)

    expect(result).toBeNull()
  })

  it('should work with lowercase payment-required header', () => {
    const encoded = encodePaymentRequired(MOCK_PAYMENT_REQUIRED)
    // Headers is case-insensitive per spec, so setting lowercase should work
    const headers = new Headers({ 'payment-required': encoded })

    const result = decodePaymentRequiredHeader(headers)

    expect(result).toEqual(MOCK_PAYMENT_REQUIRED)
  })

  it('should decode a payload with optional fields', () => {
    const payloadWithOptionals: X402PaymentRequired = {
      ...MOCK_PAYMENT_REQUIRED,
      error: 'Payment required for this resource',
      extensions: { custom: 'value' },
    }
    const encoded = encodePaymentRequired(payloadWithOptionals)
    const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })

    const result = decodePaymentRequiredHeader(headers)

    expect(result).toEqual(payloadWithOptionals)
    expect(result!.error).toBe('Payment required for this resource')
    expect(result!.extensions).toEqual({ custom: 'value' })
  })
})

// -- formatUsdcAmount --

describe('formatUsdcAmount', () => {
  it('should convert "500000" to "$0.50"', () => {
    expect(formatUsdcAmount('500000')).toBe('$0.50')
  })

  it('should convert "10000000" to "$10.00"', () => {
    expect(formatUsdcAmount('10000000')).toBe('$10.00')
  })

  it('should convert "1000000" to "$1.00"', () => {
    expect(formatUsdcAmount('1000000')).toBe('$1.00')
  })

  it('should convert "0" to "$0.00"', () => {
    expect(formatUsdcAmount('0')).toBe('$0.00')
  })

  it('should return the raw string for non-numeric input', () => {
    expect(formatUsdcAmount('not-a-number')).toBe('not-a-number')
  })

  it('should return the raw string for empty string', () => {
    expect(formatUsdcAmount('')).toBe('')
  })

  it('should handle small amounts like "1" correctly', () => {
    expect(formatUsdcAmount('1')).toBe('$0.00')
  })

  it('should handle large amounts', () => {
    // 100 USDC
    expect(formatUsdcAmount('100000000')).toBe('$100.00')
  })
})

// -- reconstructCommand --

describe('reconstructCommand', () => {
  it('should return just the command name when no options provided', () => {
    const result = reconstructCommand('projects', {})

    expect(result).toBe('projects')
  })

  it('should convert camelCase options to kebab-case flags', () => {
    const result = reconstructCommand('projects', { sortBy: 'name' })

    expect(result).toBe('projects --sort-by name')
  })

  it('should skip payPerUse option', () => {
    const result = reconstructCommand('projects', { payPerUse: true, limit: 10 })

    expect(result).toBe('projects --limit 10')
  })

  it('should skip apiKey option', () => {
    const result = reconstructCommand('projects', { apiKey: 'secret', limit: 5 })

    expect(result).toBe('projects --limit 5')
  })

  it('should skip apiUrl option', () => {
    const result = reconstructCommand('projects', { apiUrl: 'https://custom.api.com', limit: 5 })

    expect(result).toBe('projects --limit 5')
  })

  it('should preserve json flag as a bare flag', () => {
    const result = reconstructCommand('projects', { json: true })

    expect(result).toBe('projects --json')
  })

  it('should skip undefined values', () => {
    const result = reconstructCommand('projects', { page: undefined, limit: 10 })

    expect(result).toBe('projects --limit 10')
  })

  it('should skip null values', () => {
    const result = reconstructCommand('projects', { page: null, limit: 10 })

    expect(result).toBe('projects --limit 10')
  })

  it('should skip false values', () => {
    const result = reconstructCommand('projects', { verbose: false, limit: 10 })

    expect(result).toBe('projects --limit 10')
  })

  it('should include true as a bare flag without value', () => {
    const result = reconstructCommand('signals', { detailed: true })

    expect(result).toBe('signals --detailed')
  })

  it('should include string values as value flags', () => {
    const result = reconstructCommand('projects', { sort: 'desc' })

    expect(result).toBe('projects --sort desc')
  })

  it('should include numeric values as value flags', () => {
    const result = reconstructCommand('projects', { limit: 25 })

    expect(result).toBe('projects --limit 25')
  })

  it('should handle multiple options together', () => {
    const result = reconstructCommand('projects', {
      json: true,
      limit: 10,
      sort: 'name',
      payPerUse: true,
      apiKey: 'secret',
    })

    expect(result).toBe('projects --json --limit 10 --sort name')
  })
})

// -- handlePaymentRequired --

describe('handlePaymentRequired', () => {
  let mockExit: ReturnType<typeof vi.spyOn>
  let mockLog: ReturnType<typeof vi.spyOn>
  let mockError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('JSON mode with valid header', () => {
    it('should output structured X402PaymentDetails and exit with code 0', () => {
      const encoded = encodePaymentRequired(MOCK_PAYMENT_REQUIRED)
      const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects --json', true)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(0)

      // Find the JSON output call (output.json calls console.log with stringified JSON)
      const jsonCalls = mockLog.mock.calls.filter((call) => {
        try {
          JSON.parse(call[0] as string)
          return true
        } catch {
          return false
        }
      })
      expect(jsonCalls.length).toBeGreaterThanOrEqual(1)
      const outputData = JSON.parse(jsonCalls[0][0] as string)

      expect(outputData.status).toBe('payment_required')
      expect(outputData.x402Version).toBe(2)
      expect(outputData.resource.url).toBe('https://api.aixbt.tech/v2/projects')
      expect(outputData.resource.description).toBe('Surging projects')
      expect(outputData.payment.scheme).toBe('exact')
      expect(outputData.payment.network).toBe('eip155:8453')
      expect(outputData.payment.amount).toBe('$0.50')
      expect(outputData.payment.amountRaw).toBe('500000')
      expect(outputData.payment.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
      expect(outputData.payment.payTo).toBe(
        '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
      )
      expect(outputData.retryCommand).toContain('projects --json')
      expect(outputData.retryCommand).toContain('--payment-signature')
    })
  })

  describe('human mode with valid header', () => {
    it('should output payment details with retry command and exit with code 0', () => {
      const encoded = encodePaymentRequired(MOCK_PAYMENT_REQUIRED)
      const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects', false)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(0)

      // Collect all log output
      const allLogOutput = mockLog.mock.calls.map((c) => String(c[0])).join('\n')
      // The retry command should be printed
      expect(allLogOutput).toContain('--payment-signature')
      expect(allLogOutput).toContain('projects')
    })
  })

  describe('missing PAYMENT-REQUIRED header', () => {
    it('should exit with code 1 in JSON mode when header is missing', () => {
      const headers = new Headers()
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects --json', true)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(1)

      const jsonCalls = mockLog.mock.calls.filter((call) => {
        try {
          JSON.parse(call[0] as string)
          return true
        } catch {
          return false
        }
      })
      expect(jsonCalls.length).toBeGreaterThanOrEqual(1)
      const outputData = JSON.parse(jsonCalls[0][0] as string)
      expect(outputData.status).toBe('payment_required')
      expect(outputData.error).toContain('no PAYMENT-REQUIRED header')
    })

    it('should exit with code 1 in human mode when header is missing', () => {
      const headers = new Headers()
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects', false)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('null headers', () => {
    it('should exit with code 1 when err.headers is null', () => {
      const err = new PaymentRequiredError({ message: 'Payment required' }, null)

      expect(() => handlePaymentRequired(err, 'projects', false)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('empty accepts array', () => {
    it('should exit with code 1 when accepts is empty', () => {
      const payloadNoAccepts: X402PaymentRequired = {
        ...MOCK_PAYMENT_REQUIRED,
        accepts: [],
      }
      const encoded = encodePaymentRequired(payloadNoAccepts)
      const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects', false)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('accept without amount', () => {
    it('should show "unknown" for amount when accept has no amount field', () => {
      const payloadNoAmount: X402PaymentRequired = {
        ...MOCK_PAYMENT_REQUIRED,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
          },
        ],
      }
      const encoded = encodePaymentRequired(payloadNoAmount)
      const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })
      const err = new PaymentRequiredError({ message: 'Payment required' }, headers)

      expect(() => handlePaymentRequired(err, 'projects --json', true)).toThrow(
        'process.exit called',
      )

      expect(mockExit).toHaveBeenCalledWith(0)

      const jsonCalls = mockLog.mock.calls.filter((call) => {
        try {
          JSON.parse(call[0] as string)
          return true
        } catch {
          return false
        }
      })
      const outputData = JSON.parse(jsonCalls[0][0] as string)
      expect(outputData.payment.amount).toBe('unknown')
      expect(outputData.payment.amountRaw).toBe('unknown')
    })
  })
})

// -- withPayPerUse --

describe('withPayPerUse', () => {
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should pass through successful results unchanged', async () => {
    const authMode: AuthMode = { mode: 'pay-per-use' }
    const result = await withPayPerUse(
      () => Promise.resolve({ data: 'hello' }),
      authMode,
      'projects',
      false,
    )

    expect(result).toEqual({ data: 'hello' })
  })

  it('should catch PaymentRequiredError when authMode is pay-per-use', async () => {
    const authMode: AuthMode = { mode: 'pay-per-use' }
    const encoded = encodePaymentRequired(MOCK_PAYMENT_REQUIRED)
    const headers = new Headers({ 'PAYMENT-REQUIRED': encoded })
    const payErr = new PaymentRequiredError({ message: 'Payment required' }, headers)

    await expect(
      withPayPerUse(() => Promise.reject(payErr), authMode, 'projects', false),
    ).rejects.toThrow('process.exit called')

    // handlePaymentRequired was called (it calls process.exit(0))
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('should rethrow PaymentRequiredError when authMode is not pay-per-use', async () => {
    const authMode: AuthMode = { mode: 'delayed' }
    const payErr = new PaymentRequiredError({ message: 'Payment required' }, null)

    await expect(
      withPayPerUse(() => Promise.reject(payErr), authMode, 'projects', false),
    ).rejects.toThrow('Payment required')

    // process.exit should NOT have been called (the error is rethrown directly)
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('should rethrow other errors regardless of auth mode', async () => {
    const authMode: AuthMode = { mode: 'pay-per-use' }
    const genericErr = new Error('Something else went wrong')

    await expect(
      withPayPerUse(() => Promise.reject(genericErr), authMode, 'projects', false),
    ).rejects.toThrow('Something else went wrong')

    expect(mockExit).not.toHaveBeenCalled()
  })

  it('should rethrow other errors when authMode is not pay-per-use', async () => {
    const authMode: AuthMode = { mode: 'delayed' }
    const genericErr = new Error('Network failure')

    await expect(
      withPayPerUse(() => Promise.reject(genericErr), authMode, 'projects', false),
    ).rejects.toThrow('Network failure')

    expect(mockExit).not.toHaveBeenCalled()
  })
})

// -- handlePurchasePass --

describe('handlePurchasePass', () => {
  let mockExit: ReturnType<typeof vi.spyOn>
  let mockLog: ReturnType<typeof vi.spyOn>
  let mockError: ReturnType<typeof vi.spyOn>
  let tempDir: string

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-x402-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-x402-test-nonexistent', 'config.json'))
    vi.restoreAllMocks()
  })

  describe('step 1 (no payment-signature)', () => {
    it('should catch PaymentRequiredError and delegate to handlePaymentRequired', async () => {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://api.aixbt.tech/x402/v2/api-keys/1d', description: 'API key for 1 day', mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000000',
          payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
        }],
      }
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { message: 'Payment required' }, { 'PAYMENT-REQUIRED': encoded }),
      )

      await expect(
        handlePurchasePass('1d', undefined, false),
      ).rejects.toThrow('process.exit called')

      // handlePaymentRequired exits with 0 (payment required is an expected flow step)
      expect(mockExit).toHaveBeenCalledWith(0)

      // Verify the retry command was shown
      const allLogOutput = mockLog.mock.calls.map(c => String(c[0])).join('\n')
      expect(allLogOutput).toContain('--payment-signature')
    })

    it('should output JSON payment details in step 1 with isJson=true', async () => {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://api.aixbt.tech/x402/v2/api-keys/1w', description: 'API key for 1 week', mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '50000000',
          payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        }],
      }
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { message: 'Payment required' }, { 'PAYMENT-REQUIRED': encoded }),
      )

      await expect(
        handlePurchasePass('1w', undefined, true),
      ).rejects.toThrow('process.exit called')

      expect(mockExit).toHaveBeenCalledWith(0)

      const jsonCalls = mockLog.mock.calls.filter(call => {
        try { JSON.parse(call[0] as string); return true } catch { return false }
      })
      expect(jsonCalls.length).toBeGreaterThanOrEqual(1)
      const outputData = JSON.parse(jsonCalls[0][0] as string)

      expect(outputData.status).toBe('payment_required')
      expect(outputData.payment.amount).toBe('$50.00')
      expect(outputData.retryCommand).toContain('--purchase-pass 1w')
    })
  })

  describe('step 2 (with payment-signature)', () => {
    it('should store API key in config on successful payment', async () => {
      const passResponse = {
        apiKey: 'test-api-key-123',
        expiresAt: '2026-03-10T00:00:00.000Z',
        period: '1w',
        type: 'x402',
        scopes: ['mcp', 'projects'],
        rateLimit: { requestsPerMinute: 30, requestsPerDay: 10000 },
        warning: 'Save this API key now.',
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 201, data: passResponse }),
      )

      await handlePurchasePass('1w', 'base64-payment-proof', false)

      const config = readConfig()
      expect(config.apiKey).toBe('test-api-key-123')
      expect(config.keyType).toBe('x402')
      expect(config.expiresAt).toBe('2026-03-10T00:00:00.000Z')
      expect(config.scopes).toEqual(['mcp', 'projects'])
    })

    it('should output JSON with all fields in JSON mode', async () => {
      const passResponse = {
        apiKey: 'test-api-key-456',
        expiresAt: '2026-03-04T00:00:00.000Z',
        period: '1d',
        type: 'x402',
        scopes: ['mcp', 'projects'],
        rateLimit: { requestsPerMinute: 30, requestsPerDay: 10000 },
        warning: 'Save this API key now.',
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 201, data: passResponse }),
      )

      await handlePurchasePass('1d', 'base64-payment-proof', true)

      const jsonCalls = mockLog.mock.calls.filter(call => {
        try { JSON.parse(call[0] as string); return true } catch { return false }
      })
      expect(jsonCalls.length).toBeGreaterThanOrEqual(1)
      const outputData = JSON.parse(jsonCalls[0][0] as string)

      expect(outputData.status).toBe('authenticated')
      expect(outputData.apiKey).toBe('test-api-key-456')
      expect(outputData.type).toBe('x402')
      expect(outputData.scopes).toEqual(['mcp', 'projects'])
      expect(outputData.expiresAt).toBe('2026-03-04T00:00:00.000Z')
      expect(outputData.period).toBe('1d')
      expect(outputData.rateLimit).toEqual({ requestsPerMinute: 30, requestsPerDay: 10000 })
      expect(outputData.warning).toBe('Save this API key now.')
    })

    it('should send PAYMENT-SIGNATURE header in the request', async () => {
      const passResponse = {
        apiKey: 'key',
        expiresAt: '2026-03-04T00:00:00.000Z',
        period: '1d',
        type: 'x402',
        scopes: [],
        rateLimit: { requestsPerMinute: 30, requestsPerDay: 10000 },
        warning: 'Save this key.',
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 201, data: passResponse }),
      )

      await handlePurchasePass('1d', 'my-payment-sig', false)

      const [, init] = mockFetch.mock.calls[0]
      expect(init.headers['PAYMENT-SIGNATURE']).toBe('my-payment-sig')
    })
  })

  describe('validation', () => {
    it('should reject invalid duration', async () => {
      await expect(
        handlePurchasePass('invalid', undefined, false),
      ).rejects.toThrow('Invalid duration')
    })

    it('should rethrow non-PaymentRequiredError in step 1', async () => {
      // Simulate a network error (not a 402)
      mockFetch.mockRejectedValueOnce(new Error('Network failure'))

      await expect(
        handlePurchasePass('1d', undefined, false),
      ).rejects.toThrow('Network failure')

      // process.exit should NOT have been called with 0 (no payment flow)
      expect(mockExit).not.toHaveBeenCalledWith(0)
    })
  })
})

// -- Constants --

describe('X402_API_KEY_ENDPOINTS', () => {
  it('should have endpoints for all supported durations', () => {
    expect(X402_API_KEY_ENDPOINTS['10c']).toBe('/x402/v2/api-keys/10c')
    expect(X402_API_KEY_ENDPOINTS['1d']).toBe('/x402/v2/api-keys/1d')
    expect(X402_API_KEY_ENDPOINTS['1w']).toBe('/x402/v2/api-keys/1w')
    expect(X402_API_KEY_ENDPOINTS['4w']).toBe('/x402/v2/api-keys/4w')
  })

  it('should have exactly 4 endpoint entries', () => {
    expect(Object.keys(X402_API_KEY_ENDPOINTS)).toHaveLength(4)
  })
})
