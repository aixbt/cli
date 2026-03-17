import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { Provider, ProviderTier } from '../../../src/lib/providers/types.js'
import { CliError, ApiError, NetworkError, RateLimitError } from '../../../src/lib/errors.js'
import { resetAllTrackers } from '../../../src/lib/providers/rate-limit.js'

// -- Mock external dependencies --

vi.mock('../../../src/lib/providers/config.js', () => ({
  resolveProviderKey: vi.fn(() => null),
}))

vi.mock('../../../src/lib/api-client.js', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}))

import { resolveProviderKey } from '../../../src/lib/providers/config.js'
import { sleep } from '../../../src/lib/api-client.js'
import { providerRequest } from '../../../src/lib/providers/client.js'

// -- Mock fetch globally --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- Helpers --

function makeProvider(overrides?: Partial<Provider>): Provider {
  return {
    name: 'testprov',
    displayName: 'Test Provider',
    actions: {
      'get-data': {
        method: 'GET' as const,
        path: '/api/data',
        description: 'Get data',
        hint: 'test',
        params: [],
        minTier: 'free' as const,
      },
      'get-item': {
        method: 'GET' as const,
        path: '/api/items/{id}',
        description: 'Get item',
        hint: 'test',
        params: [
          { name: 'id', required: true, description: 'Item ID', inPath: true },
          { name: 'format', required: false, description: 'Format' },
        ],
        minTier: 'free' as const,
      },
      'pro-action': {
        method: 'GET' as const,
        path: '/api/pro',
        description: 'Pro only',
        hint: 'test',
        params: [],
        minTier: 'pro' as const,
      },
    },
    baseUrl: { byTier: {}, default: 'https://api.testprov.com' },
    rateLimits: { perMinute: { free: 30 } },
    normalize: (body: unknown) => body,
    ...overrides,
  }
}

function mockFetchResponse(body: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetchResponseWithHeaders(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): void {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  }))
}

