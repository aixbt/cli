import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveValue, resolveEndpoint, resolveRelativeTime, executeRecipe } from '../../src/lib/recipe-engine.js'
import type { ExecutionContext, StepResult } from '../../src/types.js'
import { CliError } from '../../src/lib/errors.js'
import * as apiClient from '../../src/lib/api-client.js'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock the api-client get function to avoid real HTTP calls
vi.mock('../../src/lib/api-client.js', async () => {
  const actual = await vi.importActual('../../src/lib/api-client.js')
  return {
    ...actual,
    get: vi.fn(),
  }
})

const mockGet = vi.mocked(apiClient.get)

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

// -- resolveEndpoint --

describe('resolveEndpoint', () => {
  it('should parse GET method and path', () => {
    const ctx = makeCtx()
    const result = resolveEndpoint('GET /v2/projects', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects' })
  })

  it('should parse POST method and path', () => {
    const ctx = makeCtx()
    const result = resolveEndpoint('POST /v2/something', ctx)
    expect(result).toEqual({ method: 'POST', path: '/v2/something' })
  })

  it('should default to GET when no method is specified', () => {
    const ctx = makeCtx()
    const result = resolveEndpoint('/v2/projects', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects' })
  })

  it('should uppercase the method', () => {
    const ctx = makeCtx()
    const result = resolveEndpoint('post /v2/data', ctx)
    expect(result).toEqual({ method: 'POST', path: '/v2/data' })
  })

  it('should resolve templates in the path', () => {
    const ctx = makeCtx()
    const foreachItem = { id: 'proj-42' }
    const result = resolveEndpoint('GET /v2/projects/{item.id}/momentum', ctx, foreachItem)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects/proj-42/momentum' })
  })

  it('should resolve param templates in the path', () => {
    const ctx = makeCtx({ params: { slug: 'my-project' } })
    const result = resolveEndpoint('GET /v2/projects/{params.slug}', ctx)
    expect(result).toEqual({ method: 'GET', path: '/v2/projects/my-project' })
  })
})

// -- resolveRelativeTime --

describe('resolveRelativeTime', () => {
  it('should convert -24h to ISO timestamp approximately 24 hours ago', () => {
    const before = Date.now()
    const result = resolveRelativeTime('-24h')
    const after = Date.now()

    const resultMs = new Date(result).getTime()
    const expected24hAgo = before - 24 * 60 * 60 * 1000

    // Within 2 second tolerance
    expect(resultMs).toBeGreaterThanOrEqual(expected24hAgo - 2000)
    expect(resultMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 2000)
  })

  it('should convert -7d to ISO timestamp approximately 7 days ago', () => {
    const before = Date.now()
    const result = resolveRelativeTime('-7d')

    const resultMs = new Date(result).getTime()
    const expected7dAgo = before - 7 * 24 * 60 * 60 * 1000

    expect(resultMs).toBeGreaterThanOrEqual(expected7dAgo - 2000)
    expect(resultMs).toBeLessThanOrEqual(expected7dAgo + 2000)
  })

  it('should convert -30m to ISO timestamp approximately 30 minutes ago', () => {
    const before = Date.now()
    const result = resolveRelativeTime('-30m')

    const resultMs = new Date(result).getTime()
    const expected30mAgo = before - 30 * 60 * 1000

    expect(resultMs).toBeGreaterThanOrEqual(expected30mAgo - 2000)
    expect(resultMs).toBeLessThanOrEqual(expected30mAgo + 2000)
  })

  it('should return an ISO 8601 formatted string', () => {
    const result = resolveRelativeTime('-1h')
    // ISO string ends with Z and matches ISO pattern
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)
  })

  it('should return non-matching string as-is', () => {
    expect(resolveRelativeTime('2024-01-01T00:00:00Z')).toBe('2024-01-01T00:00:00Z')
    expect(resolveRelativeTime('hello')).toBe('hello')
    expect(resolveRelativeTime('')).toBe('')
  })

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
    endpoint: "GET /v2/projects"
`

const TWO_STEP_RECIPE = `
name: test-recipe
version: "1.0"
description: Two steps
steps:
  - id: projects
    endpoint: "GET /v2/projects"
  - id: signals
    endpoint: "GET /v2/signals"
`

const RECIPE_WITH_VARIABLE_REFS = `
name: test-recipe
version: "1.0"
description: Steps with variable references
steps:
  - id: projects
    endpoint: "GET /v2/projects"
  - id: signals
    endpoint: "GET /v2/signals"
    params:
      projectIds: "{projects.data[*].id}"
`

const AGENT_RECIPE = `
name: test-recipe
version: "1.0"
description: Recipe with agent step
steps:
  - id: surging
    endpoint: "GET /v2/projects"
    params:
      momentum: rising
  - id: analyze
    type: agent
    context: [surging]
    task: inference
    description: "Analyze surging projects"
    returns:
      projectIds: "string[]"
  - id: deep
    endpoint: "GET /v2/signals"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
  - id: signals
    endpoint: "GET /v2/signals"
  - id: analyze
    type: agent
    context: [projects, signals]
    task: inference
    description: "Analyze data"
    returns:
      summary: "string"
`

const MULTI_SEGMENT_RECIPE = `
name: multi-segment
version: "1.0"
description: Recipe with two agent steps
steps:
  - id: surging
    endpoint: "GET /v2/projects"
  - id: filter
    type: agent
    context: [surging]
    task: inference
    description: "Filter projects"
    returns:
      projectIds: "string[]"
  - id: signals
    endpoint: "GET /v2/signals"
    params:
      projectIds: "{filter.data.projectIds}"
  - id: analyze
    type: agent
    context: [signals]
    task: synthesis
    description: "Analyze signals"
    returns:
      summary: "string"
  - id: enrichment
    endpoint: "GET /v2/projects"
`

const RECIPE_WITH_OUTPUT_AND_ANALYSIS = `
name: test-recipe
version: "1.0"
description: Recipe with output and analysis
output:
  merge: [projects, signals]
  join_on: projectId
analysis:
  task: summarize
  instructions: "Summarize the data"
steps:
  - id: projects
    endpoint: "GET /v2/projects"
  - id: signals
    endpoint: "GET /v2/signals"
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
  })

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
        task: string
        description: string
        returns: Record<string, string>
        data: Record<string, unknown>
        resumeCommand: string
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.task).toBe('inference')
      expect(awaiting.description).toBe('Analyze surging projects')
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
      await expect(
        executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'nonexistent',
        }),
      ).rejects.toThrow(CliError)

      try {
        await executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'nonexistent',
        })
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('STEP_NOT_FOUND')
      }
    })

    it('should throw INVALID_RESUME_STEP when resuming from a non-agent step', async () => {
      await expect(
        executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'surging',
        }),
      ).rejects.toThrow(CliError)

      try {
        await executeRecipe({
          yaml: AGENT_RECIPE,
          params: {},
          clientOptions: {},
          resumeFromStep: 'surging',
        })
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('INVALID_RESUME_STEP')
      }
    })
  })

  // -- Output --

  describe('output', () => {
    it('should include output and analysis from YAML in RecipeComplete', async () => {
      mockGet
        .mockResolvedValueOnce(mockApiResponse([{ id: 'p1' }]))
        .mockResolvedValueOnce(mockApiResponse([{ id: 's1' }]))

      const result = await executeRecipe({
        yaml: RECIPE_WITH_OUTPUT_AND_ANALYSIS,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')
      const complete = result as {
        output?: { merge?: string[]; join_on?: string }
        analysis?: { task?: string; instructions?: string }
      }
      expect(complete.output).toEqual({
        merge: ['projects', 'signals'],
        join_on: 'projectId',
      })
      expect(complete.analysis).toEqual({
        task: 'summarize',
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
      expect(awaiting.resumeCommand).toContain('--param chain=base')
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
      require('node:fs').writeFileSync(blockingFile, 'x')
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
        task: string
        description: string
        returns: Record<string, string>
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.task).toBe('inference')
      expect(awaiting.description).toBe('Analyze data')
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
        task: string
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('filter')
      expect(awaiting.task).toBe('inference')
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
        task: string
        data: Record<string, unknown>
      }
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.task).toBe('synthesis')
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
    it('should call get with the correct endpoint path', async () => {
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
  - id: momentum
    foreach: projects.data
    endpoint: "GET /v2/projects/{item.id}/momentum"
`

    const FOREACH_PARAMS_RECIPE = `
name: foreach-params-test
version: "1.0"
description: Foreach with params test
steps:
  - id: projects
    endpoint: "GET /v2/projects"
  - id: details
    foreach: projects.data
    endpoint: "GET /v2/projects/{item.id}"
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

      // 2 successes in the data array
      expect(foreachData).toHaveLength(2)
      expect(foreachData[0]).toEqual({ ok: true })
      expect(foreachData[1]).toEqual({ ok: true })
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
      expect(momentumData).toEqual([{ score: 10 }, { score: 20 }])
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
      expect(momentumData).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }])
    })

    it('should include failure details with error message and failed item', async () => {
      const projectsData = [
        { id: 'fail-item', name: 'Failing' },
      ]

      mockGet.mockResolvedValueOnce(mockApiResponse(projectsData))
      mockGet.mockRejectedValueOnce(new Error('Not Found'))

      const result = await executeRecipe({
        yaml: FOREACH_RECIPE,
        params: {},
        clientOptions: {},
      })

      expect(result.status).toBe('complete')

      // The data for the foreach step should be empty (no successes)
      const data = (result as { data: Record<string, unknown> }).data
      const momentumData = data.momentum as unknown[]
      expect(momentumData).toEqual([])
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
})
