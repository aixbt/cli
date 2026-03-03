import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExecutionContext, RecipeStep, Segment, StepResult,
  RecipeAwaitingAgent, RecipeComplete, AgentStep, Recipe,
  ForeachStep, ForeachResult, ForeachFailure, RateLimitInfo,
} from '../types.js'
import { isAgentStep, isForeachStep, TEMPLATE_REGEX } from '../types.js'
import { parseRecipe } from './recipe-parser.js'
import { validateRecipe, buildSegments } from './recipe-validator.js'
import { get, sleep, type ApiClientOptions } from './api-client.js'
import { CliError } from './errors.js'
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

// -- Param helpers --

function flattenParams(
  params: Record<string, unknown> | undefined,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): Record<string, string | number | boolean | undefined> {
  const result: Record<string, string | number | boolean | undefined> = {}
  if (!params) return result
  const resolved = resolveValue(params, ctx, foreachItem) as Record<string, unknown>
  for (const [key, val] of Object.entries(resolved)) {
    if (Array.isArray(val)) {
      result[key] = val.join(',')
    } else if (val === null || val === undefined) {
      result[key] = undefined
    } else {
      result[key] = val as string | number | boolean
    }
  }
  return result
}

// -- Foreach helpers --

function deriveConcurrency(rateLimit: RateLimitInfo | null): number {
  if (!rateLimit) return 3
  const remaining = rateLimit.remainingPerMinute
  if (remaining <= 5) return 1
  if (remaining <= 20) return 3
  if (remaining <= 50) return 5
  return 10
}

function computeWaitTime(rateLimit: RateLimitInfo): number {
  if (rateLimit.retryAfterSeconds !== undefined) {
    return rateLimit.retryAfterSeconds * 1000
  }
  if (rateLimit.resetMinute) {
    const resetTime = new Date(rateLimit.resetMinute).getTime()
    const now = Date.now()
    const waitMs = resetTime - now + 500
    if (waitMs > 0) return waitMs
  }
  return 5000
}

interface ForeachOptions {
  step: ForeachStep
  items: unknown[]
  ctx: ExecutionContext
  clientOptions: ApiClientOptions
  currentRateLimit: RateLimitInfo | null
}

async function executeForeach(options: ForeachOptions): Promise<ForeachResult> {
  const { step, items, ctx, clientOptions, currentRateLimit } = options
  const startedAt = new Date()

  if (items.length === 0) {
    const completedAt = new Date()
    return {
      stepId: step.id,
      data: [],
      rateLimit: currentRateLimit,
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
      items: [],
      failures: [],
    }
  }

  let concurrency = deriveConcurrency(currentRateLimit)
  let latestRateLimit = currentRateLimit
  const successItems: unknown[] = []
  const failures: ForeachFailure[] = []
  let rateLimitPaused = false
  let totalWaitedMs = 0

  let offset = 0
  while (offset < items.length) {
    // Check if we need to wait for rate limit reset
    if (latestRateLimit && latestRateLimit.remainingPerMinute <= 2) {
      rateLimitPaused = true
      const waitMs = computeWaitTime(latestRateLimit)
      totalWaitedMs += waitMs
      await sleep(waitMs)
    }

    const batch = items.slice(offset, offset + concurrency)
    offset += batch.length

    const batchPromises = batch.map(async (item) => {
      const { path } = resolveEndpoint(step.endpoint, ctx, item)
      const resolvedParams = flattenParams(step.params, ctx, item)

      try {
        const response = await get(path, resolvedParams, clientOptions)
        return { success: true as const, data: response.data, rateLimit: response.rateLimit }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        return { success: false as const, item, error, status }
      }
    })

    const batchResults = await Promise.all(batchPromises)

    for (const result of batchResults) {
      if (result.success) {
        successItems.push(result.data)
        if (result.rateLimit) {
          latestRateLimit = result.rateLimit
        }
      } else {
        failures.push({
          item: result.item,
          error: result.error,
          status: result.status,
        })
      }
    }

    // Recalculate concurrency based on latest rate limit info
    concurrency = deriveConcurrency(latestRateLimit)
  }

  const completedAt = new Date()

  return {
    stepId: step.id,
    data: successItems,
    rateLimit: latestRateLimit,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(rateLimitPaused ? { rateLimitPaused: true, waitedMs: totalWaitedMs } : {}),
    },
    items: successItems,
    failures,
  }
}

// -- Recipe execution --

