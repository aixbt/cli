import { describe, it, expect } from 'vitest'

import {
  buildSegments,
  validateRecipe,
  validateRecipeCollectIssues,
  extractStepReferences,
  extractTemplateRefs,
  extractAllTemplateRefs,
} from '../../src/lib/recipe-validator.js'

import { RecipeValidationError } from '../../src/lib/errors.js'

import type {
  Recipe,
  RecipeStep,
  ApiStep,
  AgentStep,
  ForeachStep,
} from '../../src/types.js'

// -- Test helpers --

function makeRecipe(
  steps: RecipeStep[],
  params?: Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean; description?: string; default?: string | number | boolean }>,
): Recipe {
  return {
    name: 'test',
    version: '1.0',
    description: '',
    params,
    steps,
  }
}

function apiStep(
  id: string,
  endpoint: string,
  params?: Record<string, unknown>,
): ApiStep {
  return { id, endpoint, params }
}

function agentStep(id: string, context: string[]): AgentStep {
  return {
    id,
    type: 'agent',
    context,
    task: 'inference',
    description: 'test',
    returns: { result: 'string' },
  }
}

function foreachStep(
  id: string,
  foreach: string,
  endpoint: string,
  params?: Record<string, unknown>,
): ForeachStep {
  return { id, foreach, endpoint, params }
}

// -- extractTemplateRefs --

describe('extractTemplateRefs', () => {
  it('should extract a single template reference', () => {
    expect(extractTemplateRefs('{params.token}')).toEqual(['params.token'])
  })

  it('should extract multiple template references', () => {
    const refs = extractTemplateRefs('/v2/{params.project}/signals/{step1.data}')
    expect(refs).toEqual(['params.project', 'step1.data'])
  })

  it('should return empty array for string with no refs', () => {
    expect(extractTemplateRefs('GET /v2/projects')).toEqual([])
  })

  it('should return empty array for empty string', () => {
    expect(extractTemplateRefs('')).toEqual([])
  })
})

// -- extractAllTemplateRefs --

describe('extractAllTemplateRefs', () => {
  it('should extract refs from a string', () => {
    expect(extractAllTemplateRefs('{step1.data}')).toEqual(['step1.data'])
  })

  it('should extract refs from an array of strings', () => {
    const refs = extractAllTemplateRefs(['{a.data}', '{b.data}'])
    expect(refs).toEqual(['a.data', 'b.data'])
  })

  it('should extract refs from nested objects', () => {
    const refs = extractAllTemplateRefs({ key: '{step1.data}', nested: { inner: '{step2.data}' } })
    expect(refs).toEqual(['step1.data', 'step2.data'])
  })

  it('should return empty array for numbers', () => {
    expect(extractAllTemplateRefs(42)).toEqual([])
  })

  it('should return empty array for null', () => {
    expect(extractAllTemplateRefs(null)).toEqual([])
  })

  it('should return empty array for undefined', () => {
    expect(extractAllTemplateRefs(undefined)).toEqual([])
  })

  it('should return empty array for booleans', () => {
    expect(extractAllTemplateRefs(true)).toEqual([])
  })
})

// -- extractStepReferences --

describe('extractStepReferences', () => {
  it('should extract step reference from API step endpoint', () => {
    const refs = extractStepReferences(apiStep('s2', 'GET /v2/projects/{s1.data}'))
    expect(refs.has('s1')).toBe(true)
  })

  it('should extract step reference from API step params', () => {
    const refs = extractStepReferences(apiStep('s2', 'GET /v2/projects', { id: '{s1.data.id}' }))
    expect(refs.has('s1')).toBe(true)
  })

  it('should not include params prefix as a step reference', () => {
    const refs = extractStepReferences(apiStep('s1', 'GET /v2/projects/{params.slug}'))
    expect(refs.has('params')).toBe(false)
  })

  it('should not include item prefix as a step reference', () => {
    const refs = extractStepReferences(
      foreachStep('s2', 'step1.data', 'GET /v2/projects/{item.id}'),
    )
    expect(refs.has('item')).toBe(false)
  })

  it('should extract foreach step reference from the foreach field', () => {
    const refs = extractStepReferences(foreachStep('s2', 'step1.data', 'GET /v2/projects'))
    expect(refs.has('step1')).toBe(true)
  })

  it('should extract foreach step reference when foreach has no dot', () => {
    const refs = extractStepReferences(foreachStep('s2', 'step1', 'GET /v2/projects'))
    expect(refs.has('step1')).toBe(true)
  })

  it('should not extract references from agent step (no endpoint/params)', () => {
    const refs = extractStepReferences(agentStep('a1', ['s1', 's2']))
    // Agent steps have context but extractStepReferences does not check context
    expect(refs.size).toBe(0)
  })
})

