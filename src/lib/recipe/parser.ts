import { parse as parseYaml } from 'yaml'
import { RecipeValidationError } from '../errors.js'
import { AGENT_RETURN_TYPES } from '../../types.js'
import type { Recipe, RecipeStep, RecipeParam, ValidationIssue, TransformBlock, SampleTransform, ApiStep, AgentStep } from '../../types.js'

function validateTransformBlock(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): TransformBlock | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path, message: 'transform must be an object' })
    return undefined
  }

  const block = raw as Record<string, unknown>
  const result: TransformBlock = {}

  // Validate select
  if ('select' in block) {
    if (
      !Array.isArray(block.select) ||
      !block.select.every((v: unknown) => typeof v === 'string')
    ) {
      issues.push({
        path: `${path}.select`,
        message: 'select must be an array of strings',
      })
    } else {
      result.select = block.select as string[]
    }
  }

  // Validate sample
  if ('sample' in block) {
    if (typeof block.sample !== 'object' || block.sample === null || Array.isArray(block.sample)) {
      issues.push({
        path: `${path}.sample`,
        message: 'sample must be an object',
      })
    } else {
      const sample = block.sample as Record<string, unknown>
      const sampleResult: SampleTransform = {}

      const hasCount = 'count' in sample && sample.count !== undefined
      const hasTokenBudget = 'tokenBudget' in sample && sample.tokenBudget !== undefined

      if (!hasCount && !hasTokenBudget) {
        issues.push({
          path: `${path}.sample`,
          message: 'sample must have either count or tokenBudget',
        })
      }

      if (hasCount) {
        if (typeof sample.count !== 'number' || !Number.isFinite(sample.count) || sample.count < 1 || !Number.isInteger(sample.count)) {
          issues.push({
            path: `${path}.sample.count`,
            message: 'count must be a positive integer',
          })
        } else {
          sampleResult.count = sample.count
        }
      }

      if (hasTokenBudget) {
        if (typeof sample.tokenBudget !== 'number' || !Number.isFinite(sample.tokenBudget) || sample.tokenBudget < 1) {
          issues.push({
            path: `${path}.sample.tokenBudget`,
            message: 'tokenBudget must be a positive number',
          })
        } else {
          sampleResult.tokenBudget = sample.tokenBudget
        }
      }

      const hasGuaranteePercent = 'guaranteePercent' in sample && sample.guaranteePercent !== undefined
      const hasGuaranteeCount = 'guaranteeCount' in sample && sample.guaranteeCount !== undefined

      if (hasGuaranteePercent && hasGuaranteeCount) {
        issues.push({
          path: `${path}.sample`,
          message: 'guaranteePercent and guaranteeCount are mutually exclusive',
        })
      }

      if (hasGuaranteePercent) {
        if (typeof sample.guaranteePercent !== 'number' || sample.guaranteePercent < 0 || sample.guaranteePercent > 1) {
          issues.push({
            path: `${path}.sample.guaranteePercent`,
            message: 'guaranteePercent must be a number between 0 and 1',
          })
        } else {
          sampleResult.guaranteePercent = sample.guaranteePercent
        }
      }

      if (hasGuaranteeCount) {
        if (typeof sample.guaranteeCount !== 'number' || !Number.isFinite(sample.guaranteeCount) || sample.guaranteeCount < 1 || !Number.isInteger(sample.guaranteeCount)) {
          issues.push({
            path: `${path}.sample.guaranteeCount`,
            message: 'guaranteeCount must be a positive integer',
          })
        } else {
          sampleResult.guaranteeCount = sample.guaranteeCount
        }
      }

      if ('weight_by' in sample && sample.weight_by !== undefined) {
        if (typeof sample.weight_by !== 'string') {
          issues.push({
            path: `${path}.sample.weight_by`,
            message: 'weight_by must be a string',
          })
        } else {
          sampleResult.weight_by = sample.weight_by
        }
      }

      result.sample = sampleResult
    }
  }

  return result
}

function validateApiStep(
  step: Record<string, unknown>,
  stepPath: string,
  forValue: string | undefined,
  issues: ValidationIssue[],
): ApiStep | null {
  // Must have action
  if (typeof step.action !== 'string' || step.action.trim() === '') {
    issues.push({
      path: `${stepPath}.action`,
      message: `Step "${step.id}" has type: api but is missing required field "action"`,
    })
  }

  // Validate source if present
  if ('source' in step && step.source !== undefined) {
    if (typeof step.source !== 'string') {
      issues.push({ path: `${stepPath}.source`, message: 'source must be a string' })
    }
  }

  const transform = validateTransformBlock(step.transform, `${stepPath}.transform`, issues)

  return {
    id: step.id as string,
    type: 'api' as const,
    action: typeof step.action === 'string' ? step.action : '',
    source: typeof step.source === 'string' ? step.source : undefined,
    params: typeof step.params === 'object' && step.params !== null
      ? (step.params as Record<string, unknown>)
      : undefined,
    ...(transform ? { transform } : {}),
    ...(forValue ? { 'for': forValue } : {}),
    ...(typeof step.fallback === 'string' ? { fallback: step.fallback } : {}),
  }
}

