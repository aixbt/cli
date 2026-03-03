import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath, readConfig, writeConfig } from '../../src/lib/config.js'

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

describe('config commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-config-cmd-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    logs = []
    errors = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-config-cmd-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  // -- config get --

  describe('config get', () => {
    it('should show a single config value', async () => {
      writeConfig({ apiUrl: 'https://custom.api.com' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get', 'apiUrl'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('https://custom.api.com')
    })

    it('should show all config when no key specified', async () => {
      writeConfig({
        apiKey: 'secret-key-1234567890',
        apiUrl: 'https://custom.api.com',
        keyType: 'full',
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('apiUrl')
      expect(output).toContain('https://custom.api.com')
      expect(output).toContain('keyType')
      expect(output).toContain('full')
    })

    it('should mask API key in output', async () => {
      writeConfig({ apiKey: 'abcdef-long-key-suffix' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get', 'apiKey'], { from: 'node' })

      const output = logs.join('\n')
      // Should not contain the raw key
      expect(output).not.toContain('abcdef-long-key-suffix')
      // Should contain the masked form (first 6 + ... + last 4)
      expect(output).toContain('...')
    })

    it('should error on invalid key name', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'get', 'invalidKey'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should output JSON for a single key with --json', async () => {
      writeConfig({ apiUrl: 'https://custom.api.com' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'config', 'get', 'apiUrl'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"apiUrl"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.apiUrl).toBe('https://custom.api.com')
    })

    it('should output JSON for all config with --json', async () => {
      writeConfig({
        apiKey: 'secret-key',
        apiUrl: 'https://custom.api.com',
        keyType: 'full',
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'config', 'get'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"apiKey"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      // JSON mode shows raw values (no masking)
      expect(parsed.apiKey).toBe('secret-key')
      expect(parsed.apiUrl).toBe('https://custom.api.com')
      expect(parsed.keyType).toBe('full')
    })

    it('should return null for unset single key in JSON mode', async () => {
      writeConfig({})

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'config', 'get', 'apiKey'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"apiKey"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.apiKey).toBeNull()
    })
  })

  // -- config set --

  describe('config set', () => {
    it('should set a single config value', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'apiUrl', 'https://new.api.com'], { from: 'node' })

      const config = readConfig()
      expect(config.apiUrl).toBe('https://new.api.com')
    })

    it('should handle scopes as comma-separated list', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'scopes', 'read,write,admin'], { from: 'node' })

      const config = readConfig()
      expect(config.scopes).toEqual(['read', 'write', 'admin'])
    })

    it('should trim whitespace from comma-separated scopes', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'scopes', 'read , write , admin'], { from: 'node' })

      const config = readConfig()
      expect(config.scopes).toEqual(['read', 'write', 'admin'])
    })

    it('should error on invalid key name', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'invalidKey', 'value'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should output JSON confirmation with --json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'config', 'set', 'apiUrl', 'https://new.api.com'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"key"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.key).toBe('apiUrl')
      expect(parsed.value).toBe('https://new.api.com')
    })

    it('should output JSON with array value for scopes with --json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'config', 'set', 'scopes', 'read,write'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"key"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.key).toBe('scopes')
      expect(parsed.value).toEqual(['read', 'write'])
    })

    it('should preserve existing config values when setting a new one', async () => {
      writeConfig({ apiKey: 'existing-key', keyType: 'full' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'apiUrl', 'https://new.api.com'], { from: 'node' })

      const config = readConfig()
      expect(config.apiKey).toBe('existing-key')
      expect(config.keyType).toBe('full')
      expect(config.apiUrl).toBe('https://new.api.com')
    })
  })
})