// -- buildSegments --

describe('buildSegments', () => {
  it('should return a single segment when recipe has no agent steps', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/signals'),
    ])
    const segments = buildSegments(recipe)
    expect(segments).toHaveLength(1)
    expect(segments[0].steps).toHaveLength(2)
    expect(segments[0].steps[0].id).toBe('s1')
    expect(segments[0].steps[1].id).toBe('s2')
  })

  it('should have no precedingAgentStep on the first segment when there is no agent', () => {
    const recipe = makeRecipe([apiStep('s1', 'GET /v2/projects')])
    const segments = buildSegments(recipe)
    expect(segments[0].precedingAgentStep).toBeUndefined()
  })

  it('should split into 2 segments when agent step is in the middle', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
    ])
    const segments = buildSegments(recipe)
    expect(segments).toHaveLength(2)
    // First segment: s1 + a1 (agent step is included in the segment it terminates)
    expect(segments[0].steps.map((s) => s.id)).toEqual(['s1', 'a1'])
    // Second segment: s2
    expect(segments[1].steps.map((s) => s.id)).toEqual(['s2'])
  })

  it('should set precedingAgentStep on the segment after an agent step', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
    ])
    const segments = buildSegments(recipe)
    expect(segments[1].precedingAgentStep).toBeDefined()
    expect(segments[1].precedingAgentStep!.id).toBe('a1')
  })

  it('should create a segment with just the agent step when agent is at the beginning', () => {
    const recipe = makeRecipe([
      agentStep('a1', []),
      apiStep('s1', 'GET /v2/projects'),
    ])
    const segments = buildSegments(recipe)
    expect(segments).toHaveLength(2)
    expect(segments[0].steps).toHaveLength(1)
    expect(segments[0].steps[0].id).toBe('a1')
    expect(segments[0].precedingAgentStep).toBeUndefined()
    // s1 goes in second segment
    expect(segments[1].steps.map((s) => s.id)).toEqual(['s1'])
    expect(segments[1].precedingAgentStep!.id).toBe('a1')
  })

  it('should handle multiple agent steps creating multiple segments', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
      agentStep('a2', ['s2']),
      apiStep('s3', 'GET /v2/clusters'),
    ])
    const segments = buildSegments(recipe)
    expect(segments).toHaveLength(3)
    // First segment: s1 + a1
    expect(segments[0].steps.map((s) => s.id)).toEqual(['s1', 'a1'])
    expect(segments[0].precedingAgentStep).toBeUndefined()
    // Second segment: s2 + a2
    expect(segments[1].steps.map((s) => s.id)).toEqual(['s2', 'a2'])
    expect(segments[1].precedingAgentStep!.id).toBe('a1')
    // Third segment: s3
    expect(segments[2].steps.map((s) => s.id)).toEqual(['s3'])
    expect(segments[2].precedingAgentStep!.id).toBe('a2')
  })

  it('should assign sequential indexes to segments', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
      agentStep('a2', ['s2']),
      apiStep('s3', 'GET /v2/clusters'),
    ])
    const segments = buildSegments(recipe)
    expect(segments[0].index).toBe(0)
    expect(segments[1].index).toBe(1)
    expect(segments[2].index).toBe(2)
  })

  it('should handle consecutive agent steps as separate segments', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      agentStep('a2', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
    ])
    const segments = buildSegments(recipe)
    // s1+a1 in first segment, a2 alone in second, s2 in third
    expect(segments).toHaveLength(3)
    expect(segments[0].steps.map((s) => s.id)).toEqual(['s1', 'a1'])
    expect(segments[1].steps.map((s) => s.id)).toEqual(['a2'])
    expect(segments[1].precedingAgentStep!.id).toBe('a1')
    expect(segments[2].steps.map((s) => s.id)).toEqual(['s2'])
    expect(segments[2].precedingAgentStep!.id).toBe('a2')
  })

  it('should return empty segments array for recipe with no steps', () => {
    const recipe = makeRecipe([])
    const segments = buildSegments(recipe)
    expect(segments).toHaveLength(0)
  })
})