function validateAgentStep(
  step: Record<string, unknown>,
  stepPath: string,
  forValue: string | undefined,
  issues: ValidationIssue[],
): AgentStep | null {
  if (!Array.isArray(step.context) || !step.context.every((v: unknown) => typeof v === 'string')) {
    issues.push({
      path: `${stepPath}.context`,
      message: `Step "${step.id}" has type: agent but is missing required field "context" (must be an array of strings)`,
    })
  }

  const instructions = typeof step.instructions === 'string' ? step.instructions : ''
  if (!instructions) {
    issues.push({
      path: `${stepPath}.instructions`,
      message: `Step "${step.id}" has type: agent but is missing required field "instructions"`,
    })
  }

  if (typeof step.returns !== 'object' || step.returns === null || Array.isArray(step.returns)) {
    issues.push({
      path: `${stepPath}.returns`,
      message: `Step "${step.id}" has type: agent but is missing required field "returns" (must be an object)`,
    })
  } else {
    for (const [key, value] of Object.entries(step.returns as Record<string, unknown>)) {
      if (typeof value !== 'string' || !(AGENT_RETURN_TYPES as readonly string[]).includes(value)) {
        issues.push({
          path: `${stepPath}.returns.${key}`,
          message: `Invalid return type "${value}". Must be one of: ${AGENT_RETURN_TYPES.join(', ')}`,
        })
      }
    }
  }

  return {
    id: step.id as string,
    type: 'agent' as const,
    context: Array.isArray(step.context) ? (step.context as string[]) : [],
    instructions,
    returns:
      typeof step.returns === 'object' && step.returns !== null && !Array.isArray(step.returns)
        ? (step.returns as Record<string, string>)
        : {},
    ...(forValue ? { 'for': forValue } : {}),
  }
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

  // Require explicit type
  if (step.type !== 'api' && step.type !== 'agent') {
    const hint = step.type === undefined
      ? 'Every step requires type: api or type: agent'
      : `Unknown step type "${step.type}". Use type: api or type: agent`
    issues.push({ path: `${stepPath}.type`, message: hint })
    return null
  }

  // Validate optional for: modifier (shared by both types)
  let forValue: string | undefined
  if ('for' in step && step.for !== undefined) {
    if (typeof step.for !== 'string' || (step.for as string).trim() === '') {
      issues.push({
        path: `${stepPath}.for`,
        message: `Step "${step.id}" has type: ${step.type} with an invalid for: value (must be a non-empty string)`,
      })
    } else {
      forValue = step.for as string
    }
  }

  if (step.type === 'agent') {
    return validateAgentStep(step, stepPath, forValue, issues)
  }

  return validateApiStep(step, stepPath, forValue, issues)
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

function validateHintsBlock(
  raw: unknown,
  issues: ValidationIssue[],
): Recipe['hints'] | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'hints', message: 'hints must be an object' })
    return undefined
  }

  const hints = raw as Record<string, unknown>
  const result: Recipe['hints'] = {}

  if ('combine' in hints) {
    if (!Array.isArray(hints.combine) || !hints.combine.every((v) => typeof v === 'string')) {
      issues.push({ path: 'hints.combine', message: 'combine must be an array of strings' })
    } else {
      result.combine = hints.combine as string[]
    }
  }

  if ('key' in hints) {
    if (typeof hints.key !== 'string') {
      issues.push({ path: 'hints.key', message: 'key must be a string' })
    } else {
      result.key = hints.key
    }
  }

  if ('include' in hints) {
    if (!Array.isArray(hints.include) || !hints.include.every((v) => typeof v === 'string')) {
      issues.push({ path: 'hints.include', message: 'include must be an array of strings' })
    } else {
      result.include = hints.include as string[]
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

  // Backward compat: merge task into instructions if present
  let instructions = typeof analysis.instructions === 'string' ? analysis.instructions : ''
  if (typeof analysis.task === 'string') {
    if (instructions) {
      instructions = `${instructions}\n\n${analysis.task}`
    } else {
      instructions = analysis.task
    }
    console.error('warning: analysis.task is deprecated, use "instructions" instead')
  }

  if (!instructions) {
    issues.push({
      path: 'analysis.instructions',
      message: 'analysis must have an instructions string',
    })
  }

  if ('output' in analysis && typeof analysis.output !== 'string') {
    issues.push({
      path: 'analysis.output',
      message: 'output must be a string',
    })
  }

  return {
    instructions,
    ...(typeof analysis.output === 'string' ? { output: analysis.output } : {}),
  }
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

  // Validate estimatedTokens
  let estimatedTokens: number | null | undefined
  if (doc.estimatedTokens !== undefined) {
    if (doc.estimatedTokens === null) {
      estimatedTokens = null
    } else if (typeof doc.estimatedTokens === 'number' && Number.isFinite(doc.estimatedTokens)) {
      estimatedTokens = doc.estimatedTokens
    } else {
      issues.push({ path: 'estimatedTokens', message: 'estimatedTokens must be a number or null' })
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

  // Validate requiredOneOf
  let requiredOneOf: string[] | undefined
  if (doc.requiredOneOf !== undefined && doc.requiredOneOf !== null) {
    if (!Array.isArray(doc.requiredOneOf) || !doc.requiredOneOf.every((v: unknown) => typeof v === 'string')) {
      issues.push({ path: 'requiredOneOf', message: 'requiredOneOf must be an array of param name strings' })
    } else if (!params) {
      issues.push({ path: 'requiredOneOf', message: 'requiredOneOf requires params to be defined' })
    } else {
      const names = doc.requiredOneOf as string[]
      for (const name of names) {
        if (!(name in params)) {
          issues.push({ path: `requiredOneOf`, message: `"${name}" is not a defined param` })
        } else if (params[name].required) {
          issues.push({ path: `requiredOneOf`, message: `"${name}" must not be required: true (conflicts with requiredOneOf)` })
        }
      }
      if (names.length < 2) {
        issues.push({ path: 'requiredOneOf', message: 'requiredOneOf must contain at least 2 param names' })
      }
      requiredOneOf = names
    }
  }

  // Validate hints
  const hints = validateHintsBlock(doc.hints, issues)

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
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    params,
    requiredOneOf,
    steps,
    hints,
    analysis,
  }
}
