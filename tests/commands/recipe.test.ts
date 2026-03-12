import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath } from '../../src/lib/config.js'
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

  // -- recipe list --

  describe('recipe list', () => {
    const MOCK_RECIPES = [
      { name: 'defi-analysis', version: '1.0', description: 'Analyze DeFi protocols', paramCount: 2, estimatedTokens: 15000 },
      { name: 'market-scanner', version: '2.1', description: 'Scan market trends', paramCount: 0 },
    ]

    it('should fetch and display recipe list in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'recipe', 'list'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes')

      const allOutput = logs.join('\n')
      // Recipe names and versions should be present
      expect(allOutput).toContain('defi-analysis')
      expect(allOutput).toContain('v1.0')
      expect(allOutput).toContain('market-scanner')
      expect(allOutput).toContain('v2.1')
      // Descriptions
      expect(allOutput).toContain('Analyze DeFi protocols')
      expect(allOutput).toContain('Scan market trends')
      // Estimated tokens shown when present (15000 -> ~15k tokens)
      expect(allOutput).toContain('15k tokens')
      // Param count shown for recipes with params
      expect(allOutput).toContain('2 params')
      // Footer count
      expect(allOutput).toContain('2 recipes')
      // Footer hint for recipe info
      expect(allOutput).toContain('recipe info')
    })

    it('should fetch and display recipe list in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'list'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)

      const jsonOutput = logs.find(l => l.includes('defi-analysis'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].name).toBe('defi-analysis')
      expect(parsed[1].name).toBe('market-scanner')
    })

    it('should handle empty recipe list with a dim message', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'recipe', 'list'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No recipes available')
    })

    it('should not send X-API-Key header (unauthenticated endpoint)', async () => {
      delete process.env.AIXBT_API_KEY

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'list'], { from: 'node' })

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })
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

    it('should output JSON with status valid for a valid recipe when --format json is used', async () => {
      const recipeFile = join(tempDir, 'valid.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'validate', recipeFile], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('valid')
      expect(parsed.recipe).toBe('test-recipe')
      expect(parsed.version).toBe('1.0')
      expect(parsed.stepCount).toBe(1)
    })

    it('should output JSON with status invalid for an invalid recipe when --format json is used', async () => {
      const recipeFile = join(tempDir, 'invalid.yaml')
      writeFileSync(recipeFile, INVALID_RECIPE_YAML_NO_NAME)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'validate', recipeFile], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('invalid')
      expect(parsed.issueCount).toBeGreaterThan(0)
      expect(parsed.issues).toBeInstanceOf(Array)
    })

    it('should output JSON with file-not-found error when --format json is used and file is missing', async () => {
      const missingFile = join(tempDir, 'nonexistent.yaml')

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'validate', missingFile], { from: 'node' }),
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
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'validate', recipeFile], { from: 'node' })

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
        ['node', 'aixbt', '--format', 'json', 'recipe', 'run', recipeFile],
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
        program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'run'], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('NO_SOURCE')
    })

    it('should error when source looks like a file path but does not exist', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'run', './nonexistent.yaml'], { from: 'node' }),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('FILE_NOT_FOUND')
    })

    it('should output recipe result as JSON when --format json is used', async () => {
      const recipeFile = join(tempDir, 'raw.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const mockData = [{ id: 'proj-1', name: 'Bitcoin' }]
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: mockData }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'recipe', 'run', recipeFile],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('complete')
      expect(parsed.data).toBeDefined()
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
        ['node', 'aixbt', '--format', 'json', 'recipe', 'run', recipeFile],
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
      expect(allErrors).toContain('Provide a recipe file path, registry name, or --stdin')
    })

    it('should error with invalid JSON for --input flag', async () => {
      const recipeFile = join(tempDir, 'resume.yaml')
      writeFileSync(recipeFile, VALID_RECIPE_YAML)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'recipe', 'run', '--resume-from', 'step:agent1', '--input', 'not-json', recipeFile],
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
        ['node', 'aixbt', '--format', 'json', '--delayed', 'recipe', 'run', recipeFile],
        { from: 'node' },
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      // noAuth mode should not send X-API-Key
      expect(headers['X-API-Key']).toBeUndefined()
    })

    it('should fetch and execute recipe from registry when given a bare name', async () => {
      const registryRecipeYaml = `
name: my-recipe
version: "1.0"
description: A registry recipe
steps:
  - id: projects
    endpoint: "GET /v2/projects"
`
      // First fetch: registry lookup returns recipe detail
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: { name: 'my-recipe', updatedAt: '2026-03-01', yaml: registryRecipeYaml },
        }),
      )
      // Second fetch: API call from executing the recipe step
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: [{ id: 'proj-1', name: 'Bitcoin' }],
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'recipe', 'run', 'my-recipe'],
        { from: 'node' },
      )

      // First call should be the registry fetch
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const registryUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(registryUrl.pathname).toBe('/v2/cli/recipes/my-recipe')

      // Second call should be the recipe step execution
      const stepUrl = new URL(mockFetch.mock.calls[1][0] as string)
      expect(stepUrl.pathname).toBe('/v2/projects')

      // Output should include the execution result
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('complete')
      expect(parsed.data.projects).toBeDefined()
    })

    it('should error with FILE_NOT_FOUND for path-like source that does not exist', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'recipe', 'run', './nonexistent/recipe.yaml'],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('FILE_NOT_FOUND')
    })

    it('should error with FILE_NOT_FOUND for .yml extension that does not exist', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'recipe', 'run', 'missing.yml'],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('FILE_NOT_FOUND')
    })

    it('should treat source with slash as file path, not registry name', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'recipe', 'run', 'recipes/my-recipe'],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('FILE_NOT_FOUND')
      // Should NOT have made any fetch calls (no registry lookup)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // -- recipe info --

  describe('recipe info', () => {
    const SIMPLE_RECIPE_YAML = `
name: test_recipe
version: "1.0"
description: A test recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
  - id: step2
    endpoint: "GET /v2/signals"
`

    const MIXED_STEPS_RECIPE_YAML = `
name: mixed_recipe
version: "2.0"
description: Recipe with mixed step types
params:
  chain:
    type: string
    required: true
    description: Blockchain to query
steps:
  - id: fetch_projects
    endpoint: "GET /v2/projects"
  - id: analyze
    type: agent
    context:
      - fetch_projects
    task: Analyze the project data
    instructions: Use AI to analyze
    returns:
      summary: string
  - id: details
    foreach: "fetch_projects.data"
    endpoint: "GET /v2/projects/{item.id}"
analysis:
  instructions: Summarize findings
`

    it('should output structured JSON for recipe info --json', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'test_recipe',
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: SIMPLE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'info', 'test_recipe'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes/test_recipe')

      const jsonOutput = logs.find(l => l.includes('"name"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)

      expect(parsed.name).toBe('test_recipe')
      expect(parsed.version).toBe('1.0')
      expect(parsed.description).toBe('A test recipe')
      expect(parsed.updatedAt).toBe('2025-06-01T00:00:00Z')
      expect(parsed.params).toEqual({})
      expect(parsed.stepCount).toBe(2)
      expect(parsed.steps).toHaveLength(2)
      expect(parsed.steps[0]).toEqual({ id: 'step1', type: 'api', endpoint: 'GET /v2/projects' })
      expect(parsed.steps[1]).toEqual({ id: 'step2', type: 'api', endpoint: 'GET /v2/signals' })
      expect(parsed.hasAnalysis).toBe(false)
      expect(parsed.yaml).toBe(SIMPLE_RECIPE_YAML)
    })

    it('should display human-readable output for recipe info', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'test_recipe',
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: SIMPLE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'recipe', 'info', 'test_recipe'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('test_recipe')
      expect(allOutput).toContain('1.0')
      expect(allOutput).toContain('A test recipe')
      expect(allOutput).toContain('Steps')
      expect(allOutput).toContain('step1')
      expect(allOutput).toContain('step2')
    })

    it('should map agent and foreach steps correctly in JSON output', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'mixed_recipe',
            updatedAt: '2025-07-01T00:00:00Z',
            yaml: MIXED_STEPS_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'info', 'mixed_recipe'], { from: 'node' })

      const jsonOutput = logs.find(l => l.includes('"name"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)

      expect(parsed.name).toBe('mixed_recipe')
      expect(parsed.version).toBe('2.0')
      expect(parsed.stepCount).toBe(3)
      expect(parsed.hasAnalysis).toBe(true)

      // API step
      expect(parsed.steps[0]).toEqual({ id: 'fetch_projects', type: 'api', endpoint: 'GET /v2/projects' })

      // Agent step
      expect(parsed.steps[1].id).toBe('analyze')
      expect(parsed.steps[1].type).toBe('agent')
      expect(parsed.steps[1].task).toBe('Analyze the project data')
      expect(parsed.steps[1].endpoint).toBeUndefined()

      // Foreach step
      expect(parsed.steps[2].id).toBe('details')
      expect(parsed.steps[2].type).toBe('foreach')
      expect(parsed.steps[2].endpoint).toBe('GET /v2/projects/{item.id}')
      expect(parsed.steps[2].task).toBeUndefined()

      // Params
      expect(parsed.params).toEqual({
        chain: {
          type: 'string',
          required: true,
          description: 'Blockchain to query',
        },
      })
    })

    it('should throw RECIPE_NOT_FOUND error when recipe does not exist', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(404, { error: 'Not found', message: 'Recipe not found' }),
      )

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--format', 'json', 'recipe', 'info', 'nonexistent'], { from: 'node' }),
      ).rejects.toThrow()

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes/nonexistent')
    })
  })

  // -- recipe clone --

  describe('recipe clone', () => {
    const CLONE_RECIPE_YAML = `name: my-recipe
version: "1.0"
description: A cloneable recipe
steps:
  - id: projects
    endpoint: "GET /v2/projects"
`

    it('should clone a recipe and output JSON result with correct file content', async () => {
      const outPath = join(tempDir, 'cloned.yaml')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'my-recipe',
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: CLONE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'recipe', 'clone', 'my-recipe', '--out', outPath],
        { from: 'node' },
      )

      // Verify the registry was called with the correct recipe name
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes/my-recipe')

      // Verify JSON output
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.status).toBe('cloned')
      expect(parsed.name).toBe('my-recipe')
      expect(parsed.path).toBe(outPath)

      // Verify the file was actually written with correct YAML content
      expect(existsSync(outPath)).toBe(true)
      const written = readFileSync(outPath, 'utf-8')
      expect(written).toBe(CLONE_RECIPE_YAML)
    })

    it('should display success message in human mode', async () => {
      const outPath = join(tempDir, 'human-clone.yaml')

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'my-recipe',
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: CLONE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'recipe', 'clone', 'my-recipe', '--out', outPath],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Recipe saved to')
      expect(allOutput).toContain(outPath)
    })

    it('should use custom output path from --out option', async () => {
      const customPath = join(tempDir, 'custom', 'path', 'recipe.yaml')

      // Create the parent directory so writeFileSync works
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(tempDir, 'custom', 'path'), { recursive: true })

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: 'my-recipe',
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: CLONE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'recipe', 'clone', 'my-recipe', '--out', customPath],
        { from: 'node' },
      )

      // Verify the file was written to the custom path
      expect(existsSync(customPath)).toBe(true)

      // Verify JSON output reflects the custom path
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.path).toBe(customPath)
    })

    it('should error when the output file already exists', async () => {
      const outPath = join(tempDir, 'existing.yaml')
      const originalContent = 'original content - should not be overwritten'
      writeFileSync(outPath, originalContent)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'json', 'recipe', 'clone', 'my-recipe', '--out', outPath],
          { from: 'node' },
        ),
      ).rejects.toThrow()

      expect(mockExit).toHaveBeenCalledWith(1)

      // Verify the error JSON output
      const jsonOutput = logs.find(l => l.includes('"error"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.error).toBe('FILE_EXISTS')

      // Verify the file was NOT overwritten
      const content = readFileSync(outPath, 'utf-8')
      expect(content).toBe(originalContent)

      // Verify no fetch was made (file check happens before fetch)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should default output path to ./<name>.yaml', async () => {
      // Use a unique recipe name to avoid collisions with real files
      const recipeName = `test-default-${Date.now()}`
      const expectedPath = `./${recipeName}.yaml`

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: {
            name: recipeName,
            updatedAt: '2025-06-01T00:00:00Z',
            yaml: CLONE_RECIPE_YAML,
          },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'recipe', 'clone', recipeName],
        { from: 'node' },
      )

      // Verify the JSON output shows the default path
      const jsonOutput = logs.find(l => l.includes('"status"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.path).toBe(expectedPath)

      // Clean up the file that was created in cwd
      try {
        rmSync(expectedPath, { force: true })
      } catch {
        // ignore cleanup errors
      }
    })
  })
})