// -- validateRecipe: segment boundary validation --

describe('validateRecipe segment boundaries', () => {
  it('should accept references within the same segment', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/projects/{s1.data.id}'),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should accept step referencing a preceding step within the same segment', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/projects', { id: '{s1.data.id}' }),
      apiStep('s3', 'GET /v2/signals', { project: '{s2.data}' }),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject API step referencing a step from a prior segment across an agent boundary', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      // s2 references s1 which is in the prior segment
      apiStep('s2', 'GET /v2/projects/{s1.data.id}'),
    ])
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) => i.message.includes('"s1"') && i.message.includes('not accessible'))).toBe(true)
  })

  it('should allow steps to reference the preceding agent step output', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      // s2 references a1 which is the preceding agent step
      apiStep('s2', 'GET /v2/projects', { result: '{a1.data}' }),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should accept agent step context referencing accessible steps', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/signals'),
      agentStep('a1', ['s1', 's2']),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject agent step context referencing inaccessible step', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
      // a2 tries to reference s1, which is in a prior segment
      agentStep('a2', ['s1']),
    ])
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) =>
      i.path.includes('a2') && i.message.includes('"s1"') && i.message.includes('not accessible'),
    )).toBe(true)
  })

  it('should include accessible step list in segment boundary error message', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      apiStep('s2', 'GET /v2/signals'),
      // s3 references s1, which is across the agent boundary
      apiStep('s3', 'GET /v2/projects/{s1.data.id}'),
    ])
    const issues = validateRecipeCollectIssues(recipe)
    const issue = issues.find((i) => i.message.includes('"s1"'))
    expect(issue).toBeDefined()
    expect(issue!.message).toContain('Accessible steps:')
    // a1 and s2 should be accessible (a1 is precedingAgentStep, s2 precedes s3 in same segment)
    expect(issue!.message).toContain('a1')
    expect(issue!.message).toContain('s2')
  })

  it('should accept agent step referencing the preceding agent step in context', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
      // a2 references a1 which is the precedingAgentStep for segment 1
      agentStep('a2', ['a1']),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })
})

// -- validateRecipe: variable references --

describe('validateRecipe variable references', () => {
  it('should accept {params.X} when param is defined', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects', { token: '{params.token}' })],
      { token: { type: 'string' } },
    )
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject {params.X} when param is not defined', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects', { token: '{params.missing}' })],
      { token: { type: 'string' } },
    )
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) => i.message.includes('undefined param') && i.message.includes('"missing"'))).toBe(true)
  })

  it('should accept {step_id.data} when step exists', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/signals', { id: '{s1.data}' }),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject {step_id.data} when step does not exist', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects', { id: '{nonexistent.data}' }),
    ])
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) => i.message.includes('unknown step') && i.message.includes('"nonexistent"'))).toBe(true)
  })

  it('should accept foreach reference to existing step', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      foreachStep('s2', 's1.data', 'GET /v2/projects/{item.id}'),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject foreach reference to nonexistent step', () => {
    const recipe = makeRecipe([
      foreachStep('s1', 'missing.data', 'GET /v2/projects/{item.id}'),
    ])
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) => i.message.includes('unknown step') && i.message.includes('"missing"'))).toBe(true)
  })

  it('should always accept {item.X} references (runtime check)', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      foreachStep('s2', 's1.data', 'GET /v2/projects/{item.id}', { name: '{item.name}' }),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should check template refs in endpoint', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects/{params.missing}')],
    )
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) =>
      i.path.includes('endpoint') && i.message.includes('undefined param'),
    )).toBe(true)
  })

  it('should check template refs in params', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects', { limit: '{params.limit}' })],
    )
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) =>
      i.path.includes('params') && i.message.includes('undefined param') && i.message.includes('"limit"'),
    )).toBe(true)
  })

  it('should silently skip bare {params} reference without a dot (no param name to validate)', () => {
    // {params} without a dot is treated as a params prefix but has no param name to check,
    // so the validator skips it without error
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects', { x: '{params}' })],
    )
    const issues = validateRecipeCollectIssues(recipe)
    // No error for bare {params} — the validator recognizes the prefix and skips
    expect(issues.filter((i) => i.message.includes('params'))).toHaveLength(0)
  })

  it('should reject endpoint referencing unknown step', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects/{ghost.data}')],
    )
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) =>
      i.path.includes('endpoint') && i.message.includes('unknown step') && i.message.includes('"ghost"'),
    )).toBe(true)
  })

  it('should skip variable reference checking for agent steps', () => {
    // Agent steps have context arrays but no endpoint/params to check for template refs
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      agentStep('a1', ['s1']),
    ])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })
})

