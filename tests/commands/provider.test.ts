import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath } from '../../src/lib/config.js'

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

// -- Mock @inquirer/prompts (imported by login.ts which is registered on the program) --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

// -- Mock providerRequest --

const mockProviderRequest = vi.fn()
vi.mock('../../src/lib/providers/client.js', () => ({
  providerRequest: (...args: unknown[]) => mockProviderRequest(...args),
}))

// -- Mock provider config functions --

const mockSaveProviderKey = vi.fn()
const mockRemoveProviderKey = vi.fn()
const mockResolveProviderKey = vi.fn()
vi.mock('../../src/lib/providers/config.js', () => ({
  resolveProviderKey: (...args: unknown[]) => mockResolveProviderKey(...args),
  saveProviderKey: (...args: unknown[]) => mockSaveProviderKey(...args),
  removeProviderKey: (...args: unknown[]) => mockRemoveProviderKey(...args),
}))

/**
 * Create a program instance with exitOverride and enablePositionalOptions.
 * enablePositionalOptions is needed because the global --api-key option
 * would otherwise swallow the subcommand's --api-key before it reaches
 * the provider add subcommand.
 */
function makeProgram() {
  const program = createProgram()
  program.exitOverride()
  program.enablePositionalOptions()
  return program
}

describe('provider commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    mockProviderRequest.mockReset()
    mockSaveProviderKey.mockReset()
    mockRemoveProviderKey.mockReset()
    mockResolveProviderKey.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-provider-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = 'test-key-123'
    logs = []
    errors = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-provider-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    mockExit.mockRestore()
  })

  // -- provider add --

  describe('provider add', () => {
    it('should save a provider key and report success in JSON mode', async () => {
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'defillama', action: 'chains' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'defillama', '--api-key', 'test-key-abc'],
        { from: 'node' },
      )

      expect(mockSaveProviderKey).toHaveBeenCalledTimes(1)
      expect(mockSaveProviderKey).toHaveBeenCalledWith('defillama', { apiKey: 'test-key-abc', tier: 'pro' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('added')
      expect(parsed.provider).toBe('defillama')
      expect(parsed.tier).toBe('pro')
      expect(parsed.verified).toBe(true)
    })

    it('should infer demo tier for CoinGecko keys starting with CG-', async () => {
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'coingecko', action: 'trending' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'coingecko', '--api-key', 'CG-demo-key-123'],
        { from: 'node' },
      )

      expect(mockSaveProviderKey).toHaveBeenCalledWith('coingecko', { apiKey: 'CG-demo-key-123', tier: 'demo' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.tier).toBe('demo')
    })

    it('should infer pro tier for CoinGecko keys not starting with CG-', async () => {
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'coingecko', action: 'trending' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'coingecko', '--api-key', 'pro-key-xyz'],
        { from: 'node' },
      )

      expect(mockSaveProviderKey).toHaveBeenCalledWith('coingecko', { apiKey: 'pro-key-xyz', tier: 'pro' })
    })

    it('should infer free tier for goplus', async () => {
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'goplus', action: 'supported-chains' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'goplus', '--api-key', 'goplus-key'],
        { from: 'node' },
      )

      expect(mockSaveProviderKey).toHaveBeenCalledWith('goplus', { apiKey: 'goplus-key', tier: 'free' })
    })

    it('should use explicit --tier flag over inferred tier', async () => {
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'coingecko', action: 'trending' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'coingecko', '--api-key', 'CG-demo-key', '--tier', 'pro'],
        { from: 'node' },
      )

      expect(mockSaveProviderKey).toHaveBeenCalledWith('coingecko', { apiKey: 'CG-demo-key', tier: 'pro' })
    })

    it('should error for unknown provider names', async () => {
      const program = makeProgram()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'unknown-provider', '--api-key', 'key'],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockSaveProviderKey).not.toHaveBeenCalled()
    })

    it('should skip verification when --skip-verify is passed', async () => {
      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'add', 'defillama', '--api-key', 'key', '--skip-verify'],
        { from: 'node' },
      )

      expect(mockProviderRequest).not.toHaveBeenCalled()
      expect(mockSaveProviderKey).toHaveBeenCalledTimes(1)

      const jsonOutput = logs.find(l => l.includes('"status"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.verified).toBe(false)
    })

    it('should display success message in human mode', async () => {
      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', 'provider', 'add', 'defillama', '--api-key', 'test-key', '--skip-verify'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('defillama')
      expect(allOutput).toContain('configured')
    })
  })

  // -- provider list --

  describe('provider list', () => {
    it('should display all non-AIXBT providers in JSON mode', async () => {
      mockResolveProviderKey.mockReturnValue(null)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'list'],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('defillama'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(Array.isArray(parsed)).toBe(true)

      const names = parsed.map((r: Record<string, unknown>) => r.name)
      expect(names).toContain('defillama')
      expect(names).toContain('coingecko')
      expect(names).toContain('goplus')
      expect(names).not.toContain('aixbt')
    })

    it('should show configured status when a provider key exists', async () => {
      mockResolveProviderKey.mockImplementation((name: string) => {
        if (name === 'defillama') return { apiKey: 'key', tier: 'pro', source: 'config' }
        return null
      })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'list'],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('defillama'))
      const parsed = JSON.parse(jsonOutput!)
      const defillama = parsed.find((r: Record<string, unknown>) => r.name === 'defillama')
      expect(defillama.configured).toBe(true)
      expect(defillama.tier).toBe('pro')
      expect(defillama.source).toBe('config')

      const coingecko = parsed.find((r: Record<string, unknown>) => r.name === 'coingecko')
      expect(coingecko.configured).toBe(false)
      expect(coingecko.tier).toBe('free')
    })

    it('should render table output in human mode', async () => {
      mockResolveProviderKey.mockReturnValue(null)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', 'provider', 'list'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Provider')
      expect(allOutput).toContain('defillama')
      expect(allOutput).toContain('coingecko')
      expect(allOutput).toContain('goplus')
    })
  })

  // -- provider remove --

  describe('provider remove', () => {
    it('should remove a provider key and report success in JSON mode', async () => {
      mockRemoveProviderKey.mockReturnValue(true)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'remove', 'defillama'],
        { from: 'node' },
      )

      expect(mockRemoveProviderKey).toHaveBeenCalledWith('defillama')

      const jsonOutput = logs.find(l => l.includes('"status"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('removed')
      expect(parsed.provider).toBe('defillama')
    })

    it('should report not_found when no stored key exists', async () => {
      mockRemoveProviderKey.mockReturnValue(false)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'remove', 'defillama'],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('"status"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('not_found')
    })

    it('should display success message in human mode when removed', async () => {
      mockRemoveProviderKey.mockReturnValue(true)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', 'provider', 'remove', 'defillama'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('defillama')
      expect(allOutput).toContain('removed')
    })

    it('should display dim message in human mode when not found', async () => {
      mockRemoveProviderKey.mockReturnValue(false)

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', 'provider', 'remove', 'defillama'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No stored key')
    })

    it('should error for unknown provider names', async () => {
      const program = makeProgram()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'provider', 'remove', 'nonexistent'],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockRemoveProviderKey).not.toHaveBeenCalled()
    })
  })

  // -- provider test --

  describe('provider test', () => {
    it('should probe the API and report success in JSON mode', async () => {
      mockResolveProviderKey.mockReturnValue({ apiKey: 'test-key', tier: 'pro', source: 'config' })
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'defillama', action: 'chains' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'test', 'defillama'],
        { from: 'node' },
      )

      expect(mockProviderRequest).toHaveBeenCalledTimes(1)
      const callOpts = mockProviderRequest.mock.calls[0][0]
      expect(callOpts.actionName).toBe('chains')

      const jsonOutput = logs.find(l => l.includes('"status"'))
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('ok')
      expect(parsed.provider).toBe('defillama')
      expect(parsed.tier).toBe('pro')
      expect(parsed.source).toBe('config')
    })

    it('should use free probe action when tier is free', async () => {
      mockResolveProviderKey.mockReturnValue(null)
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'coingecko', action: 'trending-pools' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'test', 'coingecko'],
        { from: 'node' },
      )

      const callOpts = mockProviderRequest.mock.calls[0][0]
      expect(callOpts.actionName).toBe('trending-pools')
    })

    it('should use pro probe action when tier is not free', async () => {
      mockResolveProviderKey.mockReturnValue({ apiKey: 'key', tier: 'pro', source: 'config' })
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'coingecko', action: 'trending' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'provider', 'test', 'coingecko'],
        { from: 'node' },
      )

      const callOpts = mockProviderRequest.mock.calls[0][0]
      expect(callOpts.actionName).toBe('trending')
    })

    it('should display human-readable output on success', async () => {
      mockResolveProviderKey.mockReturnValue({ apiKey: 'key', tier: 'pro', source: 'config' })
      mockProviderRequest.mockResolvedValueOnce({ data: {}, status: 200, provider: 'defillama', action: 'chains' })

      const program = makeProgram()
      await program.parseAsync(
        ['node', 'aixbt', 'provider', 'test', 'defillama'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('reachable')
    })

    it('should error for unknown provider names', async () => {
      const program = makeProgram()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'provider', 'test', 'nonexistent'],
          { from: 'node' },
        ),
      ).rejects.toThrow()
    })
  })
})
