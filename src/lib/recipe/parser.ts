import { parse as parseYaml } from 'yaml'
import { RecipeValidationError } from '../errors.js'
import type { Recipe, RecipeStep, RecipeParam, ValidationIssue, TransformBlock, SampleTransform } from '../../types.js'

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
    if (typeof step.instructions !== 'string') {
      issues.push({
        path: `${stepPath}.instructions`,
        message: 'Agent step must have an instructions string',
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
      instructions: typeof step.instructions === 'string' ? step.instructions : '',
      returns:
        typeof step.returns === 'object' && step.returns !== null && !Array.isArray(step.returns)
          ? (step.returns as Record<string, string>)
          : {},
    }
  }

  // Transform step (has input, no endpoint)
  if ('input' in step && step.input !== undefined) {
    if (typeof step.input !== 'string' || (step.input as string).trim() === '') {
      issues.push({
        path: `${stepPath}.input`,
        message: 'input must be a non-empty string referencing a step id',
      })
    }

    if ('endpoint' in step && step.endpoint !== undefined) {
      issues.push({
        path: stepPath,
        message: 'Transform step (with input) cannot have an endpoint',
      })
    }

    if ('foreach' in step && step.foreach !== undefined) {
      issues.push({
        path: stepPath,
        message: 'Transform step (with input) cannot have foreach',
      })
    }

    const transform = validateTransformBlock(step.transform, `${stepPath}.transform`, issues)
    if (step.transform === undefined || step.transform === null) {
      issues.push({
        path: `${stepPath}.transform`,
        message: 'Transform step must have a transform block',
      })
    }

    return {
      id: step.id,
      input: typeof step.input === 'string' ? step.input : '',
      transform: transform ?? {},
    }
  }

  // API or foreach step — must have endpoint
  if (typeof step.endpoint !== 'string' || step.endpoint.trim() === '') {
    issues.push({
      path: `${stepPath}.endpoint`,
      message: 'Step must have a non-empty endpoint string',
    })
  }

  const transform = validateTransformBlock(step.transform, `${stepPath}.transform`, issues)

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
      ...(transform ? { transform } : {}),
    }
  }

  // Plain API step
  return {
    id: step.id,
    endpoint: typeof step.endpoint === 'string' ? step.endpoint : '',
    params: typeof step.params === 'object' && step.params !== null
      ? (step.params as Record<string, unknown>)
      : undefined,
    ...(transform ? { transform } : {}),
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
  const result: Recipe['analysis'] = {}
  const stringFields = ['instructions', 'task', 'output'] as const

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
    tier,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    params,
    steps,
    hints,
    analysis,
  }
}
