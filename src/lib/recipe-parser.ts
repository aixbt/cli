import { parse as parseYaml } from 'yaml'
import { RecipeValidationError } from './errors.js'
import type { Recipe, RecipeStep, RecipeParam } from '../types.js'

interface ValidationIssue {
  path: string
  message: string
}

function validateStep(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
  issues: ValidationIssue[],
): RecipeStep | null {
  const path = `steps[${index}]`

  if (typeof raw !== 'object' || raw === null) {
    issues.push({ path, message: 'Step must be an object' })
    return null
  }

  const step = raw as Record<string, unknown>

  // Validate id
  if (typeof step.id !== 'string' || step.id.trim() === '') {
    issues.push({ path: `${path}.id`, message: 'Step must have a non-empty string id' })
    return null
  }

  if (seenIds.has(step.id)) {
    issues.push({ path: `${path}.id`, message: `Duplicate step id: ${step.id}` })
  }
  seenIds.add(step.id)

  const stepPath = `steps[${index}] (${step.id})`

  // Determine step type
  if (step.type === 'agent') {
    // Agent step validation
    if (!Array.isArray(step.context)) {
      issues.push({ path: `${stepPath}.context`, message: 'Agent step must have a context array' })
    }
    if (typeof step.task !== 'string') {
      issues.push({ path: `${stepPath}.task`, message: 'Agent step must have a task string' })
    }
    if (typeof step.description !== 'string') {
      issues.push({
        path: `${stepPath}.description`,
        message: 'Agent step must have a description string',
      })
    }
    if (typeof step.returns !== 'object' || step.returns === null || Array.isArray(step.returns)) {
      issues.push({
        path: `${stepPath}.returns`,
        message: 'Agent step must have a returns object',
      })
    }

    return {
      id: step.id,
      type: 'agent' as const,
      context: Array.isArray(step.context) ? (step.context as string[]) : [],
      task: typeof step.task === 'string' ? step.task : '',
      description: typeof step.description === 'string' ? step.description : '',
      returns:
        typeof step.returns === 'object' && step.returns !== null && !Array.isArray(step.returns)
          ? (step.returns as Record<string, string>)
          : {},
    }
  }

  // API or foreach step — must have endpoint
  if (typeof step.endpoint !== 'string' || step.endpoint.trim() === '') {
    issues.push({
      path: `${stepPath}.endpoint`,
      message: 'Step must have a non-empty endpoint string',
    })
  }

  if ('foreach' in step && step.foreach !== undefined) {
    // Foreach step
    if (typeof step.foreach !== 'string') {
      issues.push({
        path: `${stepPath}.foreach`,
        message: 'foreach must be a string',
      })
    }
    return {
      id: step.id,
      foreach: typeof step.foreach === 'string' ? step.foreach : '',
      endpoint: typeof step.endpoint === 'string' ? step.endpoint : '',
      params: typeof step.params === 'object' && step.params !== null
        ? (step.params as Record<string, unknown>)
        : undefined,
    }
  }

  // Plain API step
  return {
    id: step.id,
    endpoint: typeof step.endpoint === 'string' ? step.endpoint : '',
    params: typeof step.params === 'object' && step.params !== null
      ? (step.params as Record<string, unknown>)
      : undefined,
  }
}

const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean'])

