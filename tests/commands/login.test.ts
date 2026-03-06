import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath, readConfig, writeConfig } from '../../src/lib/config.js'
import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally --

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

// -- Mock @inquirer/prompts (not testing interactive flow) --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

const VALID_KEY_INFO = {
  id: 'key-123',
  type: 'full',
  scopes: ['read', 'write'],
  expiresAt: 'never',
}

function mockValidKeyResponse(): void {
  mockFetch.mockResolvedValueOnce(
    jsonResponse(200, { status: 200, data: VALID_KEY_INFO }),
  )
}

describe('login commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-login-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    logs = []
    errors = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-login-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // -- login --

  describe('login', () => {
    it('should validate key and store in config with --api-key flag', async () => {
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'login', '--api-key', 'test-key-123'], { from: 'node' })

      const config = readConfig()
      expect(config.apiKey).toBe('test-key-123')
    })

    it('should store keyType, scopes, and expiresAt from API response', async () => {
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'login', '--api-key', 'test-key-123'], { from: 'node' })

      const config = readConfig()
      expect(config.keyType).toBe('full')
      expect(config.scopes).toEqual(['read', 'write'])
      expect(config.expiresAt).toBe('never')
    })

    it('should output JSON result with --json flag', async () => {
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'login', '--api-key', 'test-key-123'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('authenticated')
      expect(parsed.keyType).toBe('full')
      expect(parsed.scopes).toEqual(['read', 'write'])
      expect(parsed.expiresAt).toBe('never')
    })

    it('should throw on invalid key (401 from API)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(401, { message: 'Invalid API key', code: 'INVALID_API_KEY' }),
      )

      const program = createProgram()
      program.exitOverride()
      await expect(
        program.parseAsync(['node', 'aixbt', 'login', '--api-key', 'bad-key'], { from: 'node' }),
      ).rejects.toThrow()
    })

    it('should request payment details for --purchase-pass (step 1)', async () => {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://api.aixbt.tech/x402/v2/api-keys/1d', description: 'API key for 1 day', mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000000',
          payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        }],
      }
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { message: 'Payment required' }, { 'PAYMENT-REQUIRED': encoded }),
      )

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

      const program = createProgram()
      program.exitOverride()
      try {
        await program.parseAsync(['node', 'aixbt', 'login', '--purchase-pass', '1d'], { from: 'node' })
      } catch { /* process.exit throws */ }

      // Verify the payment details were output (human-readable mode)
      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Payment required')
      expect(allOutput).toContain('--payment-signature')

      // Verify POST was made to the correct endpoint
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toContain('/x402/v2/api-keys/1d')
      expect(init.method).toBe('POST')

      exitSpy.mockRestore()
    })

    it('should output JSON payment details for --purchase-pass with --json (step 1)', async () => {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: 'https://api.aixbt.tech/x402/v2/api-keys/1d', description: 'API key for 1 day', mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000000',
          payTo: '0x8e4b195c14f20e1ba4c40234f471e1781f293b45',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        }],
      }
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { message: 'Payment required' }, { 'PAYMENT-REQUIRED': encoded }),
      )

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

      const program = createProgram()
      program.exitOverride()
      try {
        await program.parseAsync(['node', 'aixbt', '--format', 'json', 'login', '--purchase-pass', '1d'], { from: 'node' })
      } catch { /* process.exit throws */ }

      // Verify JSON output contains payment details
      const jsonOutput = logs.find(l => l.includes('"payment_required"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('payment_required')
      expect(parsed.x402Version).toBe(2)
      expect(parsed.payment.amount).toBe('$10.00')
      expect(parsed.payment.network).toBe('eip155:8453')
      expect(parsed.retryCommand).toContain('--payment-signature')

      exitSpy.mockRestore()
    })

    it('should store API key from --purchase-pass with --payment-signature (step 2)', async () => {
      const passResponse = {
        apiKey: 'generated-key-hex',
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

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync([
        'node', 'aixbt', 'login',
        '--purchase-pass', '1d',
        '--payment-signature', 'base64-payment-proof',
      ], { from: 'node' })

      // Verify config was updated
      const config = readConfig()
      expect(config.apiKey).toBe('generated-key-hex')
      expect(config.keyType).toBe('x402')
      expect(config.expiresAt).toBe('2026-03-04T00:00:00.000Z')
      expect(config.scopes).toEqual(['mcp', 'projects'])

      // Verify POST was made with PAYMENT-SIGNATURE header
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toContain('/x402/v2/api-keys/1d')
      expect(init.headers['PAYMENT-SIGNATURE']).toBe('base64-payment-proof')
    })

    it('should output JSON for --purchase-pass with --payment-signature and --json (step 2)', async () => {
      const passResponse = {
        apiKey: 'generated-key-hex',
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

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync([
        'node', 'aixbt', '--format', 'json', 'login',
        '--purchase-pass', '1d',
        '--payment-signature', 'base64-payment-proof',
      ], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('authenticated')
      expect(parsed.apiKey).toBe('generated-key-hex')
      expect(parsed.type).toBe('x402')
      expect(parsed.scopes).toEqual(['mcp', 'projects'])
      expect(parsed.expiresAt).toBe('2026-03-04T00:00:00.000Z')
      expect(parsed.period).toBe('1d')
      expect(parsed.rateLimit).toEqual({ requestsPerMinute: 30, requestsPerDay: 10000 })
      expect(parsed.warning).toBe('Save this API key now.')
    })

    it('should error on invalid --purchase-pass duration', async () => {
      const program = createProgram()
      program.exitOverride()
      await expect(
        program.parseAsync(['node', 'aixbt', 'login', '--purchase-pass', 'invalid'], { from: 'node' }),
      ).rejects.toThrow('Invalid duration')
    })

    it('should default to 1d when --purchase-pass is used without duration', async () => {
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

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

      const program = createProgram()
      program.exitOverride()
      try {
        await program.parseAsync(['node', 'aixbt', 'login', '--purchase-pass'], { from: 'node' })
      } catch { /* */ }

      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('/x402/v2/api-keys/1d')

      exitSpy.mockRestore()
    })

    it('should call the API with the provided key for validation', async () => {
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'login', '--api-key', 'my-secret-key'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toContain('/v2/api-keys/info')
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('my-secret-key')
    })
  })

  // -- logout --

  describe('logout', () => {
    it('should clear auth fields from config', async () => {
      writeConfig({
        apiKey: 'stored-key',
        keyType: 'full',
        expiresAt: 'never',
        scopes: ['read'],
        apiUrl: 'https://custom.api.com',
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'logout'], { from: 'node' })

      const config = readConfig()
      expect(config.apiKey).toBeUndefined()
      expect(config.keyType).toBeUndefined()
      expect(config.expiresAt).toBeUndefined()
      expect(config.scopes).toBeUndefined()
    })

    it('should preserve non-auth fields like apiUrl', async () => {
      writeConfig({
        apiKey: 'stored-key',
        keyType: 'full',
        apiUrl: 'https://custom.api.com',
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'logout'], { from: 'node' })

      const config = readConfig()
      expect(config.apiUrl).toBe('https://custom.api.com')
    })

    it('should output JSON with status logged_out in --json mode', async () => {
      writeConfig({ apiKey: 'stored-key' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'logout'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"logged_out"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('logged_out')
    })
  })

  // -- whoami --

  describe('whoami', () => {
    it('should show auth info when key is configured', async () => {
      writeConfig({ apiKey: 'stored-key-abc123' })
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'whoami'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Should have printed key info
      const allOutput = logs.join('\n')
      expect(allOutput).toContain('full')
    })

    it('should show "not authenticated" when no key is configured', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'whoami'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Not authenticated')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should output JSON for authenticated state with --json', async () => {
      writeConfig({ apiKey: 'stored-key-abc123' })
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'whoami'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.authenticated).toBe(true)
      expect(parsed.keyType).toBe('full')
      expect(parsed.scopes).toEqual(['read', 'write'])
      expect(parsed.expiresAt).toBe('never')
    })

    it('should output JSON for unauthenticated state with --json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'whoami'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.authenticated).toBe(false)
    })

    it('should mask the API key in JSON output', async () => {
      writeConfig({ apiKey: 'abcdef-long-key-suffix' })
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'whoami'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      // maskApiKey shows first 6 chars + ... + last 4 chars
      expect(parsed.key).not.toBe('abcdef-long-key-suffix')
      expect(parsed.key).toContain('...')
    })

    it('should throw when API validation fails for stored key', async () => {
      writeConfig({ apiKey: 'expired-key' })
      mockFetch.mockResolvedValueOnce(
        jsonResponse(401, { message: 'API key expired', code: 'API_KEY_EXPIRED' }),
      )

      const program = createProgram()
      program.exitOverride()
      await expect(
        program.parseAsync(['node', 'aixbt', 'whoami'], { from: 'node' }),
      ).rejects.toThrow()
    })

    it('should warn when key is expiring soon (< 24 hours)', async () => {
      writeConfig({ apiKey: 'stored-key-abc123' })
      const soonExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { ...VALID_KEY_INFO, expiresAt: soonExpiry } }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'whoami'], { from: 'node' })

      const allErrors = errors.join('\n')
      expect(allErrors).toContain('expires in less than 24 hours')
    })

    it('should set expiringSoon to true in JSON when key is expiring soon', async () => {
      writeConfig({ apiKey: 'stored-key-abc123' })
      const soonExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { ...VALID_KEY_INFO, expiresAt: soonExpiry } }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'whoami'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.expiringSoon).toBe(true)
    })

    it('should not warn for already-expired keys (expiringSoon is false)', async () => {
      writeConfig({ apiKey: 'stored-key-abc123' })
      const pastExpiry = new Date(Date.now() - 1000).toISOString()
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { ...VALID_KEY_INFO, expiresAt: pastExpiry } }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'whoami'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"authenticated"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.expiringSoon).toBe(false)
    })
  })

  // -- login edge cases --

  describe('login edge cases', () => {
    it('should reject empty API key passed via --api-key flag', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'login', '--api-key', '   '], { from: 'node' }),
      ).rejects.toThrow('API key cannot be empty')
    })

    it('should trim whitespace from API key before storing', async () => {
      mockValidKeyResponse()

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'login', '--api-key', '  test-key-123  '], { from: 'node' })

      const config = readConfig()
      expect(config.apiKey).toBe('test-key-123')

      // Verify the trimmed key was sent to the API
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-key-123')
    })
  })
})