// -- validateRecipe: required params --

describe('validateRecipe required params', () => {
  it('should accept params with valid types (string, number, boolean)', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects')],
      {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'boolean' },
      },
    )
    expect(() => validateRecipe(recipe)).not.toThrow()
  })

  it('should reject param with invalid type', () => {
    const recipe = makeRecipe(
      [apiStep('s1', 'GET /v2/projects')],
      { bad: { type: 'object' as any } },
    )
    expect(() => validateRecipe(recipe)).toThrow(RecipeValidationError)
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.some((i) =>
      i.path.includes('params.bad.type') && i.message.includes('Param type must be one of'),
    )).toBe(true)
  })

  it('should accept recipe with no params defined', () => {
    const recipe = makeRecipe([apiStep('s1', 'GET /v2/projects')])
    expect(() => validateRecipe(recipe)).not.toThrow()
  })
})

// -- validateRecipeCollectIssues --

describe('validateRecipeCollectIssues', () => {
  it('should return empty array for a valid recipe', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects'),
      apiStep('s2', 'GET /v2/signals'),
    ])
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues).toEqual([])
  })

  it('should return all issues without throwing', () => {
    const recipe = makeRecipe(
      [
        apiStep('s1', 'GET /v2/projects/{params.missing}'),
        foreachStep('s2', 'ghost.data', 'GET /v2/things'),
      ],
      { token: { type: 'object' as any } },
    )
    // Should not throw
    const issues = validateRecipeCollectIssues(recipe)
    expect(issues.length).toBeGreaterThan(0)
    // Each issue should have path and message
    for (const issue of issues) {
      expect(typeof issue.path).toBe('string')
      expect(typeof issue.message).toBe('string')
    }
  })

  it('should return the same issues that validateRecipe would throw with', () => {
    const recipe = makeRecipe([
      apiStep('s1', 'GET /v2/projects/{params.x}'),
    ])
    const issues = validateRecipeCollectIssues(recipe)
    try {
      validateRecipe(recipe)
      throw new Error('Expected RecipeValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(RecipeValidationError)
      const rve = err as RecipeValidationError
      expect(rve.issues).toEqual(issues)
    }
  })
})

// -- Multiple issue collection --

describe('multiple issue collection', () => {
  it('should collect all issues, not just the first one', () => {
    const recipe = makeRecipe(
      [
        apiStep('s1', 'GET /v2/{params.missing1}', { x: '{params.missing2}' }),
      ],
    )
    const issues = validateRecipeCollectIssues(recipe)
    // Should have at least 2 issues (one for endpoint param, one for params param)
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.some((i) => i.message.includes('"missing1"'))).toBe(true)
    expect(issues.some((i) => i.message.includes('"missing2"'))).toBe(true)
  })

  it('should collect issues from multiple validation categories', () => {
    const recipe = makeRecipe(
      [
        apiStep('s1', 'GET /v2/projects'),
        agentStep('a1', ['s1']),
        // Cross-boundary reference (segment boundary issue)
        apiStep('s2', 'GET /v2/{s1.data}'),
      ],
      // Invalid param type (required params issue)
      { bad: { type: 'array' as any } },
    )
    const issues = validateRecipeCollectIssues(recipe)
    // Should have both segment boundary issue and param type issue
    expect(issues.some((i) => i.message.includes('not accessible'))).toBe(true)
    expect(issues.some((i) => i.message.includes('Param type must be one of'))).toBe(true)
  })

  it('should include issue count in the thrown error message', () => {
    const recipe = makeRecipe(
      [
        apiStep('s1', 'GET /v2/{params.a}', { x: '{params.b}' }),
      ],
    )
    try {
      validateRecipe(recipe)
      throw new Error('Expected RecipeValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(RecipeValidationError)
      const rve = err as RecipeValidationError
      expect(rve.message).toContain(`${rve.issues.length} issue`)
    }
  })
})
