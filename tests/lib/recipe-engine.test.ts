import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveValue, resolveActionPath, executeRecipe } from '../../src/lib/recipe/engine.js'
import type { ExecutionContext, StepResult } from '../../src/types.js'
import { CliError, PaymentRequiredError } from '../../src/lib/errors.js'
import * as apiClient from '../../src/lib/api-client.js'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock the api-client get and sleep functions to avoid real HTTP calls and delays
vi.mock('../../src/lib/api-client.js', async () => {
  const actual = await vi.importActual('../../src/lib/api-client.js')
  return {
    ...actual,
    get: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  }
})

const mockGet = vi.mocked(apiClient.get)
const mockSleep = vi.mocked(apiClient.sleep)

// -- Test helpers --

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    recipe: { name: 'test', version: '1.0', description: '', steps: [] },
    params: {},
    results: new Map(),
    currentRateLimit: null,
    currentSegmentIndex: 0,
    segments: [],
    agentInput: null,
    resumedFromStep: null,
    ...overrides,
  }
}

function makeStepResult(data: unknown): StepResult {
  return {
    stepId: 'test',
    data,
    rateLimit: null,
    timing: { startedAt: '', completedAt: '', durationMs: 0 },
  }
}

// -- resolveValue --

describe('resolveValue', () => {
  describe('params resolution', () => {
    it('should resolve {params.X} from ctx.params', () => {
      const ctx = makeCtx({ params: { projectId: 'abc123' } })
      const result = resolveValue('{params.projectId}', ctx)
      expect(result).toBe('abc123')
    })

    it('should return undefined for nonexistent param', () => {
      const ctx = makeCtx({ params: {} })
      const result = resolveValue('{params.missing}', ctx)
      expect(result).toBeUndefined()
    })
  })

  describe('step result data', () => {
    it('should return full step result data with {step_id.data}', () => {
      const data = { projects: [{ id: 1 }, { id: 2 }] }
      const ctx = makeCtx()
      ctx.results.set('fetch_projects', makeStepResult(data))

      const result = resolveValue('{fetch_projects.data}', ctx)
      expect(result).toEqual(data)
    })

    it('should return full step result data with bare {step_id}', () => {
      const data = [1, 2, 3]
      const ctx = makeCtx()
      ctx.results.set('my_step', makeStepResult(data))

      const result = resolveValue('{my_step}', ctx)
      expect(result).toEqual(data)
    })

    it('should return undefined for nonexistent step', () => {
      const ctx = makeCtx()
      const result = resolveValue('{no_such_step.data}', ctx)
      expect(result).toBeUndefined()
    })
  })

  describe('nested path resolution', () => {
    it('should resolve {step_id.data.nested.field}', () => {
      const data = { summary: { metrics: { score: 95 } } }
      const ctx = makeCtx()
      ctx.results.set('analysis', makeStepResult(data))

      const result = resolveValue('{analysis.data.summary.metrics.score}', ctx)
      expect(result).toBe(95)
    })

    it('should return undefined for path that does not exist in data', () => {
      const data = { summary: {} }
      const ctx = makeCtx()
      ctx.results.set('analysis', makeStepResult(data))

      const result = resolveValue('{analysis.data.summary.missing.field}', ctx)
      expect(result).toBeUndefined()
    })
  })

  describe('pluck operation', () => {
    it('should collect field from all items with {step_id.data[*].field}', () => {
      const data = [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gamma' },
      ]
      const ctx = makeCtx()
      ctx.results.set('list', makeStepResult(data))

      const result = resolveValue('{list.data[*].id}', ctx)
      expect(result).toEqual(['a', 'b', 'c'])
    })

    it('should return undefined when plucking from non-array data', () => {
      const data = { id: 'a' }
      const ctx = makeCtx()
      ctx.results.set('single', makeStepResult(data))

      const result = resolveValue('{single.data[*].id}', ctx)
      expect(result).toBeUndefined()
    })

    it('should pluck nested fields from array items', () => {
      const data = [
        { info: { score: 10 } },
        { info: { score: 20 } },
      ]
      const ctx = makeCtx()
      ctx.results.set('items', makeStepResult(data))

      const result = resolveValue('{items.data[*].info.score}', ctx)
      expect(result).toEqual([10, 20])
    })
  })

  describe('foreach item resolution', () => {
    it('should return the foreach item with {item}', () => {
      const ctx = makeCtx()
      const foreachItem = { id: 'proj-1', name: 'Project 1' }

      const result = resolveValue('{item}', ctx, foreachItem)
      expect(result).toEqual(foreachItem)
    })

    it('should resolve nested field with {item.field}', () => {
      const ctx = makeCtx()
      const foreachItem = { id: 'proj-1', details: { status: 'active' } }

      const result = resolveValue('{item.details.status}', ctx, foreachItem)
      expect(result).toBe('active')
    })

    it('should return undefined when no foreach item is provided for {item}', () => {
      const ctx = makeCtx()
      const result = resolveValue('{item}', ctx)
      expect(result).toBeUndefined()
    })
  })

  describe('type preservation', () => {
    it('should preserve array type when entire string is a single expression', () => {
      const data = [1, 2, 3]
      const ctx = makeCtx()
      ctx.results.set('numbers', makeStepResult(data))

      const result = resolveValue('{numbers.data}', ctx)
      expect(result).toEqual([1, 2, 3])
      expect(Array.isArray(result)).toBe(true)
    })

    it('should preserve object type when entire string is a single expression', () => {
      const data = { key: 'value', count: 42 }
      const ctx = makeCtx()
      ctx.results.set('obj', makeStepResult(data))

      const result = resolveValue('{obj.data}', ctx)
      expect(result).toEqual({ key: 'value', count: 42 })
      expect(typeof result).toBe('object')
    })

    it('should preserve number type when entire string is a single expression', () => {
      const data = { count: 42 }
      const ctx = makeCtx()
      ctx.results.set('stats', makeStepResult(data))

      const result = resolveValue('{stats.data.count}', ctx)
      expect(result).toBe(42)
      expect(typeof result).toBe('number')
    })
  })

  describe('mixed string interpolation', () => {
    it('should return string when template is embedded in other text', () => {
      const ctx = makeCtx({ params: { count: '5' } })
      const result = resolveValue('Count: {params.count}', ctx)
      expect(result).toBe('Count: 5')
      expect(typeof result).toBe('string')
    })

    it('should interpolate multiple templates in a single string', () => {
      const ctx = makeCtx({ params: { name: 'Alice', role: 'admin' } })
      const result = resolveValue('User {params.name} is {params.role}', ctx)
      expect(result).toBe('User Alice is admin')
    })

    it('should replace missing values with empty string in interpolation', () => {
      const ctx = makeCtx({ params: {} })
      const result = resolveValue('Value: {params.missing}', ctx)
      expect(result).toBe('Value: ')
    })
  })

  describe('non-string value passthrough', () => {
    it('should pass through numbers unchanged', () => {
      const ctx = makeCtx()
      expect(resolveValue(42, ctx)).toBe(42)
    })

    it('should pass through booleans unchanged', () => {
      const ctx = makeCtx()
      expect(resolveValue(true, ctx)).toBe(true)
      expect(resolveValue(false, ctx)).toBe(false)
    })

    it('should pass through null unchanged', () => {
      const ctx = makeCtx()
      expect(resolveValue(null, ctx)).toBeNull()
    })

    it('should pass through undefined unchanged', () => {
      const ctx = makeCtx()
      expect(resolveValue(undefined, ctx)).toBeUndefined()
    })
  })

  describe('array resolution', () => {
    it('should resolve each element in an array recursively', () => {
      const ctx = makeCtx({ params: { a: 'hello', b: 'world' } })
      const result = resolveValue(['{params.a}', '{params.b}', 99], ctx)
      expect(result).toEqual(['hello', 'world', 99])
    })

    it('should handle nested arrays', () => {
      const ctx = makeCtx({ params: { x: 'val' } })
      const result = resolveValue([['{params.x}']], ctx)
      expect(result).toEqual([['val']])
    })
  })

  describe('object resolution', () => {
    it('should resolve each value in an object recursively', () => {
      const ctx = makeCtx({ params: { id: '123' } })
      const result = resolveValue({ projectId: '{params.id}', static: 'no-change' }, ctx)
      expect(result).toEqual({ projectId: '123', static: 'no-change' })
    })

    it('should resolve nested objects', () => {
      const ctx = makeCtx({ params: { val: 'deep' } })
      const result = resolveValue({ outer: { inner: '{params.val}' } }, ctx)
      expect(result).toEqual({ outer: { inner: 'deep' } })
    })
  })

  describe('empty/null step data', () => {
    it('should return null when step data is null', () => {
      const ctx = makeCtx()
      ctx.results.set('empty_step', makeStepResult(null))

      const result = resolveValue('{empty_step.data}', ctx)
      expect(result).toBeNull()
    })

    it('should return undefined for nested path on null step data', () => {
      const ctx = makeCtx()
      ctx.results.set('empty_step', makeStepResult(null))

      const result = resolveValue('{empty_step.data.some.path}', ctx)
      expect(result).toBeUndefined()
    })

    it('should return undefined for pluck on null step data', () => {
      const ctx = makeCtx()
      ctx.results.set('empty_step', makeStepResult(null))

      const result = resolveValue('{empty_step.data[*].field}', ctx)
      expect(result).toBeUndefined()
    })

    it('should handle empty array as step data', () => {
      const ctx = makeCtx()
      ctx.results.set('empty_array', makeStepResult([]))

      const result = resolveValue('{empty_array.data[*].id}', ctx)
      expect(result).toEqual([])
    })
  })

  describe('step reference without data prefix', () => {
    it('should return undefined for non-data step property', () => {
      const ctx = makeCtx()
      ctx.results.set('s1', makeStepResult({ x: 1 }))

      const result = resolveValue('{s1.rateLimit}', ctx)
      expect(result).toBeUndefined()
    })
  })
})

