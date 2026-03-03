import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExecutionContext, RecipeStep, Segment, StepResult,
  RecipeAwaitingAgent, RecipeComplete, AgentStep, Recipe,
} from '../types.js'
import { isAgentStep, isForeachStep } from '../types.js'
import { parseRecipe } from './recipe-parser.js'
import { validateRecipe, buildSegments } from './recipe-validator.js'
import { get, type ApiClientOptions } from './api-client.js'
import { CliError } from './errors.js'

const TEMPLATE_REGEX = /\{([^}]+)\}/g
const RELATIVE_TIME_REGEX = /^-(\d+)(h|d|m)$/

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function resolveExpression(
  expr: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  const trimmed = expr.trim()

  // params.X
  if (trimmed.startsWith('params.')) {
    const paramName = trimmed.slice('params.'.length)
    return ctx.params[paramName]
  }

  // item or item.X
  if (trimmed === 'item') {
    return foreachItem
  }
  if (trimmed.startsWith('item.')) {
    const path = trimmed.slice('item.'.length)
    return getNestedValue(foreachItem, path)
  }

  // Step references: step_id, step_id.data, step_id.data[*].field, step_id.data.nested.path
  const dotIndex = trimmed.indexOf('.')
  const stepId = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex)
  const stepResult = ctx.results.get(stepId)

  if (!stepResult) {
    return undefined
  }

  // Bare step_id
  if (dotIndex === -1) {
    return stepResult.data
  }

  const rest = trimmed.slice(dotIndex + 1)

  // Must start with "data"
  if (!rest.startsWith('data')) {
    return undefined
  }

  // step_id.data
  if (rest === 'data') {
    return stepResult.data
  }

  // step_id.data[*].field — pluck operation
  if (rest.startsWith('data[*].')) {
    const field = rest.slice('data[*].'.length)
    if (!Array.isArray(stepResult.data)) {
      return undefined
    }
    return stepResult.data.map((item: unknown) => getNestedValue(item, field))
  }

  // step_id.data.nested.path
  if (rest.startsWith('data.')) {
    const nestedPath = rest.slice('data.'.length)
    return getNestedValue(stepResult.data, nestedPath)
  }

  return undefined
}

function resolveString(
  str: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  // Check for standalone relative time expression first
  if (RELATIVE_TIME_REGEX.test(str)) {
    return resolveRelativeTime(str)
  }

  // Check if entire string is a single template expression — preserve type
  const singleMatch = /^\{([^}]+)\}$/.exec(str)
  if (singleMatch) {
    return resolveExpression(singleMatch[1], ctx, foreachItem)
  }

  // Mixed string interpolation
  return str.replace(TEMPLATE_REGEX, (_, expr: string) => {
    const resolved = resolveExpression(expr, ctx, foreachItem)
    return String(resolved ?? '')
  })
}

export function resolveValue(
  value: unknown,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  if (typeof value === 'string') {
    return resolveString(value, ctx, foreachItem)
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, ctx, foreachItem))
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveValue(val, ctx, foreachItem)
    }
    return result
  }

  // numbers, booleans, null, undefined — pass through
  return value
}

export function resolveEndpoint(
  endpoint: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): { method: string; path: string } {
  const spaceIndex = endpoint.indexOf(' ')

  let method: string
  let path: string

  if (spaceIndex === -1) {
    method = 'GET'
    path = endpoint
  } else {
    method = endpoint.slice(0, spaceIndex).toUpperCase()
    path = endpoint.slice(spaceIndex + 1)
  }

  // Resolve templates in the path
  const resolved = resolveString(path, ctx, foreachItem)
  return { method, path: String(resolved) }
}

export function resolveRelativeTime(expr: string): string {
  const match = RELATIVE_TIME_REGEX.exec(expr)
  if (!match) {
    return expr
  }

  const amount = parseInt(match[1], 10)
  const unit = match[2]

  const now = new Date()

  switch (unit) {
    case 'h':
      now.setTime(now.getTime() - amount * 60 * 60 * 1000)
      break
    case 'd':
      now.setTime(now.getTime() - amount * 24 * 60 * 60 * 1000)
      break
    case 'm':
      now.setTime(now.getTime() - amount * 60 * 1000)
      break
  }

  return now.toISOString()
}

// -- Recipe execution --

function applyDefaults(
  recipe: Recipe,
  provided: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...provided }

  if (recipe.params) {
    for (const [name, param] of Object.entries(recipe.params)) {
      if (!(name in result) && param.default !== undefined) {
        result[name] = String(param.default)
      }
    }
  }

  return result
}

function findResumeSegment(
  ctx: ExecutionContext,
  resumeStepId: string,
  resumeInput?: Record<string, unknown>,
): { segmentIndex: number; agentInput: Record<string, unknown> | null } {
  const stepId = resumeStepId.startsWith('step:')
    ? resumeStepId.slice('step:'.length)
    : resumeStepId

  for (const segment of ctx.segments) {
    if (segment.precedingAgentStep && segment.precedingAgentStep.id === stepId) {
      return {
        segmentIndex: segment.index,
        agentInput: resumeInput ?? null,
      }
    }
  }

  // Check if the step exists at all but isn't an agent step
  const allStepIds = ctx.recipe.steps.map((s) => s.id)
  if (allStepIds.includes(stepId)) {
    throw new CliError(
      `Step "${stepId}" is not an agent step and cannot be resumed from`,
      'INVALID_RESUME_STEP',
    )
  }

  throw new CliError(
    `Step "${stepId}" not found in recipe`,
    'STEP_NOT_FOUND',
  )
}

