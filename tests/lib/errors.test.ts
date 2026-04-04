import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/x402.js', () => ({
  fetchPassPricing: vi.fn().mockResolvedValue([]),
}))

import {
  CliError,
  ApiError,
  AuthError,
  RateLimitError,
  NetworkError,
  PaymentRequiredError,
  NoApiKeyError,
  RecipeValidationError,
  handleTopLevelError,
} from '../../src/lib/errors.js'

import type { RateLimitInfo } from '../../src/types.js'

// -- Error class hierarchy --

describe('CliError', () => {
  it('should store code, message, and default exitCode of 1', () => {
    const err = new CliError('something broke', 'BROKEN')
    expect(err.message).toBe('something broke')
    expect(err.code).toBe('BROKEN')
    expect(err.exitCode).toBe(1)
  })

  it('should accept a custom exitCode', () => {
    const err = new CliError('bad', 'BAD', 2)
    expect(err.exitCode).toBe(2)
  })

  it('should be an instance of Error', () => {
    const err = new CliError('test', 'TEST')
    expect(err).toBeInstanceOf(Error)
  })

  it('should serialize to JSON with error and message', () => {
    const err = new CliError('oops', 'OOPS_CODE')
    expect(err.toJSON()).toEqual({
      error: 'OOPS_CODE',
      message: 'oops',
    })
  })
})

describe('ApiError', () => {
  it('should store statusCode and default code to HTTP_{statusCode}', () => {
    const err = new ApiError(500, 'Internal server error')
    expect(err.statusCode).toBe(500)
    expect(err.code).toBe('HTTP_500')
    expect(err.message).toBe('Internal server error')
  })

  it('should use custom code when provided', () => {
    const err = new ApiError(400, 'Bad request', 'VALIDATION_ERROR')
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.statusCode).toBe(400)
  })

  it('should be an instance of CliError', () => {
    const err = new ApiError(404, 'Not found')
    expect(err).toBeInstanceOf(CliError)
  })

  it('should include statusCode in toJSON output', () => {
    const err = new ApiError(503, 'Service unavailable')
    expect(err.toJSON()).toEqual({
      error: 'HTTP_503',
      message: 'Service unavailable',
      statusCode: 503,
    })
  })
})

describe('AuthError', () => {
  it('should default code to AUTH_ERROR', () => {
    const err = new AuthError('Unauthorized')
    expect(err.code).toBe('AUTH_ERROR')
    expect(err.message).toBe('Unauthorized')
  })

  it('should use custom code when provided', () => {
    const err = new AuthError('Key expired', 'API_KEY_EXPIRED')
    expect(err.code).toBe('API_KEY_EXPIRED')
  })

  it('should be an instance of CliError', () => {
    const err = new AuthError('test')
    expect(err).toBeInstanceOf(CliError)
  })
})

describe('RateLimitError', () => {
  const rateLimit: RateLimitInfo = {
    limitPerMinute: 100,
    remainingPerMinute: 0,
    resetMinute: '2026-01-01T00:01:00Z',
    limitPerDay: 10000,
    remainingPerDay: 9900,
    resetDay: '2026-01-02T00:00:00Z',
    retryAfterSeconds: 30,
  }

  it('should have code RATE_LIMIT_EXCEEDED', () => {
    const err = new RateLimitError('Rate limited', rateLimit)
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED')
  })

  it('should store rateLimit info', () => {
    const err = new RateLimitError('Rate limited', rateLimit)
    expect(err.rateLimit).toBe(rateLimit)
  })

  it('should handle null rateLimit', () => {
    const err = new RateLimitError('Rate limited', null)
    expect(err.rateLimit).toBeNull()
  })

  it('should include rateLimit in toJSON output', () => {
    const err = new RateLimitError('Rate limited', rateLimit)
    expect(err.toJSON()).toEqual({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limited',
      rateLimit,
    })
  })
})

describe('NetworkError', () => {
  it('should have code NETWORK_ERROR', () => {
    const err = new NetworkError('Connection refused')
    expect(err.code).toBe('NETWORK_ERROR')
    expect(err.message).toBe('Connection refused')
  })

  it('should be an instance of CliError', () => {
    const err = new NetworkError('timeout')
    expect(err).toBeInstanceOf(CliError)
  })
})