// -- resolveActionPath --

describe('resolveActionPath', () => {
  it('should parse GET method and path', () => {
    const ctx = makeCtx()
    const result = resolveActionPath('GET /v2/projects', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects' })
  })

  it('should parse POST method and path', () => {
    const ctx = makeCtx()
    const result = resolveActionPath('POST /v2/something', ctx)
    expect(result).toEqual({ method: 'POST', path: '/v2/something' })
  })

  it('should default to GET when no method is specified', () => {
    const ctx = makeCtx()
    const result = resolveActionPath('/v2/projects', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects' })
  })

  it('should uppercase the method', () => {
    const ctx = makeCtx()
    const result = resolveActionPath('post /v2/data', ctx)
    expect(result).toEqual({ method: 'POST', path: '/v2/data' })
  })

  it('should resolve templates in the path', () => {
    const ctx = makeCtx()
    const foreachItem = { id: 'proj-42' }
    const result = resolveActionPath('GET /v2/projects/{item.id}/momentum', ctx, foreachItem)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects/proj-42/momentum' })
  })

  it('should resolve param templates in the path', () => {
    const ctx = makeCtx({ params: { slug: 'my-project' } })
    const result = resolveActionPath('GET /v2/projects/{params.slug}', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects/my-project' })
  })
})

// -- resolveRelativeTime integration --
// Unit tests for resolveRelativeTime are in tests/lib/date.test.ts.
// This test verifies the integration: resolveValue triggers relative time resolution.

describe('resolveRelativeTime integration', () => {
  it('should be triggered automatically by resolveValue for relative time strings', () => {
    const ctx = makeCtx()
    const before = Date.now()
    const result = resolveValue('-24h', ctx)

    expect(typeof result).toBe('string')
    const resultMs = new Date(result as string).getTime()
    const expected24hAgo = before - 24 * 60 * 60 * 1000

    expect(resultMs).toBeGreaterThanOrEqual(expected24hAgo - 2000)
    expect(resultMs).toBeLessThanOrEqual(expected24hAgo + 2000)
  })
})

// -- executeRecipe --

// Test YAML recipes

const SIMPLE_RECIPE = `
name: test-recipe
version: "1.0"
description: Simple test
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`

const TWO_STEP_RECIPE = `
name: test-recipe
version: "1.0"
description: Two steps
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
`

const RECIPE_WITH_VARIABLE_REFS = `
name: test-recipe
version: "1.0"
description: Steps with variable references
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
    params:
      projectIds: "{projects.data[*].id}"
`

const AGENT_RECIPE = `
name: test-recipe
version: "1.0"
description: Recipe with agent step
steps:
  - id: surging
    type: api
    action: "GET /v2/projects"
    params:
      momentum: rising
  - id: analyze
    type: agent
    context: [surging]
    instructions: "Analyze surging projects"
    returns:
      projectIds: "string[]"
  - id: deep
    type: api
    action: "GET /v2/signals"
`

const RECIPE_WITH_DEFAULTS = `
name: test-recipe
version: "1.0"
description: Recipe with param defaults
params:
  chain:
    type: string
    default: base
  count:
    type: number
    default: 10
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
    params:
      chain: "{params.chain}"
      limit: "{params.count}"
`

const AGENT_AT_END_RECIPE = `
name: agent-at-end
version: "1.0"
description: Recipe with agent step at the end
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [projects, signals]
    instructions: "Analyze data"
    returns:
      summary: "string"
`

const MULTI_SEGMENT_RECIPE = `
name: multi-segment
version: "1.0"
description: Recipe with two agent steps
steps:
  - id: surging
    type: api
    action: "GET /v2/projects"
  - id: filter
    type: agent
    context: [surging]
    instructions: "Filter projects"
    returns:
      projectIds: "string[]"
  - id: signals
    type: api
    action: "GET /v2/signals"
    params:
      projectIds: "{filter.data.projectIds}"
  - id: analyze
    type: agent
    context: [signals]
    instructions: "Analyze signals"
    returns:
      summary: "string"
  - id: enrichment
    type: api
    action: "GET /v2/projects"
`

const RECIPE_WITH_HINTS_AND_ANALYSIS = `
name: test-recipe
version: "1.0"
description: Recipe with hints and analysis
hints:
  combine: [projects, signals]
  key: projectId
analysis:
  instructions: "Summarize the data"
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
`

function mockApiResponse(data: unknown) {
  return {
    status: 200,
    data,
    rateLimit: null,
    pagination: undefined,
  }
}

describe('executeRecipe', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockSleep.mockClear()
  })

  function mockPaginatedResponse(
    data: unknown[],
    page: number,
    totalCount: number,
    limit: number = 50,
  ) {
    return {
      status: 200,
      data,
      pagination: {
        page,
        limit,
        totalCount,
        hasMore: page * limit < totalCount,
      },
      rateLimit: {
        limitPerMinute: 30,
        remainingPerMinute: Math.max(30 - page, 1),
        resetMinute: new Date(Date.now() + 60000).toISOString(),
        limitPerDay: 1000,
        remainingPerDay: 990,
        resetDay: new Date(Date.now() + 86400000).toISOString(),
      },
    }
  }

  // -- Core execution flow --

  describe('core execution flow', () => {
    it('should execute a simple recipe with one API step and return RecipeComplete', async () => {
      const projectsData = [{ id: 'p1', name: 'Project 1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(result.recipe).toBe('test-recipe')
      expect(result.version).toBe('1.0')
      expect((result as { data: Record<string, unknown> }).data.projects).toEqual(projectsData)
    })

    it('should execute two sequential steps in order', async () => {
      const projectsData = [{ id: 'p1' }]
      const signalsData = [{ id: 's1', projectId: 'p1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: TWO_STEP_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      const data = (result as { data: Record<string, unknown> }).data
      expect(data.projects).toEqual(projectsData)
      expect(data.signals).toEqual(signalsData)
    })

    it('should resolve variable references between steps', async () => {
      const projectsData = [{ id: 'p1' }, { id: 'p2' }]
      const signalsData = [{ id: 's1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: RECIPE_WITH_VARIABLE_REFS,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      // The second call should have resolved {projects.data[*].id} to "p1,p2"
      const secondCallParams = mockGet.mock.calls[1][1]
      expect(secondCallParams).toEqual({ projectIds: 'p1,p2' })
    })

    it('should return RecipeAwaitingAgent when hitting an agent step', async () => {
      const surgingData = [{ id: 'p1', name: 'Surging Project' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        status: string
        step: string
        instructions: string
        returns: Record<string, string>
        data: Record<string, unknown>
        resumeCommand: string
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.instructions).toBeDefined()
      expect(awaiting.instructions).toBe('Analyze surging projects')
      expect(awaiting.returns).toEqual({ projectIds: 'string[]' })
    })

    it('should include correct context data from referenced steps in agent output', async () => {
      const surgingData = [{ id: 'p1', momentum: 95 }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { data: Record<string, unknown> }
      expect(awaiting.data.surging).toEqual(surgingData)
    })
  })

  // -- Resume flow --

  describe('resume flow', () => {
    it('should resume from agent step and execute remaining steps', async () => {
      const surgingData = [{ id: 'p1' }]
      const deepData = [{ id: 's1', signal: 'bullish' }]

      // First run: execute up to agent step
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))
      const firstResult = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })
      expect(firstResult.status).toBe('awaiting_agent')

      // Second run: resume from agent step with agent input
      mockGet.mockReset()
      mockGet.mockResolvedValueOnce(mockApiResponse(deepData))

      const resumeResult = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'analyze',
        resumeInput: { projectIds: ['p1', 'p2'] },
      })

      expect(resumeResult.status).toBe('complete')
      const data = (resumeResult as { data: Record<string, unknown> }).data
      expect(data.deep).toEqual(deepData)
      // The agent input should be injected as the analyze step's result
      expect(data.analyze).toEqual({ projectIds: ['p1', 'p2'] })
    })

    it('should resume correctly with step: prefix', async () => {
      const deepData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(deepData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'step:analyze',
        resumeInput: { projectIds: ['p1'] },
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.deep).toEqual(deepData)
    })

    it('should throw STEP_NOT_FOUND when resuming from nonexistent step', async () => {
      const err = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'nonexistent',
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('STEP_NOT_FOUND')
    })

    it('should throw INVALID_RESUME_STEP when resuming from a non-agent step', async () => {
      const err = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'surging',
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('INVALID_RESUME_STEP')
    })
  })

  // -- Output --

  describe('output', () => {
    it('should include output and analysis from YAML in RecipeComplete', async () => {
      mockGet
        .mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))
        .mockResolvedValueOnce(mockApiResponse([{ id: 's1' }]))

      const result = await executeRecipe({
        yaml: RECIPE_WITH_HINTS_AND_ANALYSIS,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const complete = result as {
        hints?: { combine?: string[]; key?: string }
        analysis?: { instructions: string; output?: string }
      }
      expect(complete.hints).toEqual({
        combine: ['projects', 'signals'],
        key: 'projectId',
      })
      expect(complete.analysis).toEqual({
        instructions: 'Summarize the data',
      })
    })

    it('should include resumeCommand in RecipeAwaitingAgent output', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: { chain: 'base' },
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      expect(awaiting.resumeCommand).toContain('--resume-from step:analyze')
      expect(awaiting.resumeCommand).toContain("--input '<agent_output_json>'")
      expect(awaiting.resumeCommand).toContain("--chain 'base'")
    })

    it('should include recipe name and version in RecipeComplete', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(result.recipe).toBe('test-recipe')
      expect(result.version).toBe('1.0')
    })

    it('should include a timestamp in RecipeComplete', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const complete = result as { timestamp: string }
      expect(complete.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  // -- Output dir --

  describe('outputDir', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'recipe-test-'))
    })

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true })
      }
    })

    it('should write segment files to outputDir when specified', async () => {
      const projectsData = [{ id: 'p1' }]
      const signalsData = [{ id: 's1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const outputDir = join(tempDir, 'output')
      const result = await executeRecipe({
        yaml: TWO_STEP_RECIPE,
        params: {},
        clientOptions: {},
        outputDir,
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data

      // Data should contain file references instead of inline data
      const projectsEntry = data.projects as { dataFile: string }
      const signalsEntry = data.signals as { dataFile: string }
      expect(projectsEntry.dataFile).toContain('segment-001.json')
      expect(signalsEntry.dataFile).toContain('segment-002.json')

      // Files should actually exist with correct content
      const projectsContent = JSON.parse(readFileSync(projectsEntry.dataFile, 'utf-8'))
      expect(projectsContent).toEqual(projectsData)
      const signalsContent = JSON.parse(readFileSync(signalsEntry.dataFile, 'utf-8'))
      expect(signalsContent).toEqual(signalsData)
    })

    it('should create outputDir if it does not exist', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const outputDir = join(tempDir, 'nested', 'dir')
      expect(existsSync(outputDir)).toBe(false)

      await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
        outputDir,
      })

      expect(existsSync(outputDir)).toBe(true)
      expect(existsSync(join(outputDir, 'segment-001.json'))).toBe(true)
    })

    it('should fall back to inline data when outputDir write fails', async () => {
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      // Use a path that can't be created (file as parent)
      const blockingFile = join(tempDir, 'blocker')
      writeFileSync(blockingFile, 'x')
      const outputDir = join(blockingFile, 'subdir')

      const result = await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
        outputDir,
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      // Should have inline data, not file references
      expect(data.projects).toEqual(projectsData)
    })

    it('should return inline data when outputDir is not specified', async () => {
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.projects).toEqual(projectsData)
    })
  })

  // -- Agent step at recipe end --

  describe('agent step at recipe end', () => {
    it('should halt execution at agent step when it is the last step', async () => {
      const projectsData = [{ id: 'p1' }]
      const signalsData = [{ id: 's1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: AGENT_AT_END_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        status: string
        step: string
        instructions: string
        returns: Record<string, string>
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.instructions).toBeDefined()
      expect(awaiting.instructions).toBe('Analyze data')
      expect(awaiting.returns).toEqual({ summary: 'string' })
    })

    it('should include both context step data in yield output', async () => {
      const projectsData = [{ id: 'p1', name: 'Project 1' }]
      const signalsData = [{ id: 's1', signal: 'bullish' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: AGENT_AT_END_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { data: Record<string, unknown> }
      expect(awaiting.data.projects).toEqual(projectsData)
      expect(awaiting.data.signals).toEqual(signalsData)
    })

    it('should not include completion output when agent step is at end', async () => {
      mockGet
        .mockResolvedValueOnce(mockApiResponse([]))
        .mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: AGENT_AT_END_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      // Should not have completion fields
      expect((result as Record<string, unknown>).timestamp).toBeUndefined()
    })
  })

  // -- Multi-segment recipe --

  describe('multi-segment recipe', () => {
    it('should yield at first agent step on initial invocation', async () => {
      const surgingData = [{ id: 'p1' }, { id: 'p2' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        step: string
        instructions: string
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('filter')
      expect(awaiting.instructions).toBeDefined()
      expect(awaiting.data.surging).toEqual(surgingData)
    })

    it('should resume from first agent step and yield at second agent step', async () => {
      const signalsData = [{ id: 's1', signal: 'bullish' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1', 'p2'] },
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        step: string
        instructions: string
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.instructions).toBe('Analyze signals')
      expect(awaiting.data.signals).toEqual(signalsData)
    })

    it('should resume from second agent step and complete recipe', async () => {
      const enrichmentData = [{ id: 'p1', enriched: true }]
      mockGet.mockResolvedValueOnce(mockApiResponse(enrichmentData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'analyze',
        resumeInput: { summary: 'Analysis complete' },
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.enrichment).toEqual(enrichmentData)
      expect(data.analyze).toEqual({ summary: 'Analysis complete' })
    })

    it('should complete full three-invocation flow end-to-end', async () => {
      // Invocation 1: initial run -> yields at filter
      const surgingData = [{ id: 'p1' }, { id: 'p2' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result1 = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
      })
      expect(result1.status).toBe('awaiting_agent')
      expect((result1 as { step: string }).step).toBe('filter')

      // Invocation 2: resume from filter -> yields at analyze
      mockGet.mockReset()
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result2 = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
      })
      expect(result2.status).toBe('awaiting_agent')
      expect((result2 as { step: string }).step).toBe('analyze')

      // Invocation 3: resume from analyze -> completes
      mockGet.mockReset()
      const enrichmentData = [{ id: 'e1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(enrichmentData))

      const result3 = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'analyze',
        resumeInput: { summary: 'Done' },
      })
      expect(result3.status).toBe('complete')
      const data = (result3 as { data: Record<string, unknown> }).data
      expect(data.enrichment).toEqual(enrichmentData)
      expect(data.analyze).toEqual({ summary: 'Done' })
    })
  })

  // -- Input validation --

  describe('input validation', () => {
    it('should throw INVALID_RESUME_INPUT when resuming without --input', async () => {
      try {
        await executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'analyze',
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('INVALID_RESUME_INPUT')
        expect((err as CliError).message).toContain('--input is required')
        expect((err as CliError).message).toContain('analyze')
      }
    })

    it('should throw INVALID_RESUME_INPUT when --input is missing a required field', async () => {
      try {
        await executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'analyze',
          resumeInput: { wrongField: 'value' },
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('INVALID_RESUME_INPUT')
        expect((err as CliError).message).toContain('projectIds')
      }
    })

    it('should throw INVALID_RESUME_INPUT when array field is not an array', async () => {
      try {
        await executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'analyze',
          resumeInput: { projectIds: 'not-an-array' },
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('INVALID_RESUME_INPUT')
        expect((err as CliError).message).toContain('projectIds')
        expect((err as CliError).message).toContain('array')
      }
    })

    it('should pass validation when --input has correct fields and types', async () => {
      const deepData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(deepData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'analyze',
        resumeInput: { projectIds: ['p1', 'p2'] },
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.analyze).toEqual({ projectIds: ['p1', 'p2'] })
    })
  })

  // -- Resume command format --

  describe('resume command format', () => {
    it('should include file path in resumeCommand when recipeSource is provided', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
        recipeSource: 'recipes/my-recipe.yaml',
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      expect(awaiting.resumeCommand).toContain('recipes/my-recipe.yaml')
      expect(awaiting.resumeCommand).not.toContain('--stdin')
    })

    it('should include --stdin in resumeCommand when no recipeSource is provided', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      expect(awaiting.resumeCommand).toContain('--stdin')
    })

    it('should use --resume-from flag in resumeCommand', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      expect(awaiting.resumeCommand).toContain('--resume-from step:analyze')
      // Should not use the old --resume format
      expect(awaiting.resumeCommand).not.toMatch(/--resume\s+step:/)
    })

    it('should include --input placeholder in resumeCommand', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      expect(awaiting.resumeCommand).toContain("--input '<agent_output_json>'")
    })

    it('should shell-escape param values with special characters', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: { query: "price > 100 && name = 'test'" },
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { resumeCommand: string }
      // Single quotes in the value should be escaped with '\''
      expect(awaiting.resumeCommand).toContain("--query 'price > 100 && name = '\\''test'\\'''")
    })
  })

  // -- Defaults --

  describe('param defaults', () => {
    it('should apply default values when params are not provided by user', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      await executeRecipe({
        yaml: RECIPE_WITH_DEFAULTS,
        params: {},
        clientOptions: {},
      })

      expect(mockGet).toHaveBeenCalledTimes(1)
      const callParams = mockGet.mock.calls[0][1]
      expect(callParams).toEqual({
        chain: 'base',
        limit: '10',
      })
    })

    it('should let user-provided params override defaults', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      await executeRecipe({
        yaml: RECIPE_WITH_DEFAULTS,
        params: { chain: 'ethereum', count: '5' },
        clientOptions: {},
      })

      expect(mockGet).toHaveBeenCalledTimes(1)
      const callParams = mockGet.mock.calls[0][1]
      expect(callParams).toEqual({
        chain: 'ethereum',
        limit: '5',
      })
    })

    it('should partially override defaults when some params are provided', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      await executeRecipe({
        yaml: RECIPE_WITH_DEFAULTS,
        params: { chain: 'solana' },
        clientOptions: {},
      })

      expect(mockGet).toHaveBeenCalledTimes(1)
      const callParams = mockGet.mock.calls[0][1]
      expect(callParams).toEqual({
        chain: 'solana',
        limit: '10',
      })
    })
  })

  // -- API call verification --

  describe('API call behavior', () => {
    it('should call get with the correct action path', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(mockGet).toHaveBeenCalledTimes(1)
      expect(mockGet.mock.calls[0][0]).toBe('/v2/projects')
    })

    it('should pass clientOptions through to the get function', async () => {
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const clientOptions = { apiKey: 'test-key', apiUrl: 'https://api.test.com' }
      await executeRecipe({
        yaml: SIMPLE_RECIPE,
        params: {},
        clientOptions,
      })

      expect(mockGet.mock.calls[0][2]).toBe(clientOptions)
    })

    it('should resolve step params with undefined values removed', async () => {
      const recipeWithOptionalParam = `
name: test-recipe
version: "1.0"
description: Test
params:
  chain:
    type: string
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
    params:
      chain: "{params.chain}"
      limit: "20"
`
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      await executeRecipe({
        yaml: recipeWithOptionalParam,
        params: {},
        clientOptions: {},
      })

      const callParams = mockGet.mock.calls[0][1]
      // chain should resolve to undefined since params.chain is not provided and has no default
      expect(callParams).toEqual({
        chain: undefined,
        limit: '20',
      })
    })
  })

  // -- Foreach execution --

  describe('foreach execution', () => {
    const FOREACH_RECIPE = `
name: foreach-test
version: "1.0"
description: Foreach test recipe
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: momentum
    type: api
    for: projects.data
    action: "GET /v2/projects/{item.id}/momentum"
`

    const FOREACH_PARAMS_RECIPE = `
name: foreach-params-test
version: "1.0"
description: Foreach with params test
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: details
    type: api
    for: projects.data
    action: "GET /v2/projects/{item.id}"
    params:
      chain: "{item.chain}"
`

    it('should iterate over array from prior step and call get for each item', async () => {
      const projectsData = [
        { id: 'p1' },
        { id: 'p2' },
        { id: 'p3' },
      ]

      // Step 1: projects list
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      // Foreach iterations
      mockGet.mockResolvedValueOnce(mockApiResponse({ momentum: 85 }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ momentum: 72 }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ momentum: 91 }))

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      // 1 for projects + 3 for foreach items
      expect(mockGet).toHaveBeenCalledTimes(4)

      // Verify foreach calls used correct paths with item.id resolved
      expect(mockGet.mock.calls[1][0]).toBe('/v2/projects/p1/momentum')
      expect(mockGet.mock.calls[2][0]).toBe('/v2/projects/p2/momentum')
      expect(mockGet.mock.calls[3][0]).toBe('/v2/projects/p3/momentum')
    })

    it('should return empty items and no failures when source array is empty', async () => {
      // Step 1: projects returns empty array
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      // Only 1 call for the projects step, no foreach iterations
      expect(mockGet).toHaveBeenCalledTimes(1)

      const data = (result as { data: Record<string, unknown> }).data
      // The foreach step data should be an empty array
      expect(data.momentum).toEqual([])
    })

    it('should collect successes and failures when some items fail', async () => {
      const projectsData = [
        { id: 'p1' },
        { id: 'p2' },
        { id: 'p3' },
      ]

      // Step 1: projects list
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      // Foreach: first succeeds, second fails, third succeeds
      mockGet.mockResolvedValueOnce(mockApiResponse({ ok: true }))
      mockGet.mockRejectedValueOnce(new Error('API error for item 2'))
      mockGet.mockResolvedValueOnce(mockApiResponse({ ok: true }))

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(4)

      const data = (result as { data: Record<string, unknown> }).data
      const foreachData = data.momentum as unknown[]

      // 3 items in data: 2 successes + 1 error marker (inline)
      expect(foreachData).toHaveLength(3)
      expect(foreachData[0]).toEqual({ ok: true, _source_id: 'p1' })
      expect(foreachData[1]).toEqual(expect.objectContaining({ _error: true, error: 'API error for item 2' }))
      expect(foreachData[2]).toEqual({ ok: true, _source_id: 'p3' })
    })

    it('should resolve params per-item using item templating', async () => {
      const projectsData = [
        { id: 'proj-1', chain: 'base' },
        { id: 'proj-2', chain: 'eth' },
      ]

      // Step 1: projects list
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      // Foreach iterations
      mockGet.mockResolvedValueOnce(mockApiResponse({ detail: 'one' }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ detail: 'two' }))

      const result = await executeRecipe({
        yaml: FOREACH_PARAMS_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(3)

      // Verify paths resolved with item.id
      expect(mockGet.mock.calls[1][0]).toBe('/v2/projects/proj-1')
      expect(mockGet.mock.calls[2][0]).toBe('/v2/projects/proj-2')

      // Verify params resolved with item.chain
      expect(mockGet.mock.calls[1][1]).toEqual({ chain: 'base' })
      expect(mockGet.mock.calls[2][1]).toEqual({ chain: 'eth' })
    })

    it('should produce ForeachResult with expected structure in step results', async () => {
      const projectsData = [{ id: 'p1' }, { id: 'p2' }]

      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      mockGet.mockResolvedValueOnce({
        status: 200,
        data: { score: 10 },
        rateLimit: { remainingPerMinute: 50, resetMinute: new Date().toISOString() },
        pagination: undefined,
      })
      mockGet.mockResolvedValueOnce({
        status: 200,
        data: { score: 20 },
        rateLimit: { remainingPerMinute: 49, resetMinute: new Date().toISOString() },
        pagination: undefined,
      })

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data

      // The foreach step data should be an array of the successful results
      const momentumData = data.momentum as unknown[]
      expect(momentumData).toEqual([{ score: 10, _source_id: 'p1' }, { score: 20, _source_id: 'p2' }])
    })

    it('should process all items even with low rate limit concurrency', async () => {
      const projectsData = [
        { id: 'p1' },
        { id: 'p2' },
        { id: 'p3' },
      ]

      // Step 1: projects list (returns rate limit with low remaining)
      mockGet.mockResolvedValueOnce({
        status: 200,
        data: projectsData,
        rateLimit: { remainingPerMinute: 3, resetMinute: new Date().toISOString() },
        pagination: undefined,
      })
      // Foreach iterations — all should still succeed
      mockGet.mockResolvedValueOnce(mockApiResponse({ m: 1 }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ m: 2 }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ m: 3 }))

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      // All 4 calls should have been made (1 projects + 3 foreach)
      expect(mockGet).toHaveBeenCalledTimes(4)

      const data = (result as { data: Record<string, unknown> }).data
      const momentumData = data.momentum as unknown[]
      expect(momentumData).toHaveLength(3)
      expect(momentumData).toEqual([{ m: 1, _source_id: 'p1' }, { m: 2, _source_id: 'p2' }, { m: 3, _source_id: 'p3' }])
    })

    it('should throw FOREACH_ALL_FAILED when all items fail', async () => {
      const projectsData = [
        { id: 'fail-item', name: 'Failing' },
      ]

      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      mockGet.mockRejectedValueOnce(new Error('Not Found'))

      const err = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('FOREACH_ALL_FAILED')
      expect((err as CliError).message).toContain('momentum')
      expect((err as CliError).message).toContain('Not Found')
    })

    it('should throw FOREACH_SOURCE_NOT_ARRAY when source is not an array', async () => {
      // projects step returns an object instead of an array
      mockGet.mockResolvedValueOnce(mockApiResponse({ count: 5 }))

      const err = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('FOREACH_SOURCE_NOT_ARRAY')
      expect((err as CliError).message).toContain('momentum')
      expect((err as CliError).message).toContain('expected array')
    })

    it('should throw FOREACH_SOURCE_MISSING when source resolves to null', async () => {
      // projects step returns null data, so foreach source resolves to null
      mockGet.mockResolvedValueOnce(mockApiResponse(null))

      const err = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('FOREACH_SOURCE_MISSING')
    })
  })

  // -- Required params validation --

  describe('required params validation', () => {
    it('should execute successfully when required param is provided', async () => {
      const recipe = `
name: test-recipe
version: "1.0"
description: Required param test
params:
  chain:
    type: string
    required: true
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: recipe,
        params: { chain: 'base' },
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
    })

    it('should throw CliError with MISSING_PARAMS when required param is missing', async () => {
      const recipe = `
name: test-recipe
version: "1.0"
description: Required param test
params:
  chain:
    type: string
    required: true
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      try {
        await executeRecipe({
          yaml: recipe,
          params: {},
          clientOptions: {},
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('MISSING_PARAMS')
        expect((err as CliError).message).toContain('chain')
      }
    })

    it('should not throw when required param has a default and is not provided', async () => {
      const recipe = `
name: test-recipe
version: "1.0"
description: Required with default
params:
  chain:
    type: string
    required: true
    default: base
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: recipe,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
    })

    it('should report only the missing required param when multiple required params exist', async () => {
      const recipe = `
name: test-recipe
version: "1.0"
description: Multiple required params
params:
  chain:
    type: string
    required: true
  count:
    type: number
    required: true
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      try {
        await executeRecipe({
          yaml: recipe,
          params: { chain: 'base' },
          clientOptions: {},
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('MISSING_PARAMS')
        expect((err as CliError).message).toContain('count')
        expect((err as CliError).message).not.toContain('chain')
      }
    })

    it('should not throw when optional param is not provided', async () => {
      const recipe = `
name: test-recipe
version: "1.0"
description: Optional param test
params:
  chain:
    type: string
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`
      mockGet.mockResolvedValueOnce(mockApiResponse([]))

      const result = await executeRecipe({
        yaml: recipe,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
    })
  })

  // -- Inline transform on API step execution --
  // Note: standalone TransformStep (with input:) was eliminated in the step type redesign.
  // Transforms are now only inline modifiers on API steps.

  // -- Per-iteration transforms on foreach --

  describe('foreach with transforms', () => {
    const FOREACH_WITH_SELECT_RECIPE = `
name: foreach-select
version: "1.0"
description: Foreach with per-iteration select
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: details
    type: api
    for: projects.data
    action: "GET /v2/projects/{item.id}"
    transform:
      select: [id, status]
`

    const FOREACH_WITH_SAMPLE_RECIPE = `
name: foreach-sample
version: "1.0"
description: Foreach with per-iteration sample
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    for: projects.data
    action: "GET /v2/projects/{item.id}/signals"
    transform:
      sample:
        count: 2
`

    it('should apply select transform to each foreach iteration response', async () => {
      const projectsData = [{ id: 'p1' }, { id: 'p2' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      // Each foreach iteration returns an object with extra fields
      mockGet.mockResolvedValueOnce(mockApiResponse({ id: 'p1', status: 'active', secret: 'x' }))
      mockGet.mockResolvedValueOnce(mockApiResponse({ id: 'p2', status: 'inactive', secret: 'y' }))

      const result = await executeRecipe({
        yaml: FOREACH_WITH_SELECT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      const details = data.details as Record<string, unknown>[]
      expect(details).toHaveLength(2)
      // Each iteration result should be projected to only id and status
      expect(details[0]).toEqual({ id: 'p1', status: 'active', _source_id: 'p1' })
      expect(details[1]).toEqual({ id: 'p2', status: 'inactive', _source_id: 'p2' })
    })

    it('should apply sample transform to array responses in foreach iterations', async () => {
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      // The foreach iteration returns an array of signals
      const signalsResponse = [
        { id: 's1', score: 10 },
        { id: 's2', score: 20 },
        { id: 's3', score: 30 },
        { id: 's4', score: 40 },
        { id: 's5', score: 50 },
      ]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsResponse))

      const result = await executeRecipe({
        yaml: FOREACH_WITH_SAMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as unknown[][]
      // The single iteration should have its array sampled to 2 items
      expect(signals).toHaveLength(1)
      expect(signals[0]).toHaveLength(2)
    })
  })

  // -- Auto-pagination --

  describe('auto-pagination', () => {
    function makeItems(count: number, prefix = 'item') {
      return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, name: `${prefix} ${i + 1}` }))
    }

    it('should trigger multi-page fetch when limit exceeds 50', async () => {
      // Note: MAX_TOTAL_LIMIT is 100, so a requested limit of 150 is capped to 100 (2 pages of 50)
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 150
`
      const page1 = makeItems(50, 'sig')
      const page2 = makeItems(50, 'sig2')

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1, 1, 100))
        .mockResolvedValueOnce(mockPaginatedResponse(page2, 2, 100))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      // Verify page params for each call
      expect(mockGet.mock.calls[0][1]).toMatchObject({ page: 1, limit: 50 })
      expect(mockGet.mock.calls[1][1]).toMatchObject({ page: 2, limit: 50 })

      // Verify concatenated result (capped at 100 by MAX_TOTAL_LIMIT)
      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as unknown[]
      expect(signals).toHaveLength(100)
    })

    it('should not paginate when limit is 50 or below', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 50
`
      mockGet.mockResolvedValueOnce(mockApiResponse(makeItems(50)))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(1)

      // Should not have page param injected (YAML parses limit: 50 as number)
      const callParams = mockGet.mock.calls[0][1]
      expect(callParams).toEqual({ limit: 50 })
    })

    it('should not paginate when limit is absent', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
`
      mockGet.mockResolvedValueOnce(mockApiResponse(makeItems(10)))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(1)
    })

    it('should stop early when hasMore is false', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 150
`
      const page1 = makeItems(50, 'sig')
      const page2 = makeItems(30, 'sig2')

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1, 1, 80))
        .mockResolvedValueOnce(mockPaginatedResponse(page2, 2, 80))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as unknown[]
      expect(signals).toHaveLength(80)
    })

    it('should apply transforms after pagination combines all pages', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 100
    transform:
      select: [id, name]
`
      const page1 = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `Signal ${i}`, extra: 'drop-me' }))
      const page2 = Array.from({ length: 50 }, (_, i) => ({ id: `s${50 + i}`, name: `Signal ${50 + i}`, extra: 'drop-me' }))

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1, 1, 100))
        .mockResolvedValueOnce(mockPaginatedResponse(page2, 2, 100))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as Record<string, unknown>[]
      expect(signals).toHaveLength(100)

      // Verify transform was applied -- each item should only have id and name
      for (const signal of signals) {
        expect(Object.keys(signal).sort()).toEqual(['id', 'name'])
        expect(signal.extra).toBeUndefined()
      }
    })

    it('should include step ID and page number in pagination error', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 100
`
      const page1 = makeItems(50, 'sig')

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1, 1, 100))
        .mockRejectedValueOnce(new Error('Server error'))

      try {
        await executeRecipe({
          yaml,
          params: {},
          clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
        })
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('PAGINATION_FAILED')
        expect((err as CliError).message).toContain('signals')
        expect((err as CliError).message).toContain('page 2')
      }
    })

    it('should preserve CliError subclass type when API step fails', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
`
      mockGet.mockRejectedValueOnce(new PaymentRequiredError({ detail: 'pay up' }))

      const err = await executeRecipe({
        yaml,
        params: {},
        clientOptions: {},
      }).catch((e: unknown) => e)

      // Must still be a PaymentRequiredError, not wrapped in generic CliError
      expect(err).toBeInstanceOf(PaymentRequiredError)
      expect((err as CliError).message).toContain('signals')
    })

    it('should wrap non-CliError failures with STEP_EXECUTION_FAILED', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
`
      mockGet.mockRejectedValueOnce(new TypeError('fetch failed'))

      const err = await executeRecipe({
        yaml,
        params: {},
        clientOptions: {},
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect(err).not.toBeInstanceOf(PaymentRequiredError)
      expect((err as CliError).code).toBe('STEP_EXECUTION_FAILED')
      expect((err as CliError).message).toContain('signals')
      expect((err as CliError).message).toContain('fetch failed')
    })

    it('should pause for rate limit when remainingPerMinute is low between pages', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 100
`
      const page1 = makeItems(50, 'sig')
      const page2 = makeItems(50, 'sig2')

      // Page 1 returns with very low remaining rate limit
      const page1Response = {
        status: 200,
        data: page1,
        pagination: {
          page: 1,
          limit: 50,
          totalCount: 100,
          hasMore: true,
        },
        rateLimit: {
          limitPerMinute: 30,
          remainingPerMinute: 1,
          resetMinute: new Date(Date.now() + 60000).toISOString(),
          limitPerDay: 1000,
          remainingPerDay: 990,
          resetDay: new Date(Date.now() + 86400000).toISOString(),
        },
      }

      mockGet
        .mockResolvedValueOnce(page1Response)
        .mockResolvedValueOnce(mockPaginatedResponse(page2, 2, 100))

      mockSleep.mockClear()

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockSleep).toHaveBeenCalled()

      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as unknown[]
      expect(signals).toHaveLength(100)
    })

    it('should request only remaining items on the last page', async () => {
      const yaml = `
name: test-recipe
version: "1.0"
description: test
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 80
`
      const page1 = makeItems(50, 'sig')
      const page2 = makeItems(30, 'sig2')

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1, 1, 80))
        .mockResolvedValueOnce(mockPaginatedResponse(page2, 2, 80))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      expect(result.status).toBe('complete')
      expect(mockGet).toHaveBeenCalledTimes(2)

      // Page 1 should request 50 (full page)
      expect(mockGet.mock.calls[0][1]).toMatchObject({ page: 1, limit: 50 })
      // Page 2 should request only 30 (remaining = 80 - 50)
      expect(mockGet.mock.calls[1][1]).toMatchObject({ page: 2, limit: 30 })

      const data = (result as { data: Record<string, unknown> }).data
      const signals = data.signals as unknown[]
      expect(signals).toHaveLength(80)
    })
  })

  // -- API step with transforms --

  describe('API step with transforms', () => {
    const API_WITH_SELECT_RECIPE = `
name: api-select
version: "1.0"
description: API step with select transform
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
    transform:
      select: [id, name]
`

    const API_WITH_SAMPLE_RECIPE = `
name: api-sample
version: "1.0"
description: API step with sample transform
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
    transform:
      sample:
        count: 2
`

    it('should apply select transform on API step response data', async () => {
      const projectsData = [
        { id: 'p1', name: 'Alpha', extra: 'x' },
        { id: 'p2', name: 'Beta', extra: 'y' },
      ]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: API_WITH_SELECT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.projects).toEqual([
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', name: 'Beta' },
      ])
    })

    it('should apply sample transform on API step response data', async () => {
      const projectsData = Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
      }))
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: API_WITH_SAMPLE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      const projects = data.projects as unknown[]
      expect(projects).toHaveLength(2)
    })
  })

  // -- End-to-end: pagination + transforms --

  describe('end-to-end: pagination + transforms', () => {
    const makeSignal = (i: number) => ({
      id: `sig-${i}`,
      name: `Signal ${i}`,
      category: i % 2 === 0 ? 'social' : 'technical',
      description: `Long description for signal ${i}`,
      activity: [{ date: new Date().toISOString(), source: 'twitter' }],
      metrics: { usd: Math.random() * 100, volume: Math.random() * 1000 },
    })

    it('should paginate API call then apply inline sample + select transform', async () => {
      const PIPELINE_RECIPE = `
name: signal-analysis
version: "1.0"
description: Paginate, sample, and project signals
steps:
  - id: signals
    type: api
    action: /v2/signals
    params:
      limit: 100
      since: -24h
    transform:
      sample:
        count: 20
      select: [id, name, category]
`

      const page1Data = Array.from({ length: 50 }, (_, i) => makeSignal(i + 1))
      const page2Data = Array.from({ length: 50 }, (_, i) => makeSignal(i + 51))

      mockGet
        .mockResolvedValueOnce(mockPaginatedResponse(page1Data, 1, 100))
        .mockResolvedValueOnce(mockPaginatedResponse(page2Data, 2, 100))

      const result = await executeRecipe({
        yaml: PIPELINE_RECIPE,
        params: {},
        clientOptions: { apiKey: 'test', apiUrl: 'http://test' },
      })

      // Pagination: exactly 2 API calls
      expect(mockGet).toHaveBeenCalledTimes(2)

      // First call: page 1 with limit 50
      expect(mockGet.mock.calls[0][1]).toMatchObject({ page: 1, limit: 50 })

      // Second call: page 2 with limit 50
      expect(mockGet.mock.calls[1][1]).toMatchObject({ page: 2, limit: 50 })

      // Recipe completed successfully
      expect(result.status).toBe('complete')

      const data = (result as { data: Record<string, unknown> }).data

      // The signals step has been sampled down to exactly 20 items and projected
      const signals = data.signals as Record<string, unknown>[]
      expect(signals).toHaveLength(20)

      // Select projection: each item has ONLY id, name, category
      for (const item of signals) {
        const keys = Object.keys(item).sort()
        expect(keys).toEqual(['category', 'id', 'name'])

        // Verify stripped fields are absent
        expect(item).not.toHaveProperty('description')
        expect(item).not.toHaveProperty('activity')
        expect(item).not.toHaveProperty('metrics')
      }
    })
  })

  // -- Yield progress (progress & remaining fields) --

  describe('yield progress', () => {
    it('should include progress object with correct fields in awaiting_agent output', async () => {
      const surgingData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        progress: {
          stepsCompleted: number
          stepsTotal: number
          segmentIndex: number
          segmentsTotal: number
        }
      }
      expect(awaiting.progress).toBeDefined()
      expect(typeof awaiting.progress.stepsCompleted).toBe('number')
      expect(typeof awaiting.progress.stepsTotal).toBe('number')
      expect(typeof awaiting.progress.segmentIndex).toBe('number')
      expect(typeof awaiting.progress.segmentsTotal).toBe('number')
    })

    it('should not count the current agent step in stepsCompleted', async () => {
      // AGENT_RECIPE: surging(api) -> analyze(agent) -> deep(api)
      // At yield for analyze: only surging is completed, analyze is NOT completed yet
      const surgingData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        progress: { stepsCompleted: number; stepsTotal: number }
      }
      // Only surging is in ctx.results at yield time, not analyze
      expect(awaiting.progress.stepsCompleted).toBe(1)
      expect(awaiting.progress.stepsTotal).toBe(3)
    })

    it('should report correct progress for first yield in a 5-step recipe', async () => {
      // MULTI_SEGMENT_RECIPE: surging(api) -> filter(agent) -> signals(api) -> analyze(agent) -> enrichment(api)
      // Segments: [surging, filter] | [signals, analyze] | [enrichment]
      // First yield at filter: stepsCompleted=1 (surging), stepsTotal=5, segmentIndex=0, segmentsTotal=3
      const surgingData = [{ id: 'p1' }, { id: 'p2' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        step: string
        progress: {
          stepsCompleted: number
          stepsTotal: number
          segmentIndex: number
          segmentsTotal: number
        }
      }
      expect(awaiting.step).toBe('filter')
      expect(awaiting.progress.stepsCompleted).toBe(1)
      expect(awaiting.progress.stepsTotal).toBe(5)
      expect(awaiting.progress.segmentIndex).toBe(0)
      expect(awaiting.progress.segmentsTotal).toBe(3)
    })

    it('should include remaining string with step count info for mid-recipe yields', async () => {
      // AGENT_RECIPE: surging(api) -> analyze(agent) -> deep(api)
      // At yield for analyze: remaining segments contain deep (1 API step)
      const surgingData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { remaining: string }
      expect(typeof awaiting.remaining).toBe('string')
      // Should mention step count info
      expect(awaiting.remaining).toContain('1 API step')
      // Should mention the recipe description
      expect(awaiting.remaining).toContain('Recipe with agent step')
    })

    it('should include remaining string with both API and agent step counts for multi-segment recipes', async () => {
      // MULTI_SEGMENT_RECIPE: surging(api) -> filter(agent) -> signals(api) -> analyze(agent) -> enrichment(api)
      // At first yield (filter): remaining has signals(api), analyze(agent), enrichment(api)
      // = 2 API steps and 1 agent step
      const surgingData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(surgingData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { remaining: string }
      expect(awaiting.remaining).toContain('2 API steps')
      expect(awaiting.remaining).toContain('1 agent step')
    })

    it('should report remaining steps at second yield of multi-segment recipe', async () => {
      // MULTI_SEGMENT_RECIPE resumed from filter -> yields at analyze
      // Remaining segments after analyze contain [enrichment] = 1 API step
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1', 'p2'] },
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { step: string; remaining: string }
      expect(awaiting.step).toBe('analyze')
      // After segment 1 (analyze), remaining segments contain [enrichment]
      // That's 1 API step
      expect(awaiting.remaining).toContain('1 API step')
      expect(awaiting.remaining).toContain('enrichment')
    })

    it('should increment segmentIndex for second agent yield in multi-segment recipe', async () => {
      // Resume from filter -> yields at analyze in segment 1
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: MULTI_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1', 'p2'] },
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as {
        step: string
        progress: {
          stepsCompleted: number
          stepsTotal: number
          segmentIndex: number
          segmentsTotal: number
        }
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.progress.segmentIndex).toBe(1)
      expect(awaiting.progress.segmentsTotal).toBe(3)
      // filter (injected) + signals (executed) = 2 steps completed
      expect(awaiting.progress.stepsCompleted).toBe(2)
      expect(awaiting.progress.stepsTotal).toBe(5)
    })

    it('should include remaining string in agent-at-end recipe', async () => {
      const projectsData = [{ id: 'p1' }]
      const signalsData = [{ id: 's1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: AGENT_AT_END_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { remaining: string; progress: { stepsCompleted: number } }
      expect(typeof awaiting.remaining).toBe('string')
      expect(awaiting.remaining.length).toBeGreaterThan(0)
      // 2 API steps completed (projects, signals), agent step not counted
      expect(awaiting.progress.stepsCompleted).toBe(2)
    })
  })

  // -- Carry-forward computation (Task 3.5) --

  describe('carry-forward computation', () => {
    const CF_SINGLE_SEGMENT_RECIPE = `
name: cf-single
version: "1.0"
description: Single agent step, no downstream consumers
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: analyze
    type: agent
    context: [projects]
    instructions: "Analyze projects"
    returns:
      summary: "string"
`

    const CF_ANALYSIS_CONTEXT_RECIPE = `
name: cf-analysis-context
version: "1.0"
description: Agent step with analysis.context referencing pre-yield step
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [projects, signals]
    instructions: "Analyze"
    returns:
      summary: "string"
  - id: enrichment
    type: api
    action: "GET /v2/projects"
analysis:
  instructions: "Final analysis"
  context: [projects, signals]
`

    const CF_DOWNSTREAM_AGENT_RECIPE = `
name: cf-downstream-agent
version: "1.0"
description: Two agent steps with analysis.context referencing pre-first-yield step
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: filter
    type: agent
    context: [projects]
    instructions: "Filter"
    returns:
      projectIds: "string[]"
  - id: signals
    type: api
    action: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [filter, signals]
    instructions: "Analyze"
    returns:
      summary: "string"
  - id: deep
    type: api
    action: "GET /v2/signals"
analysis:
  instructions: "Final analysis"
  context: [projects, signals]
`

    const CF_NO_ANALYSIS_CONTEXT_RECIPE = `
name: cf-no-context
version: "1.0"
description: Agent step at end, analysis without context
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: signals
    type: api
    action: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [projects, signals]
    instructions: "Analyze"
    returns:
      summary: "string"
analysis:
  instructions: "Final analysis"
`

    const CF_MULTI_ACCUMULATION_RECIPE = `
name: cf-multi-accumulation
version: "1.0"
description: Multiple agent steps, carry-forward accumulates across yields
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: filter
    type: agent
    context: [projects]
    instructions: "Filter"
    returns:
      projectIds: "string[]"
  - id: signals
    type: api
    action: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [signals]
    instructions: "Analyze"
    returns:
      summary: "string"
  - id: deep
    type: api
    action: "GET /v2/signals"
analysis:
  instructions: "Final analysis"
  context: [projects, signals]
`

    it('should return empty carryForward for single-segment recipe with no downstream consumers', async () => {
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: CF_SINGLE_SEGMENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { carryForward?: Record<string, unknown> }
      // No downstream agent steps and no analysis.context => carryForward omitted
      expect(awaiting.carryForward).toBeUndefined()
    })

    it('should carry forward pre-yield steps referenced by analysis.context', async () => {
      const projectsData = [{ id: 'p1', name: 'Project 1' }]
      const signalsData = [{ id: 's1', signal: 'bullish' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: CF_ANALYSIS_CONTEXT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { carryForward?: Record<string, unknown> }
      expect(awaiting.carryForward).toBeDefined()
      expect(awaiting.carryForward!.projects).toEqual(projectsData)
      expect(awaiting.carryForward!.signals).toEqual(signalsData)
    })

    it('should carry forward steps referenced by analysis.context at first yield', async () => {
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: CF_DOWNSTREAM_AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting.step).toBe('filter')
      // 'projects' is referenced by analysis.context and exists in results
      expect(awaiting.carryForward).toBeDefined()
      expect(awaiting.carryForward!.projects).toEqual(projectsData)
      // 'signals' is referenced by analysis.context but does not exist yet (post-yield)
      expect(awaiting.carryForward!.signals).toBeUndefined()
    })

    it('should omit carryForward when no analysis.context and no downstream agent references pre-yield steps', async () => {
      const projectsData = [{ id: 'p1' }]
      const signalsData = [{ id: 's1' }]

      mockGet
        .mockResolvedValueOnce(mockApiResponse(projectsData))
        .mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: CF_NO_ANALYSIS_CONTEXT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { carryForward?: Record<string, unknown> }
      // analyze is at end, no downstream agent steps, analysis has no context
      expect(awaiting.carryForward).toBeUndefined()
    })

    it('should accumulate carry-forward across multiple yields', async () => {
      // First yield: at 'filter' step
      const projectsData = [{ id: 'p1', name: 'Alpha' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result1 = await executeRecipe({
        yaml: CF_MULTI_ACCUMULATION_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result1.status).toBe('awaiting_agent')
      const awaiting1 = result1 as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting1.step).toBe('filter')
      // projects is referenced by analysis.context, exists in results
      expect(awaiting1.carryForward).toBeDefined()
      expect(awaiting1.carryForward!.projects).toEqual(projectsData)
      // signals does not exist yet
      expect(awaiting1.carryForward!.signals).toBeUndefined()

      // Second yield: resume from filter, yield at analyze
      mockGet.mockReset()
      const signalsData = [{ id: 's1', signal: 'rising' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result2 = await executeRecipe({
        yaml: CF_MULTI_ACCUMULATION_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        carryForward: awaiting1.carryForward,
      })

      expect(result2.status).toBe('awaiting_agent')
      const awaiting2 = result2 as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting2.step).toBe('analyze')
      // Both projects (restored from carry-forward) and signals (just computed) are now needed by analysis.context
      expect(awaiting2.carryForward).toBeDefined()
      expect(awaiting2.carryForward!.projects).toEqual(projectsData)
      expect(awaiting2.carryForward!.signals).toEqual(signalsData)
    })

    it('should not include steps that have no result in ctx.results', async () => {
      // CF_DOWNSTREAM_AGENT_RECIPE has analysis.context: [projects, signals]
      // At first yield (filter), only 'projects' has a result; 'signals' does not
      const projectsData = [{ id: 'p1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result = await executeRecipe({
        yaml: CF_DOWNSTREAM_AGENT_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { carryForward?: Record<string, unknown> }
      // Only projects should be in carry-forward, signals has no result yet
      const cfKeys = Object.keys(awaiting.carryForward ?? {})
      expect(cfKeys).toContain('projects')
      expect(cfKeys).not.toContain('signals')
    })
  })

  // -- Carry-forward restoration (Task 3.6) --

  describe('carry-forward restoration', () => {
    const CF_RESTORE_RECIPE = `
name: cf-restore
version: "1.0"
description: Recipe to test carry-forward restoration
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: filter
    type: agent
    context: [projects]
    instructions: "Filter"
    returns:
      projectIds: "string[]"
  - id: signals
    type: api
    action: "GET /v2/signals"
    params:
      projectIds: "{filter.data.projectIds}"
  - id: analyze
    type: agent
    context: [filter, signals]
    instructions: "Analyze using post-yield data"
    returns:
      summary: "string"
  - id: deep
    type: api
    action: "GET /v2/signals"
analysis:
  instructions: "Final analysis"
  context: [projects, signals]
`

    it('should restore carry-forward entries into results on resume', async () => {
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const carryForward = { projects: [{ id: 'p1', name: 'Carried Project' }] }

      const result = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        carryForward,
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting.step).toBe('analyze')
      // The 'projects' data was restored from carry-forward and is re-carried
      // (analysis.context references projects, so it gets carried forward again)
      expect(awaiting.carryForward).toBeDefined()
      expect(awaiting.carryForward!.projects).toEqual([{ id: 'p1', name: 'Carried Project' }])
      // signals was just computed and is also referenced by analysis.context
      expect(awaiting.carryForward!.signals).toEqual(signalsData)
    })

    it('should be a no-op when carryForward is undefined', async () => {
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        // no carryForward
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting.step).toBe('analyze')
      // Without carry-forward, 'projects' is not in ctx.results, so carryForward
      // at the second yield should only contain 'signals' (which was just computed)
      expect(awaiting.carryForward).toBeDefined()
      expect(awaiting.carryForward!.signals).toEqual(signalsData)
      // 'projects' was not restored, so it cannot be re-carried
      expect(awaiting.carryForward!.projects).toBeUndefined()
    })

    it('should be a no-op when carryForward is an empty object', async () => {
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        carryForward: {},
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting.step).toBe('analyze')
      // Empty carry-forward is equivalent to no carry-forward
      expect(awaiting.carryForward).toBeDefined()
      expect(awaiting.carryForward!.signals).toEqual(signalsData)
      expect(awaiting.carryForward!.projects).toBeUndefined()
    })

    it('should create synthetic StepResults with zeroed timing for restored entries', async () => {
      // Test the full flow: carry-forward at first yield, restore and verify at completion
      const CF_COMPLETE_RECIPE = `
name: cf-complete
version: "1.0"
description: Recipe to verify restored entries reach completion output
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
  - id: filter
    type: agent
    context: [projects]
    instructions: "Filter"
    returns:
      projectIds: "string[]"
  - id: deep
    type: api
    action: "GET /v2/signals"
`

      const deepData = [{ id: 'd1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(deepData))

      const carryForward = { projects: [{ id: 'p1' }] }

      const result = await executeRecipe({
        yaml: CF_COMPLETE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        carryForward,
      })

      expect(result.status).toBe('complete')
      const data = (result as { data: Record<string, unknown> }).data
      // 'projects' was restored from carry-forward and appears in completion data
      expect(data.projects).toEqual([{ id: 'p1' }])
      // filter was injected from agent input
      expect(data.filter).toEqual({ projectIds: ['p1'] })
      // deep was freshly executed
      expect(data.deep).toEqual(deepData)
    })

    it('should make restored carry-forward data available for full end-to-end flow', async () => {
      // Simulate a complete 3-invocation flow with carry-forward

      // Invocation 1: initial run -> yields at filter
      const projectsData = [{ id: 'p1', name: 'Alpha' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))

      const result1 = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result1.status).toBe('awaiting_agent')
      const awaiting1 = result1 as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting1.step).toBe('filter')
      // projects is referenced by analysis.context and exists in results
      expect(awaiting1.carryForward).toBeDefined()
      expect(awaiting1.carryForward!.projects).toEqual(projectsData)

      // Invocation 2: resume from filter with carry-forward -> yields at analyze
      mockGet.mockReset()
      const signalsData = [{ id: 's1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(signalsData))

      const result2 = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'filter',
        resumeInput: { projectIds: ['p1'] },
        carryForward: awaiting1.carryForward,
      })

      expect(result2.status).toBe('awaiting_agent')
      const awaiting2 = result2 as { step: string; carryForward?: Record<string, unknown> }
      expect(awaiting2.step).toBe('analyze')
      // Both projects (restored) and signals (fresh) are re-carried for analysis.context
      expect(awaiting2.carryForward).toBeDefined()
      expect(awaiting2.carryForward!.projects).toEqual(projectsData)
      expect(awaiting2.carryForward!.signals).toEqual(signalsData)

      // Invocation 3: resume from analyze with carry-forward -> completes
      mockGet.mockReset()
      const deepData = [{ id: 'd1' }]
      mockGet.mockResolvedValueOnce(mockApiResponse(deepData))

      const result3 = await executeRecipe({
        yaml: CF_RESTORE_RECIPE,
        params: {},
        clientOptions: {},
        resumeFromStep: 'analyze',
        resumeInput: { summary: 'Done' },
        carryForward: awaiting2.carryForward,
      })

      expect(result3.status).toBe('complete')
      const data = (result3 as { data: Record<string, unknown> }).data
      expect(data.deep).toEqual(deepData)
      expect(data.analyze).toEqual({ summary: 'Done' })
      // Restored carry-forward data should appear in completion output
      expect(data.projects).toEqual(projectsData)
      expect(data.signals).toEqual(signalsData)
    })
  })
})
