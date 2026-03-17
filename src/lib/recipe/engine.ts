import type {
  ExecutionContext, RecipeStep, StepResult,
  RecipeAwaitingAgent, RecipeComplete, Recipe,
  RateLimitInfo, TransformBlock,
} from '../../types.js'
import { isAgentStep, isApiStep, isForeachStep, isTransformStep } from '../../types.js'
import { applyTransforms } from '../transforms.js'
import { parseRecipe } from './parser.js'
import { validateRecipe, buildSegments } from './validator.js'
import { get, type ApiClientOptions } from '../api-client.js'
import { CliError } from '../errors.js'
import { resolveValue, resolveActionPath, flattenParams } from './template.js'
import { executeForeach } from './foreach.js'
import { paginateApiStep, MAX_PAGE_LIMIT } from './pagination.js'
import { buildAwaitingAgentOutput, buildCompleteOutput } from './output.js'
import { dispatchProviderStep } from '../providers/client.js'
import { getProvider } from '../providers/registry.js'
import { resolveProviderKey } from '../providers/config.js'
import { AIXBT_ACTION_PATHS } from '../providers/aixbt.js'
import { TIER_RANK } from '../providers/types.js'
import type { ProviderTier } from '../providers/types.js'

// Re-export public API for backward compatibility
export { resolveValue, resolveActionPath, resolveRelativeTime } from './template.js'
export { applyTransforms } from '../transforms.js'

// -- Fallback helpers --

const FALLBACK_ERROR_CODES = new Set(['TIER_INSUFFICIENT', 'MISSING_PROVIDER_KEY'])

function isProviderUnavailableError(err: unknown): err is CliError {
  return err instanceof CliError && FALLBACK_ERROR_CODES.has(err.code)
}

function buildFallbackResult(
  stepId: string,
  fallback: string,
  source: string,
  startedAt: Date,
): StepResult {
  const completedAt = new Date()
  const message =
    `Step "${stepId}" was skipped — no ${source} API key configured. ` +
    `Use your available tools to resolve: ${fallback}`

  return {
    stepId,
    data: { _fallback: true, message },
    rateLimit: null,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    },
  }
}

// -- Param validation --

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

