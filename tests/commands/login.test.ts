import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath, readConfig, writeConfig } from '../../src/lib/config.js'

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

// -- Helpers --

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response
}

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
      await program.parseAsync(['node', 'aixbt', '--json', 'login', '--api-key', 'test-key-123'], { from: 'node' })

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

    it('should output "not yet implemented" for --purchase-pass', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'login', '--purchase-pass'], { from: 'node' })

      const hasWarning = errors.some(e => e.includes('not yet implemented'))
      expect(hasWarning).toBe(true)
    })

    it('should output JSON error for --purchase-pass with --json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'login', '--purchase-pass'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"not_implemented"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('not_implemented')
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
      await program.parseAsync(['node', 'aixbt', '--json', 'logout'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--json', 'whoami'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--json', 'whoami'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--json', 'whoami'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--json', 'whoami'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--json', 'whoami'], { from: 'node' })

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
