import { describe, it, expect } from 'vitest'

import { parseRecipe } from '../../src/lib/recipe-parser.js'
import { RecipeValidationError } from '../../src/lib/errors.js'
import { isAgentStep, isForeachStep, isApiStep } from '../../src/types.js'
import type { AgentStep, ForeachStep, ApiStep } from '../../src/types.js'

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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.version).toBe('3.5.1')
    })

    it('should default description to empty string when omitted', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.tier).toBe('pro')
    })

    it('should leave tier undefined when omitted', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.tier).toBeUndefined()
    })

    it('should trim whitespace from name', () => {
      const yaml = `
name: "  spaced-name  "
steps:
  - id: step1
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
    params:
      limit: "{{limit}}"
  - id: fetch-details
    foreach: "fetch-projects.data"
    endpoint: "GET /v2/projects/{{item.id}}"
  - id: analyze
    type: agent
    context:
      - fetch-projects
      - fetch-details
    task: "Analyze the project data"
    description: "Provides analysis of fetched projects"
    returns:
      summary: string
      score: number
output:
  merge:
    - fetch-projects
    - fetch-details
  join_on: "id"
  include:
    - name
    - score
analysis:
  instructions: "Summarize the data"
  context: "Project analysis context"
  task: "Generate summary"
  output_format: "markdown"
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
      expect(recipe.output).toBeDefined()
      expect(recipe.output!.merge).toEqual(['fetch-projects', 'fetch-details'])
      expect(recipe.output!.join_on).toBe('id')
      expect(recipe.output!.include).toEqual(['name', 'score'])
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize the data')
      expect(recipe.analysis!.output_format).toBe('markdown')
    })

    it('should parse an API step with params', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
  - id: step2
    foreach: "step1.data"
    endpoint: "GET /v2/projects/{{item.id}}"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.steps).toHaveLength(2)
      const foreachStep = recipe.steps[1] as ForeachStep
      expect(foreachStep.foreach).toBe('step1.data')
      expect(foreachStep.endpoint).toBe('GET /v2/projects/{{item.id}}')
    })

    it('should parse an agent step correctly', () => {
      const yaml = `
name: test-recipe
steps:
  - id: analyze
    type: agent
    context:
      - step1
    task: "Analyze"
    description: "Analysis step"
    returns:
      summary: string
`
      const recipe = parseRecipe(yaml)
      const agentStep = recipe.steps[0] as AgentStep
      expect(agentStep.type).toBe('agent')
      expect(agentStep.context).toEqual(['step1'])
      expect(agentStep.task).toBe('Analyze')
      expect(agentStep.description).toBe('Analysis step')
      expect(agentStep.returns).toEqual({ summary: 'string' })
    })
  })

  // -- Required field validation --

  describe('required field validation', () => {
    it('should throw when name is missing', () => {
      const yaml = `
steps:
  - id: step1
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
  - endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
  - id: step1
    endpoint: "GET /v2/signals"
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

    it('should throw when API step is missing endpoint', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty endpoint string'),
      )
    })

    it('should throw when agent step is missing context', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    task: "Analyze"
    description: "Analysis"
    returns:
      summary: string
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a context array'),
      )
    })

    it('should throw when agent step is missing task', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    description: "Analysis"
    returns:
      summary: string
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a task string'),
      )
    })

    it('should throw when agent step is missing description', () => {
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
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Agent step must have a description string'),
      )
    })

    it('should throw when agent step is missing returns', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    type: agent
    context:
      - prev
    task: "Analyze"
    description: "Analysis"
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
    task: "Analyze"
    description: "Analysis"
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
      // Should report context, task, description, and returns issues
      expect(err.issues.length).toBeGreaterThanOrEqual(4)
    })

    it('should throw when foreach step is missing endpoint', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    foreach: "prev.data"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('Step must have a non-empty endpoint string'),
      )
    })

    it('should throw when foreach value is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    foreach: 123
    endpoint: "GET /v2/projects"
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
      // Both steps missing endpoint
      const endpointIssues = err.issues.filter((i) =>
        i.message.includes('endpoint'),
      )
      expect(endpointIssues).toHaveLength(2)
    })

    it('should collect issues from both top-level and step validation', () => {
      const yaml = `
steps:
  - endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.params).toBeUndefined()
    })
  })

  // -- Output block validation --

  describe('output block validation', () => {
    it('should parse valid output with merge, join_on, and include', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
output:
  merge:
    - step1
  join_on: "id"
  include:
    - name
    - score
`
      const recipe = parseRecipe(yaml)
      expect(recipe.output).toBeDefined()
      expect(recipe.output!.merge).toEqual(['step1'])
      expect(recipe.output!.join_on).toBe('id')
      expect(recipe.output!.include).toEqual(['name', 'score'])
    })

    it('should throw when merge is not an array', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
output:
  merge: "step1"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('merge must be an array of strings'),
      )
    })

    it('should throw when merge contains non-strings', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
output:
  merge:
    - 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('merge must be an array of strings'),
      )
    })

    it('should throw when join_on is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
output:
  join_on: 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('join_on must be a string'),
      )
    })

    it('should throw when include is not an array of strings', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
output:
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
    endpoint: "GET /v2/projects"
output: "not an object"
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('output must be an object'),
      )
    })

    it('should leave output undefined when not provided', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.output).toBeUndefined()
    })
  })

  // -- Analysis block validation --

  describe('analysis block validation', () => {
    it('should parse valid analysis block with all fields', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
analysis:
  instructions: "Summarize the data"
  context: "Project context"
  task: "Generate summary"
  output_format: "markdown"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize the data')
      expect(recipe.analysis!.context).toBe('Project context')
      expect(recipe.analysis!.task).toBe('Generate summary')
      expect(recipe.analysis!.output_format).toBe('markdown')
    })

    it('should parse analysis block with partial fields', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
analysis:
  instructions: "Summarize"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeDefined()
      expect(recipe.analysis!.instructions).toBe('Summarize')
      expect(recipe.analysis!.context).toBeUndefined()
      expect(recipe.analysis!.task).toBeUndefined()
      expect(recipe.analysis!.output_format).toBeUndefined()
    })

    it('should throw when analysis field is not a string', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
analysis:
  instructions: 123
`
      const err = expectValidationError(yaml)
      expect(issueMessages(err)).toContainEqual(
        expect.stringContaining('instructions must be a string'),
      )
    })

    it('should throw when analysis is not an object', () => {
      const yaml = `
name: test-recipe
steps:
  - id: step1
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
`
      const recipe = parseRecipe(yaml)
      expect(recipe.analysis).toBeUndefined()
    })
  })

  // -- YAML syntax and structural errors --

  describe('YAML syntax errors', () => {
    it('should throw RecipeValidationError for malformed YAML', () => {
      const yaml = `
name: test
steps:
  - id: step1
    endpoint: [invalid yaml {{
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
    endpoint: "GET /v2/projects"
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
  - endpoint: "GET /v2/projects"
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
  - endpoint: "GET /v2/projects"
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

// -- Step type guards --

describe('step type guards', () => {
  const apiStep: ApiStep = {
    id: 'api1',
    endpoint: 'GET /v2/projects',
  }

  const foreachStep: ForeachStep = {
    id: 'foreach1',
    foreach: 'api1.data',
    endpoint: 'GET /v2/projects/{{item.id}}',
  }

  const agentStep: AgentStep = {
    id: 'agent1',
    type: 'agent',
    context: ['api1'],
    task: 'Analyze',
    description: 'Analysis step',
    returns: { summary: 'string' },
  }

  describe('isAgentStep', () => {
    it('should return true for an agent step', () => {
      expect(isAgentStep(agentStep)).toBe(true)
    })

    it('should return false for an API step', () => {
      expect(isAgentStep(apiStep)).toBe(false)
    })

    it('should return false for a foreach step', () => {
      expect(isAgentStep(foreachStep)).toBe(false)
    })
  })

  describe('isForeachStep', () => {
    it('should return true for a foreach step', () => {
      expect(isForeachStep(foreachStep)).toBe(true)
    })

    it('should return false for an API step', () => {
      expect(isForeachStep(apiStep)).toBe(false)
    })

    it('should return false for an agent step', () => {
      expect(isForeachStep(agentStep)).toBe(false)
    })
  })

  describe('isApiStep', () => {
    it('should return true for an API step', () => {
      expect(isApiStep(apiStep)).toBe(true)
    })

    it('should return false for a foreach step', () => {
      expect(isApiStep(foreachStep)).toBe(false)
    })

    it('should return false for an agent step', () => {
      expect(isApiStep(agentStep)).toBe(false)
    })
  })
})
