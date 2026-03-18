import { describe, it, expect } from 'vitest'

import { parseRecipe } from '../../src/lib/recipe/parser.js'
import { RecipeValidationError } from '../../src/lib/errors.js'
import { isAgentStep, isForeachStep, isApiStep, isTransformStep } from '../../src/types.js'
import type { AgentStep, ForeachStep, ApiStep, TransformStep } from '../../src/types.js'

// -- Helpers --

function expectValidationError(yamlString: string): RecipeValidationError {
  try {
    parseRecipe(yamlString)
    throw new Error('Expected RecipeValidationError but parseRecipe succeeded')
  } catch (err) {
    expect(err).toBeInstanceOf(RecipeValidationError)
    return err as RecipeValidationError
  }
}

function issueMessages(err: RecipeValidationError): string[] {
  return err.issues.map((i) => i.message)
}

function issuePaths(err: RecipeValidationError): string[] {
  return err.issues.map((i) => i.path)
}

// -- Valid recipe parsing --

describe('parseRecipe', () => {
  describe('valid recipes', () => {
    it('should parse a minimal valid recipe with one API step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.name).toBe('test-recipe')
      expect(recipe.steps).toHaveLength(1)
      expect(recipe.steps[0].id).toBe('step1')
    })

    it('should default version to 1.0 when omitted', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.version).toBe('1.0')
    })

    it('should convert numeric version to string', () => {
      const yaml = `
name: test-recipe
version: 2
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.version).toBe('2')
    })

    it('should preserve string version as-is', () => {
      const yaml = `
name: test-recipe
version: "3.5.1"
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.version).toBe('3.5.1')
    })

    it('should default description to empty string when omitted', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.description).toBe('')
    })

    it('should parse description when provided', () => {
      const yaml = `
name: test-recipe
description: "A test recipe for validation"
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.description).toBe('A test recipe for validation')
    })

    it('should parse tier when provided', () => {
      const yaml = `
name: test-recipe
tier: pro
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.tier).toBe('pro')
    })

    it('should leave tier undefined when omitted', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.tier).toBeUndefined()
    })

    it('should trim whitespace from name', () => {
      const yaml = `
name: "  spaced-name  "
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.name).toBe('spaced-name')
    })

    it('should parse a full recipe with all optional fields', () => {
      const yaml = `
name: full-recipe
version: "2.0"
description: "A complete recipe"
tier: enterprise
params:
  token:
    type: string
    required: true
    description: "Token address"
  limit:
    type: number
    default: 10
steps:
  - id: fetch-projects
    action: "GET /v2/projects"
    params:
      limit: "{{limit}}"
  - id: fetch-details
    foreach: "fetch-projects.data"
    action: "GET /v2/projects/{{item.id}}"
  - id: analyze
    type: agent
    context:
      - fetch-projects
      - fetch-details
    instructions: "Provides analysis of fetched projects"
    returns:
      summary: string
      score: number
hints:
  combine:
    - fetch-projects
    - fetch-details
  key: "id"
  include:
    - name
    - score
analysis:
  instructions: "Summarize the data"
  output: "markdown"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.name).toBe('full-recipe')
      expect(recipe.version).toBe('2.0')
      expect(recipe.description).toBe('A complete recipe')
      expect(recipe.tier).toBe('enterprise')
      expect(recipe.params).toBeDefined()
      expect(recipe.params!.token.type).toBe('string')
      expect(recipe.params!.token.required).toBe(true)
      expect(recipe.params!.limit.type).toBe('number')
      expect(recipe.params!.limit.default).toBe(10)
      expect(recipe.steps).toHaveLength(3)
      expect(recipe.hints).toBeDefined()
      expect(recipe.hints!.combine).toEqual(['fetch-projects', 'fetch-details'])
      expect(recipe.hints!.key).toBe('id')
      expect(recipe.hints!.include).toEqual(['name', 'score'])
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize the data')
      expect(recipe.analysis!.output).toBe('markdown')
    })

    it('should parse an API step with params', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
    params:
      limit: 10
      sort: "name"
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.params).toEqual({ limit: 10, sort: 'name' })
    })

    it('should parse a foreach step correctly', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
  - id: step2
    foreach: "step1.data"
    action: "GET /v2/projects/{{item.id}}"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.steps).toHaveLength(2)
      const foreachStep = recipe.steps[1] as ForeachStep
      expect(foreachStep.foreach).toBe('step1.data')
      expect(foreachStep.action).toBe('GET /v2/projects/{{item.id}}')
    })

    it('should parse an agent step correctly', () => {
      const yaml = `
name: test-recipe
steps:
  - id: analyze
    type: agent
    context:
      - step1
    instructions: "Analysis step"
    returns:
      summary: string
`
      const recipe = parseRecipe(yaml)
      const agentStep = recipe.steps[0] as AgentStep
      expect(agentStep.type).toBe('agent')
      expect(agentStep.context).toEqual(['step1'])
      expect(agentStep.instructions).toBe('Analysis step')
      expect(agentStep.returns).toEqual({ summary: 'string' })
    })
  })

  // -- Required field validation --

  describe('required field validation', () => {
    it('should throw when name is missing', () => {
      const yaml = `
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('name is required'),
      )
    })

    it('should throw when name is an empty string', () => {
      const yaml = `
name: ""
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('name is required'),
      )
    })

    it('should throw when name is whitespace-only', () => {
      const yaml = `
name: "   "
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('name is required'),
      )
    })

    it('should throw when steps is missing', () => {
      const yaml = `
name: test-recipe
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('steps is required'),
      )
    })

    it('should throw when steps is an empty array', () => {
      const yaml = `
name: test-recipe
steps: []
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('steps is required'),
      )
    })

    it('should throw when steps is not an array', () => {
      const yaml = `
name: test-recipe
steps: "not an array"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('steps is required'),
      )
    })
  })

  // -- Step validation --

  describe('step validation', () => {
    it('should throw when a step is missing id', () => {
      const yaml = `
name: test-recipe
steps:
  - action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty string id'),
      )
    })

    it('should throw when a step has an empty id', () => {
      const yaml = `
name: test-recipe
steps:
  - id: ""
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty string id'),
      )
    })

    it('should throw when step ids are duplicated', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
  - id: step1
    action: "GET /v2/signals"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Duplicate step id: step1'),
      )
    })

    it('should throw when a step is not an object', () => {
      const yaml = `
name: test-recipe
steps:
  - "just a string"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must be an object'),
      )
    })

    it('should throw when API step is missing action', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty "action" string'),
      )
    })

    it('should throw when agent step is missing context', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    instructions: "Analysis"
    returns:
      summary: string
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a context array'),
      )
    })

    it('should throw when agent step is missing instructions', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    returns:
      summary: string
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have an instructions string'),
      )
    })

    it('should accept deprecated task as instructions (backward compat)', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    task: "Analyze"
    returns:
      summary: string
`
      const recipe = parseRecipe(yaml)
      const agentStep = recipe.steps[0] as AgentStep
      expect(agentStep.instructions).toBe('Analyze')
    })

    it('should throw when agent step is missing returns', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    instructions: "Analysis"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a returns object'),
      )
    })

    it('should throw when agent step returns is an array instead of object', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    instructions: "Analysis"
    returns:
      - summary
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a returns object'),
      )
    })

    it('should collect all issues from a single invalid agent step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
`
      const err = expectValidationError(yaml)
      // Should report context, instructions, and returns issues
      expect(err.issues.length).toBeGreaterThanOrEqual(3)
    })

    it('should throw when foreach step is missing action', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    foreach: "prev.data"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty "action" string'),
      )
    })

    it('should throw when foreach value is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    foreach: 123
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('foreach must be a string'),
      )
    })
  })

  // -- Issue collection (all issues reported, not just first) --

  describe('issue collection', () => {
    it('should collect all issues from multiple invalid steps', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
  - id: step2
`
      const err = expectValidationError(yaml)
      // Both steps missing action
      const actionIssues = err.issues.filter((i) =>
        i.message.includes('action'),
      )
      expect(actionIssues).toHaveLength(2)
    })

    it('should collect issues from both top-level and step validation', () => {
      const yaml = `
steps:
  - action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      // Missing name + step missing id
      expect(err.issues.length).toBeGreaterThanOrEqual(2)
      expect(issuePaths(err)).toContainEqual('name')
      expect(issuePaths(err)).toContainEqual(expect.stringContaining('id'))
    })
  })

  // -- Params validation --

  describe('params validation', () => {
    it('should parse valid params with all types', () => {
      const yaml = `
name: test-recipe
params:
  token:
    type: string
    required: true
    description: "Token address"
  count:
    type: number
    default: 5
  verbose:
    type: boolean
    default: false
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.params).toBeDefined()
      expect(recipe.params!.token.type).toBe('string')
      expect(recipe.params!.token.required).toBe(true)
      expect(recipe.params!.token.description).toBe('Token address')
      expect(recipe.params!.count.type).toBe('number')
      expect(recipe.params!.count.default).toBe(5)
      expect(recipe.params!.verbose.type).toBe('boolean')
      expect(recipe.params!.verbose.default).toBe(false)
    })

    it('should throw when param has invalid type', () => {
      const yaml = `
name: test-recipe
params:
  token:
    type: object
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Param type must be one of'),
      )
    })

    it('should throw when params is not an object', () => {
      const yaml = `
name: test-recipe
params: "not an object"
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('params must be an object'),
      )
    })

    it('should throw when params is an array', () => {
      const yaml = `
name: test-recipe
params:
  - token
  - limit
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('params must be an object'),
      )
    })

    it('should throw when a param definition is not an object', () => {
      const yaml = `
name: test-recipe
params:
  token: "string"
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Param definition must be an object'),
      )
    })

    it('should leave params undefined when not provided', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.params).toBeUndefined()
    })
  })

  // -- Output block validation --

  describe('hints block validation', () => {
    it('should parse valid output with combine, key, and include', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints:
  combine:
    - step1
  key: "id"
  include:
    - name
    - score
`
      const recipe = parseRecipe(yaml)
      expect(recipe.hints).toBeDefined()
      expect(recipe.hints!.combine).toEqual(['step1'])
      expect(recipe.hints!.key).toBe('id')
      expect(recipe.hints!.include).toEqual(['name', 'score'])
    })

    it('should throw when combine is not an array', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints:
  combine: "step1"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('combine must be an array of strings'),
      )
    })

    it('should throw when combine contains non-strings', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints:
  combine:
    - 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('combine must be an array of strings'),
      )
    })

    it('should throw when key is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints:
  key: 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('key must be a string'),
      )
    })

    it('should throw when include is not an array of strings', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints:
  include: "name"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('include must be an array of strings'),
      )
    })

    it('should throw when output is not an object', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
hints: "not an object"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('hints must be an object'),
      )
    })

    it('should leave output undefined when not provided', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.hints).toBeUndefined()
    })
  })

  // -- Analysis block validation --

  describe('analysis block validation', () => {
    it('should parse valid analysis block with all fields', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
analysis:
  instructions: "Summarize the data"
  output: "markdown"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize the data')
      expect(recipe.analysis!.output).toBe('markdown')
    })

    it('should merge deprecated task into instructions (backward compat)', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
analysis:
  instructions: "Summarize the data"
  task: "Generate summary"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize the data\n\nGenerate summary')
    })

    it('should parse analysis block with partial fields', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
analysis:
  instructions: "Summarize"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize')
      expect(recipe.analysis!.output).toBeUndefined()
    })

    it('should throw when analysis field is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
analysis:
  instructions: 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('analysis must have an instructions string'),
      )
    })

    it('should throw when analysis is not an object', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
analysis: "not an object"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('analysis must be an object'),
      )
    })

    it('should leave analysis undefined when not provided', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeUndefined()
    })
  })

  // -- Transform blocks --

  describe('transform blocks', () => {
    it('should parse transform block with select on API step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    params:
      limit: 50
    transform:
      select: [id, name]
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.transform).toBeDefined()
      expect(step.transform!.select).toEqual(['id', 'name'])
    })

    it('should parse transform block with sample on API step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        count: 80
        guaranteePercent: 0.3
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.transform).toBeDefined()
      expect(step.transform!.sample).toBeDefined()
      expect(step.transform!.sample!.count).toBe(80)
      expect(step.transform!.sample!.guaranteePercent).toBe(0.3)
    })

    it('should parse transform block with sample using tokenBudget', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        tokenBudget: 2000
        weight_by: "metrics.score"
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.transform).toBeDefined()
      expect(step.transform!.sample).toBeDefined()
      expect(step.transform!.sample!.tokenBudget).toBe(2000)
      expect(step.transform!.sample!.weight_by).toBe('metrics.score')
      expect(step.transform!.sample!.count).toBeUndefined()
    })

    it('should parse transform block with both select and sample', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      select: [id, name, score]
      sample:
        count: 50
        guaranteePercent: 0.5
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.transform).toBeDefined()
      expect(step.transform!.select).toEqual(['id', 'name', 'score'])
      expect(step.transform!.sample!.count).toBe(50)
      expect(step.transform!.sample!.guaranteePercent).toBe(0.5)
    })

    it('should parse transform block with sample using guaranteeCount', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        tokenBudget: 50000
        guaranteeCount: 30
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.transform!.sample!.tokenBudget).toBe(50000)
      expect(step.transform!.sample!.guaranteeCount).toBe(30)
      expect(step.transform!.sample!.guaranteePercent).toBeUndefined()
    })

    it('should parse transform block on foreach step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: projects
    action: "GET /v2/projects"
  - id: details
    foreach: "projects.data"
    action: "GET /v2/projects/{{item.id}}"
    transform:
      select: [id, name]
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[1] as ForeachStep
      expect(step.transform).toBeDefined()
      expect(step.transform!.select).toEqual(['id', 'name'])
    })

    it('should parse standalone transform step with input and transform', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    params:
      limit: 50
  - id: filtered
    input: signals
    transform:
      select: [id, name]
`
      const recipe = parseRecipe(yaml)
      expect(recipe.steps).toHaveLength(2)
      const step = recipe.steps[1] as TransformStep
      expect(step.id).toBe('filtered')
      expect(step.input).toBe('signals')
      expect(step.transform).toBeDefined()
      expect(step.transform.select).toEqual(['id', 'name'])
    })

    it('should throw when transform step is missing transform block', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
  - id: filtered
    input: signals
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Transform step must have a transform block'),
      )
    })

    it('should throw when transform step has an action', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
  - id: filtered
    input: signals
    action: "GET /v2/other"
    transform:
      select: [id]
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Transform step (with input) cannot have an action'),
      )
    })

    it('should throw when transform step has foreach', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
  - id: filtered
    input: signals
    foreach: "signals.data"
    transform:
      select: [id]
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Transform step (with input) cannot have foreach'),
      )
    })

    it('should throw when select is not an array', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      select: "not-an-array"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('select must be an array of strings'),
      )
    })

    it('should throw when sample is missing count and tokenBudget', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample: {}
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('sample must have either count or tokenBudget'),
      )
    })

    it('should throw when sample count is negative', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        count: -1
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('count must be a positive integer'),
      )
    })

    it('should throw when sample guaranteePercent is out of range', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        count: 10
        guaranteePercent: 1.5
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('guaranteePercent must be a number between 0 and 1'),
      )
    })

    it('should throw when guaranteePercent and guaranteeCount are both set', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        count: 10
        guaranteePercent: 0.3
        guaranteeCount: 5
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('guaranteePercent and guaranteeCount are mutually exclusive'),
      )
    })

    it('should throw when guaranteeCount is not a positive integer', () => {
      const yaml = `
name: test-recipe
steps:
  - id: signals
    action: "GET /v2/signals"
    transform:
      sample:
        count: 10
        guaranteeCount: -5
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('guaranteeCount must be a positive integer'),
      )
    })

    it('should still parse standard API step without transform', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    action: "GET /v2/projects"
    params:
      limit: 10
`
      const recipe = parseRecipe(yaml)
      expect(recipe.steps).toHaveLength(1)
      const step = recipe.steps[0] as ApiStep
      expect(step.action).toBe('GET /v2/projects')
      expect(step.transform).toBeUndefined()
    })

    it('should still parse foreach step without transform', () => {
      const yaml = `
name: test-recipe
steps:
  - id: projects
    action: "GET /v2/projects"
  - id: details
    foreach: "projects.data"
    action: "GET /v2/projects/{{item.id}}"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.steps).toHaveLength(2)
      const step = recipe.steps[1] as ForeachStep
      expect(step.foreach).toBe('projects.data')
      expect(step.transform).toBeUndefined()
    })
  })

  // -- Fallback field --

  describe('fallback field', () => {
    it('should parse fallback on API step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: price
    action: ohlc
    source: coingecko
    params:
      id: "bitcoin"
      days: "30"
    fallback: "Pull 30-day OHLC price data from CoinGecko for bitcoin"
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.fallback).toBe('Pull 30-day OHLC price data from CoinGecko for bitcoin')
    })

    it('should parse fallback on foreach step', () => {
      const yaml = `
name: test-recipe
steps:
  - id: projects
    action: projects
  - id: prices
    foreach: "projects.data"
    action: ohlc
    source: coingecko
    params:
      id: "{item.cgId}"
      days: "30"
    fallback: "Pull 30-day price data for each project"
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[1] as ForeachStep
      expect(step.fallback).toBe('Pull 30-day price data for each project')
    })

    it('should omit fallback when not provided', () => {
      const yaml = `
name: test-recipe
steps:
  - id: price
    action: ohlc
    source: coingecko
    params:
      id: "bitcoin"
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.fallback).toBeUndefined()
    })

    it('should ignore non-string fallback values', () => {
      const yaml = `
name: test-recipe
steps:
  - id: price
    action: ohlc
    source: coingecko
    fallback: 42
`
      const recipe = parseRecipe(yaml)
      const step = recipe.steps[0] as ApiStep
      expect(step.fallback).toBeUndefined()
    })
  })

  // -- YAML syntax and structural errors --

  describe('YAML syntax errors', () => {
    it('should throw RecipeValidationError for malformed YAML', () => {
      const yaml = `
name: test
steps:
  - id: step1
    action: [invalid yaml {{
`
      expect(() => parseRecipe(yaml)).toThrow(RecipeValidationError)
    })

    it('should throw RecipeValidationError when YAML is a scalar', () => {
      expect(() => parseRecipe('just a string')).toThrow(RecipeValidationError)
    })

    it('should throw RecipeValidationError when YAML is an array', () => {
      const yaml = `
- item1
- item2
`
      expect(() => parseRecipe(yaml)).toThrow(RecipeValidationError)
    })

    it('should throw RecipeValidationError when YAML is null', () => {
      expect(() => parseRecipe('')).toThrow(RecipeValidationError)
    })

    it('should include meaningful message for non-object YAML', () => {
      try {
        parseRecipe('42')
        throw new Error('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RecipeValidationError)
        const rve = err as RecipeValidationError
        expect(rve.message).toContain('YAML object')
      }
    })
  })

  // -- Version validation --

  describe('version validation', () => {
    it('should throw when version is not a string or number', () => {
      const yaml = `
name: test-recipe
version: true
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('version must be a string or number'),
      )
    })
  })

  // -- Description validation --

  describe('description validation', () => {
    it('should throw when description is not a string', () => {
      const yaml = `
name: test-recipe
description: 123
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('description must be a string'),
      )
    })
  })

  // -- Tier validation --

  describe('tier validation', () => {
    it('should throw when tier is not a string', () => {
      const yaml = `
name: test-recipe
tier: 123
steps:
  - id: step1
    action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('tier must be a string'),
      )
    })
  })

  // -- RecipeValidationError shape --

  describe('RecipeValidationError structure', () => {
    it('should have an issues array with path and message', () => {
      const yaml = `
steps:
  - action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(err.issues).toBeInstanceOf(Array)
      expect(err.issues.length).toBeGreaterThan(0)
      for (const issue of err.issues) {
        expect(issue).toHaveProperty('path')
        expect(issue).toHaveProperty('message')
        expect(typeof issue.path).toBe('string')
        expect(typeof issue.message).toBe('string')
      }
    })

    it('should report issue count in the error message', () => {
      const yaml = `
steps:
  - action: "GET /v2/projects"
`
      const err = expectValidationError(yaml)
      expect(err.message).toContain('issue')
    })

    it('should be an instance of CliError', () => {
      const yaml = `invalid: true`
      const err = expectValidationError(yaml)
      expect(err.code).toBe('RECIPE_VALIDATION_ERROR')
    })
  })
})

// -- Step type guards (smoke test) --

describe('step type guards', () => {
  const steps = {
    api: { id: 'api1', action: 'GET /v2/projects' } as ApiStep,
    foreach: { id: 'foreach1', foreach: 'api1.data', action: 'GET /v2/projects/{{item.id}}' } as ForeachStep,
    agent: { id: 'agent1', type: 'agent', context: ['api1'], instructions: 'Analysis step', returns: { summary: 'string' } } as AgentStep,
    transform: { id: 'transform1', input: 'api1', transform: { select: ['id', 'name'] } } as TransformStep,
  }

  it.each([
    ['isAgentStep', isAgentStep, 'agent'],
    ['isForeachStep', isForeachStep, 'foreach'],
    ['isApiStep', isApiStep, 'api'],
    ['isTransformStep', isTransformStep, 'transform'],
  ] as const)('%s returns true only for %s steps', (_name, guard, trueKey) => {
    for (const [key, step] of Object.entries(steps)) {
      expect(guard(step)).toBe(key === trueKey)
    }
  })
})