function emitTierWarnings(recipe: Recipe): void {
  for (const step of recipe.steps) {
    if (!isApiStep(step) && !isForeachStep(step)) continue
    const source = step.source
    if (!source || source === 'aixbt') continue

    let provider
    try { provider = getProvider(source) } catch { continue }

    const action = provider.actions[step.action]
    if (!action || action.minTier === 'free') continue

    const resolved = resolveProviderKey(source)
    const effectiveTier: ProviderTier = resolved?.tier ?? 'free'

    if (TIER_RANK[effectiveTier] < TIER_RANK[action.minTier]) {
      const suffix = step.fallback ? ' (has fallback, will degrade gracefully)' : ''
      console.error(
        `warning: step "${step.id}" uses ${source}:${step.action} (requires ${action.minTier} tier, current: ${effectiveTier})${suffix}`,
      )
    }
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

// -- Resume helpers --

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

// -- Step execution --

async function executeStep(
  step: RecipeStep,
  ctx: ExecutionContext,
  clientOptions: ApiClientOptions,
): Promise<StepResult> {
  const startedAt = new Date()

  if (isForeachStep(step)) {
    // Check provider availability before iterating — avoid N failed calls
    if (step.source && step.source !== 'aixbt') {
      try {
        const provider = getProvider(step.source)
        const action = provider.actions[step.action]
        if (action && action.minTier !== 'free') {
          const resolved = resolveProviderKey(step.source)
          const effectiveTier: ProviderTier = resolved?.tier ?? 'free'
          if (TIER_RANK[effectiveTier] < TIER_RANK[action.minTier]) {
            if (step.fallback) {
              const resolvedFallback = resolveValue(step.fallback, ctx) as string
              console.error(`warning: step "${step.id}" skipped (TIER_INSUFFICIENT), using fallback`)
              return buildFallbackResult(step.id, resolvedFallback, step.source, startedAt)
            }
            console.error(`warning: step "${step.id}" skipped (TIER_INSUFFICIENT), no fallback defined`)
            return buildFallbackResult(step.id, '', step.source, startedAt)
          }
        }
      } catch {
        // Provider not found — let executeForeach handle it
      }
    }

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

  if (isTransformStep(step)) {
    const sourceResult = ctx.results.get(step.input)
    if (!sourceResult) {
      throw new CliError(
        `Transform step "${step.id}": input step "${step.input}" has no result`,
        'TRANSFORM_INPUT_MISSING',
      )
    }

    const transformedData = applyTransforms(sourceResult.data, step.transform)
    const completedAt = new Date()

    return {
      stepId: step.id,
      data: transformedData,
      rateLimit: null,
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    }
  }

  let resultData: unknown
  let resultRateLimit: RateLimitInfo | null = null
  let rateLimitPaused = false
  let waitedMs = 0

  // External provider dispatch
  if (isApiStep(step) && step.source && step.source !== 'aixbt') {
    try {
      resultData = await dispatchProviderStep(step.source, step.action, step.params, ctx)
    } catch (err) {
      if (isProviderUnavailableError(err)) {
        if (step.fallback) {
          const resolved = resolveValue(step.fallback, ctx) as string
          console.error(`warning: step "${step.id}" skipped (${err.code}), using fallback`)
          return buildFallbackResult(step.id, resolved, step.source, startedAt)
        }
        console.error(`warning: step "${step.id}" skipped (${err.code}), no fallback defined`)
        return buildFallbackResult(step.id, '', step.source, startedAt)
      }
      if (err instanceof CliError) {
        err.message = `Step "${step.id}" failed: ${err.message}`
        throw err
      }
      throw new CliError(
        `Step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
        'STEP_EXECUTION_FAILED',
      )
    }
  } else {
    // AIXBT path — use existing resolveActionPath() + get()
    let actionPath: string
    if (isAgentStep(step)) {
      actionPath = ''
    } else if (AIXBT_ACTION_PATHS[step.action]) {
      actionPath = AIXBT_ACTION_PATHS[step.action]
    } else {
      actionPath = step.action
    }
    const { path } = resolveActionPath(actionPath, ctx)

    const resolvedParams = !isAgentStep(step) ? flattenParams(step.params, ctx) : {}

    // Determine if pagination is needed
    const resolvedLimit = resolvedParams.limit !== undefined
      ? Number(resolvedParams.limit)
      : undefined
    const shouldPaginate = resolvedLimit !== undefined
      && Number.isFinite(resolvedLimit)
      && resolvedLimit > MAX_PAGE_LIMIT

    if (shouldPaginate) {
      const paginationResult = await paginateApiStep({
        path,
        baseParams: resolvedParams,
        targetLimit: resolvedLimit,
        stepId: step.id,
        clientOptions,
        currentRateLimit: ctx.currentRateLimit,
      })

      resultData = paginationResult.data
      resultRateLimit = paginationResult.rateLimit
      rateLimitPaused = paginationResult.rateLimitPaused
      waitedMs = paginationResult.waitedMs
    } else {
      try {
        const response = await get(path, resolvedParams, clientOptions)
        resultData = response.data
        resultRateLimit = response.rateLimit
      } catch (err) {
        if (err instanceof CliError) {
          // Re-throw to preserve subclass types (PaymentRequiredError, RateLimitError)
          err.message = `Step "${step.id}" failed: ${err.message}`
          throw err
        }
        throw new CliError(
          `Step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
          'STEP_EXECUTION_FAILED',
        )
      }
    }
  }

  if (isApiStep(step) && step.transform) {
    resultData = applyTransforms(resultData, step.transform)
  }

  const completedAt = new Date()

  return {
    stepId: step.id,
    data: resultData,
    rateLimit: resultRateLimit,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(rateLimitPaused ? { rateLimitPaused: true, waitedMs } : {}),
    },
  }
}

// -- Main entry point --

export async function executeRecipe(options: {
  yaml: string
  params: Record<string, string>
  clientOptions: ApiClientOptions
  resumeFromStep?: string
  resumeInput?: Record<string, unknown>
  outputDir?: string
  outputFormat?: string
  recipeSource?: string
}): Promise<RecipeAwaitingAgent | RecipeComplete> {
  const recipe = parseRecipe(options.yaml)
  validateRecipe(recipe)
  validateRequiredParams(recipe, options.params)
  emitTierWarnings(recipe)
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

  return buildCompleteOutput(ctx, options.outputDir, options.outputFormat)
}