describe('PaymentRequiredError', () => {
  it('should have code PAYMENT_REQUIRED', () => {
    const err = new PaymentRequiredError({ amount: 100 })
    expect(err.code).toBe('PAYMENT_REQUIRED')
    expect(err.message).toBe('Payment required')
  })

  it('should spread body into toJSON output', () => {
    const body = { paymentUrl: 'https://pay.example.com', amount: 50 }
    const err = new PaymentRequiredError(body)
    expect(err.toJSON()).toEqual({
      error: 'payment_required',
      paymentUrl: 'https://pay.example.com',
      amount: 50,
    })
  })

  it('should handle null body', () => {
    const err = new PaymentRequiredError(null)
    expect(err.toJSON()).toEqual({
      error: 'payment_required',
    })
  })
})

describe('NoApiKeyError', () => {
  it('should have code NO_API_KEY', () => {
    const err = new NoApiKeyError()
    expect(err.code).toBe('NO_API_KEY')
    expect(err.message).toBe('No API key configured')
  })

  it('should include options array in toJSON', () => {
    const err = new NoApiKeyError()
    const json = err.toJSON()
    expect(json.error).toBe('no_api_key')
    expect(json.message).toBe('No API key configured')
    expect(json.options).toBeDefined()
    expect(Array.isArray(json.options)).toBe(true)
    expect((json.options as Array<{ mode: string }>).length).toBe(3)
  })

  it('should list all access modes in toJSON options', () => {
    const err = new NoApiKeyError()
    const options = err.toJSON().options as Array<{ mode: string }>
    const modes = options.map((o) => o.mode)
    expect(modes).toContain('api-key')
    expect(modes).toContain('purchase-pass')
    expect(modes).toContain('pay-per-use')
    expect(modes).not.toContain('delayed')
  })

  it('should return a multi-line human-readable string', () => {
    const err = new NoApiKeyError()
    const text = err.toHumanReadable()
    expect(text).toContain('No API key configured.')
    expect(text).toContain('Access options:')
    expect(text).toContain('aixbt login')
    expect(text).toContain('--purchase-pass')
    expect(text).toContain('--pay-per-use')
    expect(text).toContain('Grounding data is always free')
    expect(text).not.toContain('--delayed')
    // Verify it's multi-line
    expect(text.split('\n').length).toBeGreaterThan(5)
  })

  it('should include free grounding guidance in toJSON', () => {
    const err = new NoApiKeyError()
    const json = err.toJSON()
    expect(json.free).toBeDefined()
    const free = json.free as Record<string, unknown>
    expect(free.endpoint).toBe('grounding')
    expect(free.command).toBe('aixbt grounding')
  })
})

describe('RecipeValidationError', () => {
  const issues = [
    { path: 'steps[0].action', message: 'required field' },
    { path: 'name', message: 'must be a string' },
  ]

  it('should have code RECIPE_VALIDATION_ERROR', () => {
    const err = new RecipeValidationError('Invalid recipe', issues)
    expect(err.code).toBe('RECIPE_VALIDATION_ERROR')
    expect(err.message).toBe('Invalid recipe')
  })

  it('should store issues array', () => {
    const err = new RecipeValidationError('Invalid recipe', issues)
    expect(err.issues).toEqual(issues)
  })

  it('should include issues in toJSON output', () => {
    const err = new RecipeValidationError('Invalid recipe', issues)
    expect(err.toJSON()).toEqual({
      error: 'RECIPE_VALIDATION_ERROR',
      message: 'Invalid recipe',
      issues,
    })
  })
})

// -- handleTopLevelError --

