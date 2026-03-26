import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath } from '../../src/lib/config.js'
import { handleTopLevelError } from '../../src/lib/errors.js'
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

// -- Mock @inquirer/prompts (imported by login.ts which is registered on the program) --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

// -- Helpers --

/**
 * Simulates the main() function from cli.ts: creates a program, parses args,
 * and routes errors through handleTopLevelError just like the real CLI does.
 */
async function runCli(args: string[]): Promise<void> {
  const program = createProgram()
  try {
    await program.parseAsync(args, { from: 'node' })
  } catch (err: unknown) {
    await handleTopLevelError(err, (program.opts().format as 'human' | 'json' | 'toon') ?? 'human')
  }
}

// -- Test suite --

describe('E2E smoke tests', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-smoke-'))
    setConfigPath(join(tempDir, 'config.json'))
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
    setConfigPath(join(tmpdir(), 'aixbt-smoke-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    mockExit.mockRestore()
  })

  // ----------------------------------------------------------------
  // 1. --version flag
  // ----------------------------------------------------------------

  describe('--version flag', () => {
    it('should throw CommanderError with exitCode 0 when -V is passed', () => {
      const program = createProgram()
      program.exitOverride()

      try {
        program.parse(['node', 'test', '-V'], { from: 'node' })
        expect.unreachable('should have thrown')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error)
        expect(err).toHaveProperty('exitCode', 0)
        expect(err).toHaveProperty('code', 'commander.version')
      }
    })

    it('should throw CommanderError with exitCode 0 when --version is passed', () => {
      const program = createProgram()
      program.exitOverride()

      try {
        program.parse(['node', 'test', '--version'], { from: 'node' })
        expect.unreachable('should have thrown')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error)
        expect(err).toHaveProperty('exitCode', 0)
        expect(err).toHaveProperty('code', 'commander.version')
      }
    })
  })

  // ----------------------------------------------------------------
  // 2. --help flag
  // ----------------------------------------------------------------

  describe('--help flag', () => {
    it('should include all expected content in help output', () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true)

      try {
        const program = createProgram()
        program.outputHelp()

        const fullOutput = mockStdoutWrite.mock.calls
          .map((call) => String(call[0]))
          .join('')
        // Strip ANSI escape codes
        // eslint-disable-next-line no-control-regex
        const stripped = fullOutput.replace(/\x1b\[[0-9;]*m/g, '')

        expect(stripped).toContain('AIXBT')
        expect(stripped).toContain('v0.1.3')
        expect(stripped).toContain('login')
        expect(stripped).toContain('projects')
        expect(stripped).toContain('signals')
        expect(stripped).toContain('recipe')
        expect(stripped).toContain('--format')
        expect(stripped).toContain('--delayed')
        expect(stripped).toContain('--pay-per-use')
      } finally {
        mockStdoutWrite.mockRestore()
      }
    })
  })

  // ----------------------------------------------------------------
  // 3. No API key should produce NoApiKeyError structured guidance
  // ----------------------------------------------------------------

  describe('no API key error', () => {
    it('should output structured NoApiKeyError JSON when running projects --json without auth', async () => {
      // No AIXBT_API_KEY set, no config file
      delete process.env.AIXBT_API_KEY

      try {
        await runCli(['node', 'test', '--format', 'json', 'projects'])
      } catch {
        // handleTopLevelError calls process.exit which we've mocked to throw
      }

      // The error handler outputs JSON to console.log when --json is set
      const jsonOutput = logs.find((l) => l.includes('no_api_key'))
      expect(jsonOutput).toBeTruthy()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('no_api_key')
      expect(parsed.message).toBe('No API key configured')
      expect(parsed.options).toBeDefined()
      expect(Array.isArray(parsed.options)).toBe(true)
      expect(parsed.options.length).toBeGreaterThan(0)

      // Verify exit code 1
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should output human-readable NoApiKeyError when running projects without --json', async () => {
      delete process.env.AIXBT_API_KEY

      try {
        await runCli(['node', 'test', 'projects'])
      } catch {
        // handleTopLevelError calls process.exit
      }

      // renderNoApiKeyError outputs to console.log (stdout)
      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Not authenticated')
      expect(allOutput).toContain('aixbt login')
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  // ----------------------------------------------------------------
  // 4. projects --json with mocked API
  // ----------------------------------------------------------------

  describe('projects --json with mocked API', () => {
    const MOCK_PROJECTS = [
      { id: 'proj-1', name: 'Bitcoin', momentumScore: 85.5, signals: [] },
      { id: 'proj-2', name: 'Ethereum', momentumScore: 72.3, signals: [] },
    ]

    it('should output project data as JSON and call API with correct headers', async () => {
      process.env.AIXBT_API_KEY = 'smoke-test-key'

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECTS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'projects'], { from: 'node' })

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Verify the URL path
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects')

      // Verify the X-API-Key header
      const callOptions = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
      expect(callOptions.headers['X-API-Key']).toBe('smoke-test-key')

      // Verify JSON output (outputApiResult wraps in { data: ... } envelope)
      const jsonOutput = logs.find((l) => l.includes('Bitcoin'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toHaveLength(2)
      expect(parsed.data[0].name).toBe('Bitcoin')
      expect(parsed.data[1].name).toBe('Ethereum')
    })
  })

  // ----------------------------------------------------------------
  // 5. recipe validate with a valid YAML file
  // ----------------------------------------------------------------

  describe('recipe validate', () => {
    it('should output valid status for a well-formed recipe YAML', async () => {
      const yamlContent = `
name: smoke-test-recipe
version: "1.0"
description: A recipe for smoke testing
steps:
  - id: fetch_projects
    type: api
    action: "GET /v2/projects"
`
      const filePath = join(tempDir, 'valid-recipe.yaml')
      writeFileSync(filePath, yamlContent, 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath], { from: 'node' })

      const jsonOutput = logs.find((l) => l.includes('valid'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('valid')
      expect(parsed.recipe).toBe('smoke-test-recipe')
      expect(parsed.stepCount).toBe(1)
    })

    it('should report invalid status for a recipe missing required name field', async () => {
      const yamlContent = `
version: "1.0"
steps:
  - id: fetch
    type: api
    action: "GET /v2/projects"
`
      const filePath = join(tempDir, 'invalid-recipe.yaml')
      writeFileSync(filePath, yamlContent, 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      const program = createProgram()
      program.exitOverride()

      try {
        await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath], { from: 'node' })
      } catch {
        // process.exit called
      }

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find((l) => l.includes('invalid'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('invalid')
      expect(parsed.issues.length).toBeGreaterThan(0)
    })

    it('should error when file does not exist', async () => {
      const filePath = join(tempDir, 'nonexistent.yaml')

      process.env.AIXBT_API_KEY = 'test-key'

      try {
        await runCli(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath])
      } catch {
        // process.exit throws
      }

      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  // ----------------------------------------------------------------
  // 6. recipe run with mocked API
  // ----------------------------------------------------------------

  describe('recipe run with mocked API', () => {
    it('should execute a recipe and produce complete status with data', async () => {
      const yamlContent = `
name: run-smoke-test
version: "1.0"
description: Run smoke test
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      const filePath = join(tempDir, 'run-recipe.yaml')
      writeFileSync(filePath, yamlContent, 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: [{ id: 'p1', name: 'TestProject' }],
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'run', filePath], { from: 'node' })

      const jsonOutput = logs.find((l) => l.includes('complete'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('complete')
      expect(parsed.data).toBeDefined()
      expect(parsed.data.projects).toBeDefined()
    })
  })

  // ----------------------------------------------------------------
  // 7. Exit codes
  // ----------------------------------------------------------------

  describe('exit codes', () => {
    it('should exit with code 1 for auth errors', async () => {
      delete process.env.AIXBT_API_KEY

      try {
        await runCli(['node', 'test', '--format', 'json', 'projects'])
      } catch {
        // process.exit throws
      }

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should exit with code 1 for invalid recipe validate', async () => {
      const filePath = join(tempDir, 'bad.yaml')
      writeFileSync(filePath, 'not a valid recipe: [', 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      const program = createProgram()
      program.exitOverride()

      try {
        await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath], { from: 'node' })
      } catch {
        // process.exit throws or Commander throws
      }

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should exit with code 1 for missing recipe file in recipe run', async () => {
      const filePath = join(tempDir, 'does-not-exist.yaml')

      process.env.AIXBT_API_KEY = 'test-key'

      try {
        await runCli(['node', 'test', '--format', 'json', 'recipe', 'run', filePath])
      } catch {
        // process.exit throws
      }

      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  // ----------------------------------------------------------------
  // 8. stdout/stderr separation
  // ----------------------------------------------------------------

  describe('stdout/stderr separation', () => {
    it('should write JSON data to stdout (console.log) in --json mode', async () => {
      process.env.AIXBT_API_KEY = 'test-key'

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [{ id: 'p1', name: 'Test' }] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'projects'], { from: 'node' })

      // Data should be in logs (console.log -> stdout), not errors (console.error -> stderr)
      // outputApiResult wraps in { data: ... } envelope; id is filtered at default verbosity, use name
      const jsonData = logs.find((l) => l.includes('"Test"'))
      expect(jsonData).toBeDefined()
      const errorData = errors.find((l) => l.includes('"Test"'))
      expect(errorData).toBeUndefined()
    })

    it('should write NoApiKeyError output to stdout in non-JSON mode', async () => {
      delete process.env.AIXBT_API_KEY

      try {
        await runCli(['node', 'test', 'projects'])
      } catch {
        // process.exit throws
      }

      // renderNoApiKeyError outputs to console.log (stdout), not stderr
      const logMsg = logs.find((l) => l.includes('Not authenticated'))
      expect(logMsg).toBeDefined()

      // The styled no-API-key output should NOT be in console.error (stderr)
      const errMsg = errors.find((l) => l.includes('Not authenticated'))
      expect(errMsg).toBeUndefined()
    })
  })

  // ----------------------------------------------------------------
  // 9. --json output structure validation
  // ----------------------------------------------------------------

  describe('--json output structure validation', () => {
    it('should output valid parseable JSON for successful commands', async () => {
      process.env.AIXBT_API_KEY = 'test-key'

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [{ id: 'p1', name: 'Test' }] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'projects'], { from: 'node' })

      // Find the JSON output line
      const jsonLine = logs.find((l) => {
        try {
          JSON.parse(l)
          return true
        } catch {
          return false
        }
      })
      expect(jsonLine).toBeTruthy()
      const parsed = JSON.parse(jsonLine!)
      expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true)
    })

    it('should include error and message fields in error JSON output', async () => {
      delete process.env.AIXBT_API_KEY

      try {
        await runCli(['node', 'test', '--format', 'json', 'projects'])
      } catch {
        // process.exit throws
      }

      const jsonLine = logs.find((l) => {
        try {
          const p = JSON.parse(l)
          return 'error' in p
        } catch {
          return false
        }
      })
      expect(jsonLine).toBeTruthy()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed).toHaveProperty('error')
      expect(parsed).toHaveProperty('message')
    })

    it('should produce valid JSON for recipe validate success', async () => {
      const yamlContent = `
name: json-validate-test
version: "1.0"
description: Testing JSON output
steps:
  - id: step1
    type: api
    action: "GET /v2/projects"
`
      const filePath = join(tempDir, 'json-test.yaml')
      writeFileSync(filePath, yamlContent, 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath], { from: 'node' })

      const jsonLine = logs.find((l) => {
        try {
          JSON.parse(l)
          return true
        } catch {
          return false
        }
      })
      expect(jsonLine).toBeTruthy()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.status).toBe('valid')
    })

    it('should produce valid JSON with error fields for recipe validate failure', async () => {
      const yamlContent = `
version: "1.0"
steps:
  - id: step1
    type: api
    action: "GET /v2/projects"
`
      const filePath = join(tempDir, 'invalid-json-test.yaml')
      writeFileSync(filePath, yamlContent, 'utf-8')

      process.env.AIXBT_API_KEY = 'test-key'

      const program = createProgram()
      program.exitOverride()

      try {
        await program.parseAsync(['node', 'test', '--format', 'json', 'recipe', 'validate', filePath], { from: 'node' })
      } catch {
        // process.exit throws
      }

      const jsonLine = logs.find((l) => {
        try {
          JSON.parse(l)
          return true
        } catch {
          return false
        }
      })
      expect(jsonLine).toBeTruthy()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.status).toBe('invalid')
      expect(parsed.issues).toBeDefined()
      expect(Array.isArray(parsed.issues)).toBe(true)
    })
  })
})
