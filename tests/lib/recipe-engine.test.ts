import { describe, it, expect } from 'vitest'
import { resolveValue, resolveEndpoint, resolveRelativeTime } from '../../src/lib/recipe-engine.js'
import type { ExecutionContext, StepResult } from '../../src/types.js'

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