describe('handleTopLevelError', () => {
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

  describe('CliError in JSON mode', () => {
    it('should output JSON to stdout and exit with error exitCode', async () => {
      const err = new CliError('something failed', 'FAIL_CODE')

      await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit called')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = JSON.parse(mockLog.mock.calls[0][0] as string)
      expect(output).toEqual({
        error: 'FAIL_CODE',
        message: 'something failed',
      })
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('CliError in TOON mode', () => {
    it('should output structured TOON to stdout and exit with error exitCode', async () => {
      const err = new CliError('something failed', 'FAIL_CODE')

      await expect(handleTopLevelError(err, 'toon')).rejects.toThrow('process.exit called')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = mockLog.mock.calls[0][0] as string
      expect(typeof output).toBe('string')
      // TOON output should not be JSON-formatted
      expect(output).not.toBe(JSON.stringify(err.toJSON(), null, 2))
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('CliError in human mode', () => {
    it('should output to stderr and exit with error exitCode', async () => {
      const err = new CliError('something failed', 'FAIL_CODE')

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith('error: something failed')
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('NoApiKeyError in JSON mode', () => {
    it('should output options JSON to stdout', async () => {
      const err = new NoApiKeyError()

      await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit called')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = JSON.parse(mockLog.mock.calls[0][0] as string)
      expect(output.error).toBe('no_api_key')
      expect(output.options).toBeDefined()
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('NoApiKeyError in human mode', () => {
    it('should output access options text to stdout and exit', async () => {
      const err = new NoApiKeyError()

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      // renderNoApiKeyError writes to console.log, not console.error
      expect(mockLog).toHaveBeenCalled()
      const allOutput = mockLog.mock.calls.map((c) => c[0] as string).join('\n')
      expect(allOutput).toContain('Not authenticated')
      expect(allOutput).toContain('Subscribe')
      expect(allOutput).toContain('x402')
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('AuthError in human mode', () => {
    it('should print expired-key hint when code is API_KEY_EXPIRED', async () => {
      const err = new AuthError('Key expired', 'API_KEY_EXPIRED')

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith('error: Key expired')
      expect(mockError).toHaveBeenCalledWith('\nYour API key has expired. Run: aixbt login')
    })

    it('should print invalid-key hint when code is INVALID_API_KEY', async () => {
      const err = new AuthError('Invalid key', 'INVALID_API_KEY')

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith('\nYour API key is invalid. Run: aixbt login')
    })
  })

  describe('RateLimitError in human mode', () => {
    it('should print retry-after seconds when available', async () => {
      const rateLimit: RateLimitInfo = {
        limitPerMinute: 100,
        remainingPerMinute: 0,
        resetMinute: '2026-01-01T00:01:00Z',
        limitPerDay: 10000,
        remainingPerDay: 9900,
        resetDay: '2026-01-02T00:00:00Z',
        retryAfterSeconds: 45,
      }
      const err = new RateLimitError('Rate limited', rateLimit)

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith('\nRetry after: 45s')
    })

    it('should print resetMinute when no retryAfterSeconds', async () => {
      const rateLimit: RateLimitInfo = {
        limitPerMinute: 100,
        remainingPerMinute: 0,
        resetMinute: '2026-01-01T00:01:00Z',
        limitPerDay: 10000,
        remainingPerDay: 9900,
        resetDay: '2026-01-02T00:00:00Z',
      }
      const err = new RateLimitError('Rate limited', rateLimit)

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith('\nRetry after: 2026-01-01T00:01:00Z')
    })
  })

  describe('NetworkError in human mode', () => {
    it('should print connection troubleshooting hint', async () => {
      const err = new NetworkError('ECONNREFUSED')

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith(
        '\nCheck your internet connection and try again.',
      )
    })
  })

  describe('unknown error', () => {
    it('should handle non-CliError errors in JSON mode', async () => {
      const err = new TypeError('Cannot read properties of undefined')

      await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit called')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = JSON.parse(mockLog.mock.calls[0][0] as string)
      expect(output).toEqual({
        error: 'INTERNAL_ERROR',
        message: 'Cannot read properties of undefined',
      })
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should handle non-CliError errors in human mode', async () => {
      const err = new TypeError('Cannot read properties of undefined')

      await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith(
        'error: Cannot read properties of undefined',
      )
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should handle non-Error values in JSON mode', async () => {
      await expect(handleTopLevelError('string error', 'json')).rejects.toThrow(
        'process.exit called',
      )

      const output = JSON.parse(mockLog.mock.calls[0][0] as string)
      expect(output).toEqual({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      })
    })

    it('should handle non-Error values in human mode', async () => {
      await expect(handleTopLevelError(42, 'human')).rejects.toThrow('process.exit called')

      expect(mockError).toHaveBeenCalledWith(
        'error: An unexpected error occurred',
      )
    })
  })
})