function validateParams(
  raw: unknown,
  issues: ValidationIssue[],
): Record<string, RecipeParam> | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'params', message: 'params must be an object' })
    return undefined
  }

  const params = raw as Record<string, unknown>
  const result: Record<string, RecipeParam> = {}

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'object' || value === null) {
      issues.push({ path: `params.${key}`, message: 'Param definition must be an object' })
      continue
    }

    const param = value as Record<string, unknown>

    if (typeof param.type !== 'string' || !VALID_PARAM_TYPES.has(param.type)) {
      issues.push({
        path: `params.${key}.type`,
        message: `Param type must be one of: string, number, boolean`,
      })
      continue
    }

    result[key] = {
      type: param.type as 'string' | 'number' | 'boolean',
      required: typeof param.required === 'boolean' ? param.required : undefined,
      description: typeof param.description === 'string' ? param.description : undefined,
      default: param.default as string | number | boolean | undefined,
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function validateOutputBlock(
  raw: unknown,
  issues: ValidationIssue[],
): Recipe['output'] | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'output', message: 'output must be an object' })
    return undefined
  }

  const output = raw as Record<string, unknown>
  const result: Recipe['output'] = {}

  if ('merge' in output) {
    if (!Array.isArray(output.merge) || !output.merge.every((v) => typeof v === 'string')) {
      issues.push({ path: 'output.merge', message: 'merge must be an array of strings' })
    } else {
      result.merge = output.merge as string[]
    }
  }

  if ('join_on' in output) {
    if (typeof output.join_on !== 'string') {
      issues.push({ path: 'output.join_on', message: 'join_on must be a string' })
    } else {
      result.join_on = output.join_on
    }
  }

  if ('include' in output) {
    if (!Array.isArray(output.include) || !output.include.every((v) => typeof v === 'string')) {
      issues.push({ path: 'output.include', message: 'include must be an array of strings' })
    } else {
      result.include = output.include as string[]
    }
  }

  return result
}

function validateAnalysisBlock(
  raw: unknown,
  issues: ValidationIssue[],
): Recipe['analysis'] | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'analysis', message: 'analysis must be an object' })
    return undefined
  }

  const analysis = raw as Record<string, unknown>
  const result: Recipe['analysis'] = {}
  const stringFields = ['instructions', 'context', 'task', 'output_format'] as const

  for (const field of stringFields) {
    if (field in analysis) {
      if (typeof analysis[field] !== 'string') {
        issues.push({
          path: `analysis.${field}`,
          message: `${field} must be a string`,
        })
      } else {
        result[field] = analysis[field] as string
      }
    }
  }

  return result
}

export function parseRecipe(yamlString: string): Recipe {
  const issues: ValidationIssue[] = []

  let raw: unknown
  try {
    raw = parseYaml(yamlString)
  } catch (err) {
    throw new RecipeValidationError('Invalid YAML syntax', [
      { path: '', message: err instanceof Error ? err.message : 'Failed to parse YAML' },
    ])
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new RecipeValidationError('Recipe must be a YAML object', [
      { path: '', message: 'Expected a YAML mapping at the top level' },
    ])
  }

  const doc = raw as Record<string, unknown>

  // Validate name
  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    issues.push({ path: 'name', message: 'name is required and must be a non-empty string' })
  }

  // Validate version (string or number, defaults to '1.0')
  let version = '1.0'
  if (doc.version !== undefined && doc.version !== null) {
    if (typeof doc.version === 'string') {
      version = doc.version
    } else if (typeof doc.version === 'number') {
      version = String(doc.version)
    } else {
      issues.push({ path: 'version', message: 'version must be a string or number' })
    }
  }

  // Validate description (string, defaults to '')
  let description = ''
  if (doc.description !== undefined && doc.description !== null) {
    if (typeof doc.description === 'string') {
      description = doc.description
    } else {
      issues.push({ path: 'description', message: 'description must be a string' })
    }
  }

  // Validate tier
  let tier: string | undefined
  if (doc.tier !== undefined && doc.tier !== null) {
    if (typeof doc.tier === 'string') {
      tier = doc.tier
    } else {
      issues.push({ path: 'tier', message: 'tier must be a string' })
    }
  }

  // Validate steps
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    issues.push({ path: 'steps', message: 'steps is required and must be a non-empty array' })
  }

  const seenIds = new Set<string>()
  const steps: RecipeStep[] = []

  if (Array.isArray(doc.steps)) {
    for (let i = 0; i < doc.steps.length; i++) {
      const step = validateStep(doc.steps[i], i, seenIds, issues)
      if (step) {
        steps.push(step)
      }
    }
  }

  // Validate params
  const params = validateParams(doc.params, issues)

  // Validate output
  const output = validateOutputBlock(doc.output, issues)

  // Validate analysis
  const analysis = validateAnalysisBlock(doc.analysis, issues)

  if (issues.length > 0) {
    throw new RecipeValidationError(
      `Recipe validation failed with ${issues.length} issue(s)`,
      issues,
    )
  }

  return {
    name: (doc.name as string).trim(),
    version,
    description,
    tier,
    params,
    steps,
    output,
    analysis,
  }
}
