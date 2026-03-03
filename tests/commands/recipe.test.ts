import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

// -- Helpers --

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response
}

// -- YAML fixtures --

const VALID_RECIPE_YAML = `
name: test-recipe
version: "1.0"
description: A test recipe
steps:
  - id: projects
    endpoint: "GET /v2/projects"
`

const INVALID_RECIPE_YAML_NO_NAME = `
steps:
  - id: projects
    endpoint: "GET /v2/projects"
`

const INVALID_RECIPE_YAML_NO_STEPS = `
name: broken-recipe
version: "1.0"
`

const VALID_RECIPE_WITH_PARAMS_YAML = `
name: param-recipe
version: "2.0"
description: Recipe with params
params:
  chain:
    type: string
    required: true
    description: Blockchain to query
steps:
  - id: projects
    endpoint: "GET /v2/projects"
    params:
      chain: "{params.chain}"
`

describe('recipe commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-recipe-test-'))
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
    setConfigPath(join(tmpdir(), 'aixbt-recipe-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    mockExit.mockRestore()
  })

  // -- recipe validate --

  describe('recipe validate', () => {
    it('should report success for a valid recipe file', async () => {
      const recipeFile = join(tempDir, 'valid.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'recipe', 'validate', recipeFile], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('valid')
      expect(allOutput).toContain('test-recipe')
    })

    it('should report issues for a recipe missing the name field', async () => {
      const recipeFile = join(tempDir, 'invalid.yaml')
      writeFileSync(recipeFile, INVALID_RECIPE_YAML_NO_NAME)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'recipe', 'validate', recipeFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should report issues for a recipe missing the steps field', async () => {
      const recipeFile = join(tempDir, 'no-steps.yaml')
      writeFileSync(recipeFile, INVALID_RECIPE_YAML_NO_STEPS)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'recipe', 'validate', recipeFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should error when the file does not exist', async () => {
      const missingFile = join(tempDir, 'nonexistent.yaml')

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'recipe', 'validate', missingFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const allErrors = errors.join('\n')
      expect(allErrors).toContain('File not found')
    })

    it('should output JSON with status valid for a valid recipe when --json is used', async () => {
      const recipeFile = join(tempDir, 'valid.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'validate', recipeFile], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('valid')
      expect(parsed.recipe).toBe('test-recipe')
      expect(parsed.version).toBe('1.0')
      expect(parsed.stepCount).toBe(1)
    })

    it('should output JSON with status invalid for an invalid recipe when --json is used', async () => {
      const recipeFile = join(tempDir, 'invalid.yaml')
      writeFileSync(recipeFile, INVALID_RECIPE_YAML_NO_NAME)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'validate', recipeFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('invalid')
      expect(parsed.issueCount).toBeGreaterThan(0)
      expect(parsed.issues).toBeInstanceOf(Array)
    })

    it('should output JSON with file-not-found error when --json is used and file is missing', async () => {
      const missingFile = join(tempDir, 'nonexistent.yaml')

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'validate', missingFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('invalid')
      expect(parsed.issues[0].message).toContain('File not found')
    })

    it('should display step count and param count in the summary', async () => {
      const recipeFile = join(tempDir, 'with-params.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_WITH_PARAMS_YAML)

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'validate', recipeFile], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('valid')
      expect(parsed.recipe).toBe('param-recipe')
      expect(parsed.stepCount).toBe(1)
      expect(parsed.paramCount).toBe(1)
    })
  })

  // -- recipe run --

  describe('recipe run', () => {
    it('should execute a recipe from a file and output the result', async () => {
      const recipeFile = join(tempDir, 'run.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: [{ id: 'proj-1', name: 'Bitcoin' }],
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--json', 'recipe', 'run', recipeFile],
        { from: 'node' },
      )

      // Verify the API was called
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects')

      // Verify the output contains the recipe result
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('complete')
      expect(parsed.data.projects).toBeDefined()
    })

    it('should error when no source is provided and --stdin is not used', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'run'], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('NO_SOURCE')
    })

    it('should error when source is a non-existent name (registry not available)', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--json', 'recipe', 'run', 'my-recipe-name'], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('REGISTRY_NOT_AVAILABLE')
    })

    it('should output only data when --format raw is used', async () => {
      const recipeFile = join(tempDir, 'raw.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const mockData = [{ id: 'proj-1', name: 'Bitcoin' }]
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: mockData }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--json', 'recipe', 'run', '--format', 'raw', recipeFile],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      // With --format raw, should have status and data but NOT analysis/output
      expect(parsed.status).toBe('complete')
      expect(parsed.data).toBeDefined()
      // Should not include output or analysis keys when format is raw
      expect(parsed.output).toBeUndefined()
      expect(parsed.analysis).toBeUndefined()
    })

    it('should include output and analysis blocks when --format is prompt (default)', async () => {
      const recipeWithAnalysis = `
name: analysis-recipe
version: "1.0"
description: Recipe with analysis
steps:
  - id: projects
    endpoint: "GET /v2/projects"
analysis:
  instructions: "Analyze the data"
  task: "Summarize trends"
`
      const recipeFile = join(tempDir, 'analysis.yaml')
      writeFileSync(recipeFile, recipeWithAnalysis)

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [{ id: 'proj-1' }] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--json', 'recipe', 'run', recipeFile],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('complete')
      expect(parsed.analysis).toBeDefined()
      expect(parsed.analysis.instructions).toBe('Analyze the data')
      expect(parsed.analysis.task).toBe('Summarize trends')
    })

    it('should error when no source is provided without --json', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', 'recipe', 'run'], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const allErrors = errors.join('\n')
      expect(allErrors).toContain('Provide a recipe file path or --stdin')
    })

    it('should error with invalid JSON for --input flag', async () => {
      const recipeFile = join(tempDir, 'resume.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--json', 'recipe', 'run', '--resume-from', 'step:agent1', '--input', 'not-json', recipeFile],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('INVALID_INPUT')
    })

    it('should use --delayed flag for recipe run (no auth required)', async () => {
      delete process.env.AIXBT_API_KEY

      const recipeFile = join(tempDir, 'delayed.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [{ id: 'proj-1' }] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--json', '--delayed', 'recipe', 'run', recipeFile],
        { from: 'node' },
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      // noAuth mode should not send X-API-Key
      expect(headers['X-API-Key']).toBeUndefined()
    })
  })
})
