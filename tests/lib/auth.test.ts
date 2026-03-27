import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveAuthMode, validateApiKey, buildClientOptions, type AuthMode } from '../../src/lib/auth.js'
import { setConfigPath, writeConfig, DEFAULT_API_URL } from '../../src/lib/config.js'
import { NoApiKeyError, AuthError } from '../../src/lib/errors.js'
import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('auth', () => {
  let tempDir: string

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-auth-test-'))
    setConfigPath(join(tempDir, 'config.json'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-auth-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
  })

  // -- resolveAuthMode --

  describe('resolveAuthMode', () => {
    it('should return delayed mode when delayed flag is true', () => {
      const result = resolveAuthMode({ delayed: true })
      expect(result).toEqual({ mode: 'delayed' })
    })

    it('should return pay-per-use mode when payPerUse flag is true', () => {
      const result = resolveAuthMode({ payPerUse: true })
      expect(result).toEqual({ mode: 'pay-per-use' })
    })

    it('should return api-key mode when apiKey is provided via flag', () => {
      const result = resolveAuthMode({ apiKey: 'flag-key-123' })
      expect(result.mode).toBe('api-key')
      if (result.mode === 'api-key') {
        expect(result.apiKey).toBe('flag-key-123')
        expect(result.config.apiKey).toBe('flag-key-123')
      }
    })

    it('should return api-key mode when apiKey is available from env var', () => {
      process.env.AIXBT_API_KEY = 'env-key-456'
      const result = resolveAuthMode({})
      expect(result.mode).toBe('api-key')
      if (result.mode === 'api-key') {
        expect(result.apiKey).toBe('env-key-456')
      }
    })

    it('should return api-key mode when apiKey is available from config file', () => {
      writeConfig({ apiKey: 'config-key-789' })
      const result = resolveAuthMode({})
      expect(result.mode).toBe('api-key')
      if (result.mode === 'api-key') {
        expect(result.apiKey).toBe('config-key-789')
      }
    })

    it('should throw NoApiKeyError when no key and no alternative flags', () => {
      expect(() => resolveAuthMode({})).toThrow(NoApiKeyError)
    })

    it('should prioritize delayed flag over a configured API key', () => {
      writeConfig({ apiKey: 'config-key' })
      process.env.AIXBT_API_KEY = 'env-key'
      const result = resolveAuthMode({ delayed: true, apiKey: 'flag-key' })
      expect(result).toEqual({ mode: 'delayed' })
    })

    it('should prioritize pay-per-use flag over a configured API key', () => {
      writeConfig({ apiKey: 'config-key' })
      process.env.AIXBT_API_KEY = 'env-key'
      const result = resolveAuthMode({ payPerUse: true, apiKey: 'flag-key' })
      expect(result).toEqual({ mode: 'pay-per-use' })
    })

    it('should include resolved config in api-key mode result', () => {
      const result = resolveAuthMode({ apiKey: 'test-key', apiUrl: 'https://custom.api.com' })
      expect(result.mode).toBe('api-key')
      if (result.mode === 'api-key') {
        expect(result.config.apiUrl).toBe('https://custom.api.com')
      }
    })

    it('should return pay-per-use mode when paymentSignature is present', () => {
      const result = resolveAuthMode({ paymentSignature: 'sig-abc-123' })
      expect(result).toEqual({ mode: 'pay-per-use' })
    })

    it('should prioritize paymentSignature over a configured API key', () => {
      writeConfig({ apiKey: 'config-key' })
      const result = resolveAuthMode({ paymentSignature: 'sig-abc-123' })
      expect(result).toEqual({ mode: 'pay-per-use' })
    })
  })

  // -- validateApiKey --

  describe('validateApiKey', () => {
    it('should call GET /v2/api-keys/info with the provided key', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: { id: 'key-123', type: 'full', scopes: ['read'], expiresAt: 'never' },
        }),
      )

      await validateApiKey('my-api-key')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toContain('/v2/api-keys/info')
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('my-api-key')
    })

    it('should return the data from the API response', async () => {
      const keyInfo = { id: 'key-456', type: 'full', scopes: ['read', 'write'], expiresAt: 'never' }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: keyInfo }),
      )

      const result = await validateApiKey('my-api-key')

      expect(result).toEqual(keyInfo)
    })

    it('should throw AuthError on 401 response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(401, { message: 'Invalid API key', code: 'INVALID_API_KEY' }),
      )

      await expect(validateApiKey('bad-key')).rejects.toThrow(AuthError)
    })

    it('should pass custom apiUrl when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: { id: 'key-789', type: 'demo', scopes: [], expiresAt: 'never' },
        }),
      )

      await validateApiKey('my-key', 'https://custom.api.com')

      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toMatch(/^https:\/\/custom\.api\.com\//)
    })
  })

  // -- buildClientOptions --

  describe('buildClientOptions', () => {
    it('should return apiKey and apiUrl for api-key mode', () => {
      const authMode: AuthMode = {
        mode: 'api-key',
        apiKey: 'test-key',
        config: {
          apiKey: 'test-key',
          apiUrl: 'https://custom.api.com',
          keyType: undefined,
          expiresAt: undefined,
          scopes: [],
        },
      }

      const result = buildClientOptions(authMode, {})

      expect(result).toEqual({
        apiKey: 'test-key',
        apiUrl: 'https://custom.api.com',
      })
    })

    it('should return noAuth true for delayed mode', () => {
      const authMode: AuthMode = { mode: 'delayed' }

      const result = buildClientOptions(authMode, {})

      expect(result).toEqual({
        noAuth: true,
        apiUrl: undefined,
      })
    })

    it('should return noAuth true for pay-per-use mode', () => {
      const authMode: AuthMode = { mode: 'pay-per-use' }

      const result = buildClientOptions(authMode, {})

      expect(result).toEqual({
        noAuth: true,
        apiUrl: undefined,
        pathPrefix: '/x402',
      })
    })

    it('should pass apiUrl from global opts for delayed mode', () => {
      const authMode: AuthMode = { mode: 'delayed' }

      const result = buildClientOptions(authMode, { apiUrl: 'https://override.api.com' })

      expect(result.apiUrl).toBe('https://override.api.com')
      expect(result.noAuth).toBe(true)
    })

    it('should pass apiUrl from global opts for pay-per-use mode', () => {
      const authMode: AuthMode = { mode: 'pay-per-use' }

      const result = buildClientOptions(authMode, { apiUrl: 'https://override.api.com' })

      expect(result.apiUrl).toBe('https://override.api.com')
      expect(result.noAuth).toBe(true)
      expect(result.pathPrefix).toBe('/x402')
    })

    it('should use apiUrl from config for api-key mode, ignoring globalOpts', () => {
      const authMode: AuthMode = {
        mode: 'api-key',
        apiKey: 'test-key',
        config: {
          apiKey: 'test-key',
          apiUrl: DEFAULT_API_URL,
          keyType: undefined,
          expiresAt: undefined,
          scopes: [],
        },
      }

      const result = buildClientOptions(authMode, { apiUrl: 'https://should-be-ignored.com' })

      expect(result.apiUrl).toBe(DEFAULT_API_URL)
    })

    it('should include paymentSignature when provided in globalOpts', () => {
      const authMode: AuthMode = {
        mode: 'api-key',
        apiKey: 'test-key',
        config: {
          apiKey: 'test-key',
          apiUrl: DEFAULT_API_URL,
          keyType: undefined,
          expiresAt: undefined,
          scopes: [],
        },
      }

      const result = buildClientOptions(authMode, { paymentSignature: 'sig-xyz-789' })

      expect(result.paymentSignature).toBe('sig-xyz-789')
      expect(result.apiKey).toBe('test-key')
      expect(result.apiUrl).toBe(DEFAULT_API_URL)
      expect(result.noAuth).toBe(true)
      expect(result.pathPrefix).toBe('/x402')
    })

    it('should not include paymentSignature when not provided in globalOpts', () => {
      const authMode: AuthMode = {
        mode: 'api-key',
        apiKey: 'test-key',
        config: {
          apiKey: 'test-key',
          apiUrl: DEFAULT_API_URL,
          keyType: undefined,
          expiresAt: undefined,
          scopes: [],
        },
      }

      const result = buildClientOptions(authMode, {})

      expect(result.paymentSignature).toBeUndefined()
    })

    it('should return pathPrefix /x402 for pay-per-use mode', () => {
      const authMode: AuthMode = { mode: 'pay-per-use' }
      const result = buildClientOptions(authMode, {})
      expect(result.pathPrefix).toBe('/x402')
      expect(result.noAuth).toBe(true)
    })

    it('should return pathPrefix /x402 and noAuth when paymentSignature is present', () => {
      const authMode: AuthMode = { mode: 'pay-per-use' }
      const result = buildClientOptions(authMode, { paymentSignature: 'sig-xyz' })
      expect(result.pathPrefix).toBe('/x402')
      expect(result.noAuth).toBe(true)
      expect(result.paymentSignature).toBe('sig-xyz')
    })

    it('should not set pathPrefix for delayed mode', () => {
      const authMode: AuthMode = { mode: 'delayed' }
      const result = buildClientOptions(authMode, {})
      expect(result.pathPrefix).toBeUndefined()
      expect(result.noAuth).toBe(true)
    })

    it('should not set pathPrefix for api-key mode without paymentSignature', () => {
      const authMode: AuthMode = {
        mode: 'api-key',
        apiKey: 'test-key',
        config: {
          apiKey: 'test-key',
          apiUrl: 'https://api.aixbt.tech',
          keyType: undefined,
          expiresAt: undefined,
          scopes: [],
        },
      }
      const result = buildClientOptions(authMode, {})
      expect(result.pathPrefix).toBeUndefined()
    })
  })
})