function validateRequiredParams(
  recipe: Recipe,
  provided: Record<string, string>,
): void {
  if (!recipe.params) return

  const missing: string[] = []
  for (const [name, param] of Object.entries(recipe.params)) {
    if (param.required && param.default === undefined && !(name in provided)) {
      missing.push(name)
    }
  }

  if (missing.length > 0) {
    throw new CliError(
      `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      'MISSING_PARAMS',
    )
  }
}

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

function validateResumeInput(
  input: Record<string, unknown>,
  returns: Record<string, string>,
  stepId: string,
): void {
  const missing: string[] = []
  for (const key of Object.keys(returns)) {
    if (!(key in input)) {
      missing.push(key)
    }
  }
  if (missing.length > 0) {
    throw new CliError(
      `--input is missing required fields for step "${stepId}": ${missing.join(', ')}. Expected: ${JSON.stringify(returns)}`,
      'INVALID_RESUME_INPUT',
    )
  }

  // Type checking: verify arrays are arrays
  for (const [key, expectedType] of Object.entries(returns)) {
    const value = input[key]
    if (expectedType.endsWith('[]') && !Array.isArray(value)) {
      throw new CliError(
        `--input field "${key}" should be an array (${expectedType}), got ${typeof value}`,
        'INVALID_RESUME_INPUT',
      )
    }
  }
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
      if (!resumeInput) {
        throw new CliError(
          `--input is required when resuming from agent step "${stepId}"`,
          'INVALID_RESUME_INPUT',
        )
      }
      validateResumeInput(resumeInput, segment.precedingAgentStep.returns, stepId)
      return {
        segmentIndex: segment.index,
        agentInput: resumeInput,
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

  if (isForeachStep(step)) {
    const sourceData = resolveValue(`{${step.foreach}}`, ctx)
    if (sourceData === undefined || sourceData === null) {
      throw new CliError(
        `Foreach step "${step.id}": source "${step.foreach}" resolved to ${String(sourceData)}`,
        'FOREACH_SOURCE_MISSING',
      )
    }
    if (!Array.isArray(sourceData)) {
      throw new CliError(
        `Foreach step "${step.id}": source "${step.foreach}" resolved to ${typeof sourceData}, expected array`,
        'FOREACH_SOURCE_NOT_ARRAY',
      )
    }

    return executeForeach({
      step,
      items: sourceData,
      ctx,
      clientOptions,
      currentRateLimit: ctx.currentRateLimit,
    })
  }

  const { path } = resolveEndpoint(
    isAgentStep(step) ? '' : step.endpoint,
    ctx,
  )

  const resolvedParams = !isAgentStep(step) ? flattenParams(step.params, ctx) : {}

  let response
  try {
    response = await get(path, resolvedParams, clientOptions)
  } catch (err) {
    if (err instanceof CliError) {
      err.message = `Step "${step.id}" failed: ${err.message}`
      throw err
    }
    throw new CliError(
      `Step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
      'STEP_EXECUTION_FAILED',
    )
  }

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
  recipeSource?: string,
): RecipeAwaitingAgent {
  const data: Record<string, unknown> = {}
  for (const ref of agentStep.context) {
    const result = ctx.results.get(ref)
    if (result) {
      data[ref] = result.data
    }
  }

  const sourcePart = recipeSource ?? ''
  const stdinFlag = recipeSource ? '' : '--stdin'
  const paramParts = Object.entries(originalParams)
    .map(([k, v]) => {
      const escaped = v.replace(/'/g, "'\\''")
      return `--${k} '${escaped}'`
    })
    .join(' ')
  const parts = [
    'aixbt recipe run',
    sourcePart,
    stdinFlag,
    `--resume-from step:${agentStep.id}`,
    "--input '<agent_output_json>'",
    paramParts,
  ].filter(Boolean)
  const resumeCommand = parts.join(' ')

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
    try {
      mkdirSync(outputDir, { recursive: true })
      let fileIndex = 1
      for (const [stepId, result] of ctx.results) {
        const filename = `segment-${String(fileIndex).padStart(3, '0')}.json`
        const filePath = join(outputDir, filename)
        writeFileSync(filePath, JSON.stringify(result.data, null, 2))
        data[stepId] = { dataFile: filePath }
        fileIndex++
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`warn: Failed to write output files to ${outputDir}: ${detail}. Falling back to inline data.`)
      for (const [stepId, result] of ctx.results) {
        data[stepId] = result.data
      }
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
  recipeSource?: string
}): Promise<RecipeAwaitingAgent | RecipeComplete> {
  const recipe = parseRecipe(options.yaml)
  validateRecipe(recipe)
  validateRequiredParams(recipe, options.params)
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
        return buildAwaitingAgentOutput(ctx, step, options.params, options.recipeSource)
      }

      const result = await executeStep(step, ctx, options.clientOptions)
      ctx.results.set(step.id, result)
      ctx.currentRateLimit = result.rateLimit
    }
  }

  return buildCompleteOutput(ctx, options.outputDir)
}
