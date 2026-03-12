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

    it('should show all preference keys when no key specified', async () => {
      writeConfig({
        apiUrl: 'https://custom.api.com',
        format: 'json',
        limit: 50,
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('apiUrl')
      expect(output).toContain('https://custom.api.com')
      expect(output).toContain('format')
      expect(output).toContain('json')
      expect(output).toContain('limit')
      expect(output).toContain('50')
    })

    it('should not show auth keys like apiKey in config get output', async () => {
      // Even if apiKey is stored in config, config get should only iterate ALLOWED_KEYS
      writeConfig({
        apiKey: 'secret-key',
        apiUrl: 'https://custom.api.com',
        format: 'human',
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).not.toContain('apiKey')
      expect(output).not.toContain('secret-key')
    })

    it('should error when getting a key not in allowed list', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'get', 'apiKey'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should error on invalid key name', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'get', 'invalidKey'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should show format value when stored', async () => {
      writeConfig({ format: 'toon' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get', 'format'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('toon')
    })

    it('should show limit value when stored', async () => {
      writeConfig({ limit: 25 })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'get', 'limit'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('25')
    })

    it('should output JSON for a single key with --format json', async () => {
      writeConfig({ apiUrl: 'https://custom.api.com' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'config', 'get', 'apiUrl'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"apiUrl"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.apiUrl).toBe('https://custom.api.com')
    })

    it('should output JSON for all config with --format json', async () => {
      writeConfig({
        apiUrl: 'https://custom.api.com',
        format: 'json',
        limit: 10,
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'config', 'get'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"apiUrl"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.apiUrl).toBe('https://custom.api.com')
      expect(parsed.format).toBe('json')
      expect(parsed.limit).toBe(10)
    })

    it('should return null for unset single key in JSON mode', async () => {
      writeConfig({})

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'config', 'get', 'format'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"format"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.format).toBeNull()
    })
  })

  // -- config set --

  describe('config set', () => {
    it('should set apiUrl value', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'apiUrl', 'https://new.api.com'], { from: 'node' })

      const config = readConfig()
      expect(config.apiUrl).toBe('https://new.api.com')
    })

    it('should set format to human', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'format', 'human'], { from: 'node' })

      const config = readConfig()
      expect(config.format).toBe('human')
    })

    it('should set format to json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'format', 'json'], { from: 'node' })

      const config = readConfig()
      expect(config.format).toBe('json')
    })

    it('should set format to toon', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'format', 'toon'], { from: 'node' })

      const config = readConfig()
      expect(config.format).toBe('toon')
    })

    it('should reject invalid format value', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'format', 'yaml'], { from: 'node' }),
      ).rejects.toThrow('Invalid format')
    })

    it('should store limit as a number', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'limit', '50'], { from: 'node' })

      const config = readConfig()
      expect(config.limit).toBe(50)
      expect(typeof config.limit).toBe('number')
    })

    it('should reject limit of zero', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'limit', '0'], { from: 'node' }),
      ).rejects.toThrow('Invalid limit')
    })

    it('should reject negative limit', async () => {
      // Commander interprets negative numbers as option flags, so -5 is caught
      // as "unknown option" before reaching our validation. Either way the
      // command rejects the input.
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'limit', '-5'], { from: 'node' }),
      ).rejects.toThrow()
    })

    it('should reject non-integer limit', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'limit', 'abc'], { from: 'node' }),
      ).rejects.toThrow('Invalid limit')
    })

    it('should error on key not in allowed list', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'apiKey', 'xxx'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should error on invalid key name', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'config', 'set', 'invalidKey', 'value'], { from: 'node' }),
      ).rejects.toThrow('Unknown config key')
    })

    it('should output JSON confirmation with --format json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'config', 'set', 'apiUrl', 'https://new.api.com'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"key"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.key).toBe('apiUrl')
      expect(parsed.value).toBe('https://new.api.com')
    })

    it('should output JSON with number value for limit with --format json', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'config', 'set', 'limit', '25'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"key"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.key).toBe('limit')
      expect(parsed.value).toBe(25)
    })

    it('should preserve existing config values when setting a new one', async () => {
      writeConfig({ apiUrl: 'https://existing.api.com', format: 'json' })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'limit', '30'], { from: 'node' })

      const config = readConfig()
      expect(config.apiUrl).toBe('https://existing.api.com')
      expect(config.format).toBe('json')
      expect(config.limit).toBe(30)
    })

    it('should show success message in human format', async () => {
      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'config', 'set', 'format', 'human'], { from: 'node' })

      const output = logs.join('\n')
      expect(output).toContain('Set format')
    })
  })
})