async function executeStep(
  step: RecipeStep,
  ctx: ExecutionContext,
  clientOptions: ApiClientOptions,
): Promise<StepResult> {
  const startedAt = new Date()

  const { path } = resolveEndpoint(
    isAgentStep(step) ? '' : step.endpoint,
    ctx,
  )

  const resolvedParams: Record<string, string | number | boolean | undefined> = {}
  if (!isAgentStep(step) && step.params) {
    const resolved = resolveValue(step.params, ctx) as Record<string, unknown>
    for (const [key, val] of Object.entries(resolved)) {
      if (Array.isArray(val)) {
        resolvedParams[key] = val.join(',')
      } else if (val === null || val === undefined) {
        resolvedParams[key] = undefined
      } else {
        resolvedParams[key] = val as string | number | boolean
      }
    }
  }

  const response = await get(path, resolvedParams, clientOptions)

  const completedAt = new Date()

  return {
    stepId: step.id,
    data: response.data,
    rateLimit: response.rateLimit,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    },
  }
}

function buildAwaitingAgentOutput(
  ctx: ExecutionContext,
  agentStep: AgentStep,
  originalParams: Record<string, string>,
): RecipeAwaitingAgent {
  const data: Record<string, unknown> = {}
  for (const ref of agentStep.context) {
    const result = ctx.results.get(ref)
    if (result) {
      data[ref] = result.data
    }
  }

  const paramParts = Object.entries(originalParams)
    .map(([k, v]) => `--param ${k}=${v}`)
    .join(' ')
  const resumeCommand = `aixbt recipe run --resume step:${agentStep.id} ${paramParts}`.trim()

  return {
    status: 'awaiting_agent',
    recipe: ctx.recipe.name,
    version: ctx.recipe.version,
    step: agentStep.id,
    task: agentStep.task,
    description: agentStep.description,
    returns: agentStep.returns,
    data,
    resumeCommand,
  }
}

function buildCompleteOutput(
  ctx: ExecutionContext,
  outputDir?: string,
): RecipeComplete {
  const data: Record<string, unknown> = {}

  if (outputDir) {
    mkdirSync(outputDir, { recursive: true })
    let fileIndex = 1
    for (const [stepId, result] of ctx.results) {
      const filename = `segment-${String(fileIndex).padStart(3, '0')}.json`
      const filePath = join(outputDir, filename)
      writeFileSync(filePath, JSON.stringify(result.data, null, 2))
      data[stepId] = { file: filePath }
      fileIndex++
    }
  } else {
    for (const [stepId, result] of ctx.results) {
      data[stepId] = result.data
    }
  }

  return {
    status: 'complete',
    recipe: ctx.recipe.name,
    version: ctx.recipe.version,
    timestamp: new Date().toISOString(),
    data,
    output: ctx.recipe.output,
    analysis: ctx.recipe.analysis,
  }
}

export async function executeRecipe(options: {
  yaml: string
  params: Record<string, string>
  clientOptions: ApiClientOptions
  resumeFromStep?: string
  resumeInput?: Record<string, unknown>
  outputDir?: string
}): Promise<RecipeAwaitingAgent | RecipeComplete> {
  const recipe = parseRecipe(options.yaml)
  validateRecipe(recipe)
  const segments = buildSegments(recipe)

  const params = applyDefaults(recipe, options.params)

  const ctx: ExecutionContext = {
    recipe,
    params,
    results: new Map<string, StepResult>(),
    currentRateLimit: null,
    currentSegmentIndex: 0,
    segments,
    agentInput: null,
    resumedFromStep: options.resumeFromStep ?? null,
  }

  let startSegmentIndex = 0

  if (options.resumeFromStep) {
    const resume = findResumeSegment(ctx, options.resumeFromStep, options.resumeInput)
    startSegmentIndex = resume.segmentIndex
    ctx.agentInput = resume.agentInput
  }

  for (let i = startSegmentIndex; i < segments.length; i++) {
    const segment = segments[i]
    ctx.currentSegmentIndex = i

    // If resuming and the segment has a preceding agent step, inject agent input
    if (segment.precedingAgentStep && ctx.agentInput) {
      ctx.results.set(segment.precedingAgentStep.id, {
        stepId: segment.precedingAgentStep.id,
        data: ctx.agentInput,
        rateLimit: null,
        timing: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        },
      })
      ctx.agentInput = null
    }

    for (const step of segment.steps) {
      if (isAgentStep(step)) {
        return buildAwaitingAgentOutput(ctx, step, options.params)
      }

      const result = await executeStep(step, ctx, options.clientOptions)
      ctx.results.set(step.id, result)
      ctx.currentRateLimit = result.rateLimit
    }
  }

  return buildCompleteOutput(ctx, options.outputDir)
}