describe('providerRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.mocked(resolveProviderKey).mockReset()
    vi.mocked(sleep).mockReset()
    vi.mocked(sleep).mockResolvedValue(undefined)
    vi.mocked(resolveProviderKey).mockReturnValue(null)
  })

  afterEach(() => {
    resetAllTrackers()
  })

  // -- Action validation --

  describe('action validation', () => {
    it('should throw UNKNOWN_ACTION for non-existent action', async () => {
      const provider = makeProvider()

      await expect(
        providerRequest({ provider, actionName: 'nonexistent', params: {} }),
      ).rejects.toThrow(CliError)

      await expect(
        providerRequest({ provider, actionName: 'nonexistent', params: {} }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_ACTION' })
    })

    it('should list available actions in the error message', async () => {
      const provider = makeProvider()

      await expect(
        providerRequest({ provider, actionName: 'missing', params: {} }),
      ).rejects.toThrow(/get-data/)
    })
  })

  // -- URL construction --

  describe('URL construction', () => {
    it('should build correct URL from baseUrl and action path', async () => {
      const provider = makeProvider()
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toBe('https://api.testprov.com/api/data')
    })

    it('should resolve path params from params object', async () => {
      const provider = makeProvider()
      mockFetchResponse({ result: 'ok' })

      await providerRequest({
        provider,
        actionName: 'get-item',
        params: { id: '42' },
      })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('/api/items/42')
    })

    it('should throw MISSING_PATH_PARAM for missing path params', async () => {
      const provider = makeProvider()

      await expect(
        providerRequest({ provider, actionName: 'get-item', params: {} }),
      ).rejects.toMatchObject({ code: 'MISSING_PATH_PARAM' })
    })

    it('should add non-path params as query params', async () => {
      const provider = makeProvider()
      mockFetchResponse({ result: 'ok' })

      await providerRequest({
        provider,
        actionName: 'get-item',
        params: { id: '42', format: 'json' },
      })

      const calledUrl = mockFetch.mock.calls[0][0]
      const url = new URL(calledUrl)
      expect(url.searchParams.get('format')).toBe('json')
    })

    it('should pass through extra params not in action definition as query params', async () => {
      const provider = makeProvider()
      mockFetchResponse({ result: 'ok' })

      await providerRequest({
        provider,
        actionName: 'get-data',
        params: { extra: 'value' },
      })

      const calledUrl = mockFetch.mock.calls[0][0]
      const url = new URL(calledUrl)
      expect(url.searchParams.get('extra')).toBe('value')
    })

    it('should use tier-specific base URL when configured', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'key123',
        tier: 'pro',
        source: 'config',
      })

      const provider = makeProvider({
        baseUrl: {
          byTier: { pro: 'https://pro-api.testprov.com' },
          default: 'https://api.testprov.com',
        },
        actions: {
          'get-data': {
            method: 'GET' as const,
            path: '/api/data',
            description: 'Get data',
            hint: 'test',
            params: [],
            minTier: 'free' as const,
          },
        },
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toBe('https://pro-api.testprov.com/api/data')
    })

    it('should interpolate {apiKey} in base URL', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'secret-key',
        tier: 'pro',
        source: 'config',
      })

      // DeFiLlama Pro-style pattern: API key is embedded in the origin
      const provider = makeProvider({
        baseUrl: {
          byTier: {},
          default: 'https://{apiKey}.testprov.com',
        },
        actions: {
          'get-data': {
            method: 'GET' as const,
            path: '/api/data',
            description: 'Get data',
            hint: 'test',
            params: [],
            minTier: 'free' as const,
          },
        },
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('secret-key')
      expect(calledUrl).not.toContain('{apiKey}')
    })

    it('should throw MISSING_PROVIDER_KEY when {apiKey} in base URL but no key resolved', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue(null)

      const provider = makeProvider({
        baseUrl: {
          byTier: {},
          default: 'https://{apiKey}.testprov.com',
        },
      })

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(CliError)

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toMatchObject({ code: 'MISSING_PROVIDER_KEY' })
    })
  })

  // -- pathByTier --

  describe('pathByTier', () => {
    it('should use pathByTier for effective tier when defined', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'key123',
        tier: 'pro',
        source: 'config',
      })

      const provider = makeProvider({
        actions: {
          'get-data': {
            method: 'GET' as const,
            path: '/api/free-data',
            description: 'Get data',
            hint: 'test',
            params: [],
            minTier: 'free' as const,
            pathByTier: { pro: '/api/pro-data' },
          },
        },
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('/api/pro-data')
    })

    it('should fall back to action.path when pathByTier does not have the tier', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'key123',
        tier: 'demo',
        source: 'config',
      })

      const provider = makeProvider({
        actions: {
          'get-data': {
            method: 'GET' as const,
            path: '/api/free-data',
            description: 'Get data',
            hint: 'test',
            params: [],
            minTier: 'free' as const,
            pathByTier: { pro: '/api/pro-data' },
          },
        },
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('/api/free-data')
    })
  })

  // -- Tier checking --

  describe('tier checking', () => {
    it('should allow action when tier meets requirement', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'key123',
        tier: 'pro',
        source: 'config',
      })

      const provider = makeProvider()
      mockFetchResponse({ result: 'ok' })

      const result = await providerRequest({
        provider,
        actionName: 'pro-action',
        params: {},
      })

      expect(result.data).toEqual({ result: 'ok' })
    })

    it('should throw TIER_INSUFFICIENT when tier is too low', async () => {
      // resolveProviderKey returns null -> tier is 'free'
      const provider = makeProvider()

      await expect(
        providerRequest({ provider, actionName: 'pro-action', params: {} }),
      ).rejects.toMatchObject({ code: 'TIER_INSUFFICIENT' })
    })
  })

  // -- Auth headers --

  describe('auth headers', () => {
    it('should not set auth header when no key resolved', async () => {
      const provider = makeProvider({ authHeader: 'x-api-key' })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledHeaders = mockFetch.mock.calls[0][1].headers
      expect(calledHeaders).not.toHaveProperty('x-api-key')
    })

    it('should set authHeader with raw key', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'my-api-key',
        tier: 'free',
        source: 'config',
      })

      const provider = makeProvider({ authHeader: 'x-api-key' })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledHeaders = mockFetch.mock.calls[0][1].headers
      expect(calledHeaders['x-api-key']).toBe('my-api-key')
    })

    it('should use buildAuthValue when provided', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'my-api-key',
        tier: 'free',
        source: 'config',
      })

      const provider = makeProvider({
        authHeader: 'Authorization',
        buildAuthValue: (key: string) => `Bearer ${key}`,
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledHeaders = mockFetch.mock.calls[0][1].headers
      expect(calledHeaders['Authorization']).toBe('Bearer my-api-key')
    })

    it('should use resolveAuth when provided, overriding authHeader', async () => {
      vi.mocked(resolveProviderKey).mockReturnValue({
        apiKey: 'my-api-key',
        tier: 'pro',
        source: 'config',
      })

      const resolveAuth = vi.fn((apiKey: string, tier: ProviderTier) => ({
        'x-custom-header': `${tier}:${apiKey}`,
      }))

      const provider = makeProvider({
        authHeader: 'x-api-key',
        resolveAuth,
      })
      mockFetchResponse({ result: 'ok' })

      await providerRequest({ provider, actionName: 'get-data', params: {} })

      const calledHeaders = mockFetch.mock.calls[0][1].headers
      expect(calledHeaders['x-custom-header']).toBe('pro:my-api-key')
      // authHeader should NOT be set when resolveAuth is used
      expect(calledHeaders).not.toHaveProperty('x-api-key')
    })
  })

  // -- Response handling --

  describe('response handling', () => {
    it('should return normalized data with correct status, provider, and action', async () => {
      const provider = makeProvider()
      mockFetchResponse({ items: [1, 2, 3] })

      const result = await providerRequest({
        provider,
        actionName: 'get-data',
        params: {},
      })

      expect(result).toEqual({
        data: { items: [1, 2, 3] },
        status: 200,
        provider: 'testprov',
        action: 'get-data',
      })
    })

    it('should call provider.normalize with body and action name', async () => {
      const normalize = vi.fn((body: unknown, actionName: string) => ({
        transformed: true,
        from: actionName,
      }))
      const provider = makeProvider({ normalize })
      mockFetchResponse({ raw: 'data' })

      const result = await providerRequest({
        provider,
        actionName: 'get-data',
        params: {},
      })

      expect(normalize).toHaveBeenCalledWith({ raw: 'data' }, 'get-data')
      expect(result.data).toEqual({ transformed: true, from: 'get-data' })
    })
  })

  // -- Error handling --

  describe('error handling', () => {
    it('should throw NetworkError on fetch failure', async () => {
      const provider = makeProvider()
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(NetworkError)

      await mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(/Connection refused/)
    })

    it('should throw ApiError on non-ok response with extracted error message', async () => {
      const provider = makeProvider()
      mockFetchResponse({ message: 'Resource not found' }, 404)

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(ApiError)

      mockFetchResponse({ message: 'Resource not found' }, 404)
      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(/Resource not found/)
    })

    it('should extract error from body.error field', async () => {
      const provider = makeProvider()
      mockFetchResponse({ error: 'access denied' }, 403)

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(/access denied/)
    })

    it('should extract error from body.status.error_message field', async () => {
      const provider = makeProvider()
      mockFetchResponse({ status: { error_message: 'quota exceeded' } }, 403)

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(/quota exceeded/)
    })

    it('should throw ApiError with INVALID_RESPONSE on non-JSON response', async () => {
      const provider = makeProvider()
      mockFetch.mockResolvedValueOnce(new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }))

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(ApiError)

      mockFetch.mockResolvedValueOnce(new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }))
      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('should throw RateLimitError after max retries on 429', async () => {
      const provider = makeProvider()

      // 4 x 429 responses (initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        mockFetchResponseWithHeaders({}, 429, { 'retry-after': '1' })
      }

      await expect(
        providerRequest({ provider, actionName: 'get-data', params: {} }),
      ).rejects.toThrow(RateLimitError)
    })

    it('should retry on 429 with sleep using retry-after header', async () => {
      const provider = makeProvider()

      // First call: 429 with retry-after: 2
      mockFetchResponseWithHeaders({}, 429, { 'retry-after': '2' })
      // Second call: success
      mockFetchResponse({ result: 'ok' })

      const result = await providerRequest({
        provider,
        actionName: 'get-data',
        params: {},
      })

      expect(result.data).toEqual({ result: 'ok' })
      expect(sleep).toHaveBeenCalledWith(2000)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should default to 60s wait when retry-after header is missing', async () => {
      const provider = makeProvider()

      // First call: 429 without retry-after
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }))
      // Second call: success
      mockFetchResponse({ result: 'ok' })

      await providerRequest({
        provider,
        actionName: 'get-data',
        params: {},
      })

      expect(sleep).toHaveBeenCalledWith(60_000)
    })
  })
})
