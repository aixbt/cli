import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { get, apiRequest } from '../../src/lib/api-client.js'
import { setConfigPath } from '../../src/lib/config.js'
import {
  ApiError,
  AuthError,
  NetworkError,
  PaymentRequiredError,
  RateLimitError,
} from '../../src/lib/errors.js'

import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- Helpers --

function rateLimitHeaders(overrides?: Record<string, string>): Record<string, string> {
  return {
    'x-ratelimit-limit-minute': '100',
    'x-ratelimit-remaining-minute': '95',
    'x-ratelimit-reset-minute': '2026-01-01T00:01:00Z',
    'x-ratelimit-limit-day': '10000',
    'x-ratelimit-remaining-day': '9900',
    'x-ratelimit-reset-day': '2026-01-02T00:00:00Z',
    ...overrides,
  }
}

describe('api-client', () => {
  let tempDir: string

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-api-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = 'test-key'
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-api-test-reset-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
  })

  // -- Successful response --

  describe('successful response', () => {
    it('should return status, data, and rateLimit from the response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { id: 1, name: 'test' } }, rateLimitHeaders()),
      )

      const result = await get<{ id: number; name: string }>('/v1/projects')

      expect(result.status).toBe(200)
      expect(result.data).toEqual({ id: 1, name: 'test' })
      expect(result.rateLimit).not.toBeNull()
      expect(result.rateLimit!.limitPerMinute).toBe(100)
    })

    it('should return null rateLimit when no rate limit headers are present', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const result = await get('/v1/signals')

      expect(result.rateLimit).toBeNull()
    })
  })

  // -- Rate limit header parsing --

  describe('rate limit header parsing', () => {
    it('should parse all rate limit headers correctly', async () => {
      const headers = rateLimitHeaders({
        'retry-after': '30',
      })

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }, headers),
      )

      const result = await get('/v1/test')

      expect(result.rateLimit).toEqual({
        limitPerMinute: 100,
        remainingPerMinute: 95,
        resetMinute: '2026-01-01T00:01:00Z',
        limitPerDay: 10000,
        remainingPerDay: 9900,
        resetDay: '2026-01-02T00:00:00Z',
        retryAfterSeconds: 30,
      })
    })

    it('should omit retryAfterSeconds when retry-after header is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }, rateLimitHeaders()),
      )

      const result = await get('/v1/test')

      expect(result.rateLimit!.retryAfterSeconds).toBeUndefined()
    })
  })

  // -- Auto-retry on 429 --

  describe('auto-retry on 429', () => {
    it('should retry on 429 and return success on second attempt', async () => {
      vi.useFakeTimers()

      const retryHeaders = rateLimitHeaders({ 'retry-after': '0' })

      mockFetch
        .mockResolvedValueOnce(jsonResponse(429, {}, retryHeaders))
        .mockResolvedValueOnce(
          jsonResponse(200, { status: 200, data: { ok: true } }, rateLimitHeaders()),
        )

      const promise = get('/v1/test')

      // Advance past the 0ms sleep
      await vi.advanceTimersByTimeAsync(0)

      const result = await promise

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(result.data).toEqual({ ok: true })

      vi.useRealTimers()
    })

    it('should throw RateLimitError after exceeding max retries', async () => {
      vi.useFakeTimers()

      const retryHeaders = rateLimitHeaders({ 'retry-after': '0' })

      // 4 total 429 responses: initial + 3 retries = exceeds MAX_RETRIES(3)
      mockFetch
        .mockResolvedValueOnce(jsonResponse(429, {}, retryHeaders))
        .mockResolvedValueOnce(jsonResponse(429, {}, retryHeaders))
        .mockResolvedValueOnce(jsonResponse(429, {}, retryHeaders))
        .mockResolvedValueOnce(jsonResponse(429, {}, retryHeaders))

      // Capture the rejection before advancing timers to avoid unhandled rejection
      let caughtError: unknown
      const promise = get('/v1/test').catch((err) => {
        caughtError = err
      })

      // Advance through each retry's sleep using runAllTimersAsync
      await vi.runAllTimersAsync()
      await promise

      expect(caughtError).toBeInstanceOf(RateLimitError)
      expect((caughtError as RateLimitError).message).toBe(
        'Rate limit exceeded after maximum retries',
      )

      vi.useRealTimers()
    })
  })

  // -- Auth error (401) --

  describe('auth error (401)', () => {
    it('should throw AuthError with server message and code', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(401, { message: 'Invalid API key', code: 'INVALID_API_KEY' }),
      )

      try {
        await get('/v1/test')
        expect.fail('Expected AuthError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError)
        expect((err as AuthError).message).toBe('Invalid API key')
        expect((err as AuthError).code).toBe('INVALID_API_KEY')
      }
    })

    it('should default message to Unauthorized when body has no message', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(401, {}))

      try {
        await get('/v1/test')
        expect.fail('Expected AuthError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError)
        expect((err as AuthError).message).toBe('Unauthorized')
      }
    })
  })

  // -- Payment required (402) --

  describe('payment required (402)', () => {
    it('should throw PaymentRequiredError with response body', async () => {
      const body = {
        paymentUrl: 'https://pay.example.com',
        amount: 50,
        currency: 'USD',
      }
      mockFetch.mockResolvedValueOnce(jsonResponse(402, body))

      try {
        await get('/v1/test')
        expect.fail('Expected PaymentRequiredError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(PaymentRequiredError)
        expect((err as PaymentRequiredError).body).toEqual(body)
      }
    })
  })

  // -- Other HTTP errors --

  describe('other HTTP errors', () => {
    it('should throw ApiError with status code for 500', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(500, { error: 'Server exploded' }),
      )

      try {
        await get('/v1/test')
        expect.fail('Expected ApiError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).statusCode).toBe(500)
        expect((err as ApiError).message).toBe('Server exploded')
      }
    })

    it('should use statusText when body has no error or message', async () => {
      // Simulate a response where json() throws (no body)
      const res = {
        status: 503,
        ok: false,
        statusText: 'Service Unavailable',
        headers: new Headers(),
        json: () => Promise.reject(new Error('no body')),
      } as unknown as Response

      mockFetch.mockResolvedValueOnce(res)

      try {
        await get('/v1/test')
        expect.fail('Expected ApiError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).statusCode).toBe(503)
        expect((err as ApiError).message).toBe('Service Unavailable')
      }
    })

    it('should use custom code from response body when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(400, { message: 'Bad input', code: 'VALIDATION_FAILED' }),
      )

      try {
        await get('/v1/test')
        expect.fail('Expected ApiError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).code).toBe('VALIDATION_FAILED')
      }
    })
  })

  // -- Network failure --

  describe('network failure', () => {
    it('should throw NetworkError when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      try {
        await get('/v1/test')
        expect.fail('Expected NetworkError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError)
        expect((err as NetworkError).message).toBe('ECONNREFUSED')
      }
    })

    it('should handle non-Error fetch rejections', async () => {
      mockFetch.mockRejectedValueOnce('connection lost')

      try {
        await get('/v1/test')
        expect.fail('Expected NetworkError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError)
        expect((err as NetworkError).message).toBe('Network request failed')
      }
    })
  })

  // -- API key injection --

  describe('API key injection', () => {
    it('should set X-API-Key header from environment variable', async () => {
      process.env.AIXBT_API_KEY = 'env-api-key'

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/test')

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('env-api-key')
    })

    it('should set X-API-Key from options.apiKey when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/test', undefined, { apiKey: 'explicit-key' })

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('explicit-key')
    })
  })

  // -- noAuth option --

  describe('noAuth option', () => {
    it('should not set X-API-Key header when noAuth is true', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/test', undefined, { noAuth: true })

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })
  })

  // -- paymentSignature option --

  describe('paymentSignature option', () => {
    it('should set PAYMENT-SIGNATURE header when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/test', undefined, { paymentSignature: 'sig-abc123' })

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['PAYMENT-SIGNATURE']).toBe('sig-abc123')
    })

    it('should not set PAYMENT-SIGNATURE header when not provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/test')

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['PAYMENT-SIGNATURE']).toBeUndefined()
    })
  })

  // -- PAYMENT-RESPONSE header extraction --

  describe('PAYMENT-RESPONSE header extraction', () => {
    it('should decode base64 JSON PAYMENT-RESPONSE header into paymentResponse', async () => {
      const settlement = { settled: true, txHash: '0xabc' }
      const encoded = Buffer.from(JSON.stringify(settlement)).toString('base64')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { id: '1' } }, {
          'PAYMENT-RESPONSE': encoded,
        }),
      )

      const result = await get<{ id: string }>('/v1/test')

      expect(result.paymentResponse).toEqual(settlement)
    })

    it('should return null paymentResponse when no PAYMENT-RESPONSE header is present', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { id: '1' } }),
      )

      const result = await get<{ id: string }>('/v1/test')

      expect(result.paymentResponse).toBeNull()
    })

    it('should return null paymentResponse when PAYMENT-RESPONSE header is malformed', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { id: '1' } }, {
          'PAYMENT-RESPONSE': '!!!not-valid-base64!!!',
        }),
      )

      const result = await get<{ id: string }>('/v1/test')

      expect(result.paymentResponse).toBeNull()
    })
  })

  // -- Query params --

  describe('query params', () => {
    it('should append query params to URL', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/projects', { page: 1, limit: 10, active: true })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('page')).toBe('1')
      expect(callUrl.searchParams.get('limit')).toBe('10')
      expect(callUrl.searchParams.get('active')).toBe('true')
    })

    it('should skip undefined query param values', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/projects', { page: 1, filter: undefined })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('page')).toBe('1')
      expect(callUrl.searchParams.has('filter')).toBe(false)
    })

    it('should skip empty string query param values', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/projects', { page: 1, sort: '' })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.has('sort')).toBe(false)
    })
  })

  // -- apiRequest method --

  describe('apiRequest method', () => {
    it('should send the correct HTTP method', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await apiRequest('POST', '/v1/projects')

      const callArgs = mockFetch.mock.calls[0]
      expect(callArgs[1].method).toBe('POST')
    })

    it('should set Content-Type and User-Agent headers', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await apiRequest('GET', '/v1/test')

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['User-Agent']).toBe('@aixbt/cli')
    })

    it('should use custom userAgent when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await apiRequest('GET', '/v1/test', { userAgent: 'custom-agent/1.0' })

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['User-Agent']).toBe('custom-agent/1.0')
    })
  })

  // -- URL construction --

  describe('URL construction', () => {
    it('should use the default API URL when none configured', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/projects')

      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toMatch(/^https:\/\/api\.aixbt\.tech\/v1\/projects/)
    })

    it('should use custom apiUrl when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: {} }),
      )

      await get('/v1/projects', undefined, { apiUrl: 'https://custom.api.com' })

      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toMatch(/^https:\/\/custom\.api\.com\/v1\/projects/)
    })
  })
})
