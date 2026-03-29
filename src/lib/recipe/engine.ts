import type {
  ExecutionContext, RecipeStep, StepResult,
  RecipeAwaitingAgent, RecipeComplete, Recipe,
  RateLimitInfo,
} from '../../types.js'
import { isAgentStep, isParallelAgentStep, isApiStep, hasForModifier } from '../../types.js'
import { applyTransforms } from '../transforms.js'
import { parseRecipe } from './parser.js'
import { validateRecipe, buildSegments, extractStepReferences } from './validator.js'
import { get, type ApiClientOptions } from '../api-client.js'
import { CliError } from '../errors.js'
import { resolveValue, resolveActionPath, flattenParams, substitutePathParams } from './template.js'
import { executeForeach, type ForeachProgressEvent } from './foreach.js'
export type { ForeachProgressEvent } from './foreach.js'
import { paginateApiStep, MAX_PAGE_LIMIT } from './pagination.js'
import { buildAwaitingAgentOutput, buildAwaitingParallelAgentOutput, buildCompleteOutput } from './output.js'
import { dispatchProviderStep } from '../providers/client.js'
import { getProvider, parseSource } from '../providers/registry.js'
import { resolveProviderKey } from '../providers/config.js'
import { AIXBT_ACTION_PATHS } from '../providers/aixbt.js'
import { isTierSufficient } from '../providers/types.js'
import type { ForeachResult } from '../../types.js'
import { estimateTokenCount } from '../tokens.js'

// Re-export public API for backward compatibility
export { resolveValue, resolveActionPath } from './template.js'
export { resolveRelativeTime } from '../date.js'
export { applyTransforms } from '../transforms.js'

// -- Debug logging --

function debugStepLog(verbosity: number, result: StepResult, step: RecipeStep, parallel?: boolean): void {
  if (verbosity < 1) return

  const ms = result.timing.durationMs
  const tokens = estimateTokenCount(result.data)
  const tokensStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)

  const parts: string[] = [
    `[v] ${result.stepId.padEnd(24)}`,
    `${String(ms).padStart(6)}ms`,
    `${tokensStr.padStart(7)} tok`,
  ]

  // Step type tag
  if (isApiStep(step) && hasForModifier(step)) {
    const fr = result as ForeachResult
    const itemCount = fr.items?.length ?? 0
    const failCount = fr.failures?.length ?? 0
    if (verbosity >= 2) {
      const fallbackCount = fr.items?.filter(
        (i): i is Record<string, unknown> => typeof i === 'object' && i !== null && (i as Record<string, unknown>)._fallback === true,
      ).length ?? 0
      const okCount = itemCount - fallbackCount
      const detail = [
        `${okCount} ok`,
        ...(fallbackCount > 0 ? [`${fallbackCount} fallback`] : []),
        ...(failCount > 0 ? [`${failCount} failed`] : []),
      ].join(', ')
      parts.push(`for(${itemCount + failCount}: ${detail})`)
    } else {
      parts.push(`for(${itemCount}${failCount > 0 ? `, ${failCount} failed` : ''})`)
    }
  } else if (isApiStep(step) && step.source && step.source !== 'aixbt') {
    parts.push(step.source)
  }

  if (parallel) parts.push('‖')

  // -v: rate limit pauses
  if (result.timing.rateLimitPaused) {
    parts.push(`waited ${result.timing.waitedMs}ms`)
  }

  // -v: sample info
  if (result.sampled) {
    parts.push(`sampled ${result.sampled.before}→${result.sampled.after}`)
  }

  // -vv: source:action and for source
  if (verbosity >= 2) {
    if (isApiStep(step)) {
      const source = step.source ?? 'aixbt'
      parts.push(`${source}:${step.action}`)
    }
    if (hasForModifier(step)) {
      parts.push(`over ${step['for']}`)
    }
  }

  // -vvv: data shape and byte size
  if (verbosity >= 3) {
    const json = JSON.stringify(result.data)
    const bytes = Buffer.byteLength(json)
    const sizeStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`
    let shape: string
    if (Array.isArray(result.data)) {
      shape = `[${result.data.length}]`
    } else if (typeof result.data === 'object' && result.data !== null) {
      shape = `{${Object.keys(result.data as Record<string, unknown>).join(',')}}`
    } else {
      shape = typeof result.data
    }
    parts.push(`${sizeStr}  ${shape}`)
  }

  process.stderr.write(parts.join('  ') + '\n')
}

function debugSegmentLog(verbosity: number, segmentIndex: number, totalMs: number): void {
  if (verbosity < 1) return
  process.stderr.write(`[v] --- segment ${segmentIndex + 1} complete  ${totalMs}ms ---\n`)
}

// -- Fallback helpers --

const FALLBACK_ERROR_CODES = new Set(['TIER_INSUFFICIENT', 'MISSING_PROVIDER_KEY', 'ACTION_UNRESOLVABLE'])

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
  const message = fallback
    ? `Step "${stepId}" was skipped — no ${source} API key configured — ${fallback}`
    : `Step "${stepId}" was skipped — no ${source} API key configured.`

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

  // Validate requiredOneOf: exactly one param from the group must be provided
  if (recipe.requiredOneOf) {
    const supplied = recipe.requiredOneOf.filter(name => name in provided)
    if (supplied.length === 0) {
      throw new CliError(
        `Provide exactly one of: ${recipe.requiredOneOf.join(', ')}`,
        'MISSING_PARAMS',
      )
    }
    if (supplied.length > 1) {
      throw new CliError(
        `Provide exactly one of: ${recipe.requiredOneOf.join(', ')} (got: ${supplied.join(', ')})`,
        'CONFLICTING_PARAMS',
      )
    }
  }
}

function emitTierWarnings(recipe: Recipe): void {
  for (const step of recipe.steps) {
    if (!isApiStep(step)) continue
    const rawSource = step.source
    if (!rawSource || rawSource === 'aixbt') continue
    const { providerName: source } = parseSource(rawSource)

    let provider
    try { provider = getProvider(source) } catch (err) {
      if (err instanceof CliError && err.code === 'UNKNOWN_PROVIDER') continue
      throw err
    }

    const action = provider.actions[step.action]
    if (!action || action.minTier === 'free') continue

    const resolved = resolveProviderKey(provider)
    const effectiveTier = resolved?.tier ?? 'free'

    if (!isTierSufficient(provider, effectiveTier, action.minTier)) {
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
      // Parallel agent steps use { _results: [...] } wrapping — skip returns validation
      if (!isParallelAgentStep(segment.precedingAgentStep)) {
        validateResumeInput(resumeInput, segment.precedingAgentStep.returns, stepId)
      }
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

// -- Parallel execution helpers --

/**
 * Group segment steps into dependency layers for parallel execution.
 * Steps in the same layer have no interdependencies and can run concurrently.
 * Agent steps are always isolated in their own layer.
 */
function buildExecutionLayers(
  steps: RecipeStep[],
  alreadyCompleted: Set<string>,
): RecipeStep[][] {
  const layers: RecipeStep[][] = []
  const completed = new Set(alreadyCompleted)
  const pending = new Set(steps.map(s => s.id))
  const stepMap = new Map(steps.map(s => [s.id, s]))
  const orderedIds = steps.map(s => s.id)

  while (pending.size > 0) {
    const layer: RecipeStep[] = []

    for (const id of orderedIds) {
      if (!pending.has(id)) continue
      const step = stepMap.get(id)!

      // Agent steps must be alone in their layer
      if (isAgentStep(step)) {
        if (layer.length === 0) layer.push(step)
        break
      }

      const deps = extractStepReferences(step)
      if ([...deps].every(d => completed.has(d))) {
        layer.push(step)
      }
    }

    if (layer.length === 0) {
      throw new CliError('Circular dependency detected in recipe steps', 'CIRCULAR_DEPENDENCY')
    }

    for (const step of layer) {
      pending.delete(step.id)
      completed.add(step.id)
    }

    layers.push(layer)
  }

  return layers
}

/**
 * After parallel execution, pick the most conservative rate limit
 * (lowest remainingPerMinute) so subsequent steps don't overshoot.
 */
function mergeRateLimits(limits: (RateLimitInfo | null)[]): RateLimitInfo | null {
  const valid = limits.filter((l): l is RateLimitInfo => l !== null)
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0]
  return valid.reduce((a, b) =>
    a.remainingPerMinute <= b.remainingPerMinute ? a : b,
  )
}

// -- Step execution --

async function executeStep(
  step: RecipeStep,
  ctx: ExecutionContext,
  clientOptions: ApiClientOptions,
  onProgress?: (event: ForeachProgressEvent) => void,
): Promise<StepResult> {
  const startedAt = new Date()

  // API step with for: modifier → foreach execution
  if (isApiStep(step) && hasForModifier(step)) {
    // Check provider availability before iterating — avoid N failed calls
    if (step.source && step.source !== 'aixbt') {
      try {
        const { providerName } = parseSource(step.source)
        const provider = getProvider(providerName)
        const action = provider.actions[step.action]
        if (action && action.minTier !== 'free') {
          const resolved = resolveProviderKey(provider)
          const effectiveTier = resolved?.tier ?? 'free'
          if (!isTierSufficient(provider, effectiveTier, action.minTier)) {
            if (step.fallback) {
              const resolvedFallback = resolveValue(step.fallback, ctx) as string
              console.error(`warning: step "${step.id}" skipped (TIER_INSUFFICIENT), using fallback`)
              return buildFallbackResult(step.id, resolvedFallback, step.source, startedAt)
            }
            console.error(`warning: step "${step.id}" skipped (TIER_INSUFFICIENT), no fallback defined`)
            return buildFallbackResult(step.id, '', step.source, startedAt)
          }
        }
      } catch (err) {
        if (err instanceof CliError && err.code === 'UNKNOWN_PROVIDER') {
          // Provider not found — let executeForeach handle it
        } else {
          throw err
        }
      }
    }

    const sourceData = resolveValue(`{${step['for']}}`, ctx)
    if (sourceData === undefined || sourceData === null) {
      throw new CliError(
        `Step "${step.id}": for: "${step['for']}" resolved to ${String(sourceData)}`,
        'FOREACH_SOURCE_MISSING',
      )
    }
    if (!Array.isArray(sourceData)) {
      throw new CliError(
        `Step "${step.id}": for: "${step['for']}" resolved to ${typeof sourceData}, expected array`,
        'FOREACH_SOURCE_NOT_ARRAY',
      )
    }

    return executeForeach({
      step,
      items: sourceData,
      ctx,
      clientOptions,
      currentRateLimit: ctx.currentRateLimit,
      onProgress,
    })
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
    const resolvedParams = !isAgentStep(step) ? flattenParams(step.params, ctx) : {}
    const substitutedPath = substitutePathParams(actionPath, resolvedParams)
    const { path } = resolveActionPath(substitutedPath, ctx)

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

  let sampled: { before: number; after: number; weightedBy: string } | undefined
  if (isApiStep(step) && step.transform) {
    const result = applyTransforms(resultData, step.transform, { meta: true })
    resultData = result.data
    sampled = result.meta.sampled
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
    ...(sampled ? { sampled } : {}),
  }
}

// -- Carry-forward computation --

/**
 * Scan downstream consumers (agent steps in later segments + analysis block)
 * and collect pre-yield step results that they reference in their context arrays.
 * Returns a map of stepId -> data for results that exist in ctx.results.
 */
function computeCarryForward(ctx: ExecutionContext): Record<string, unknown> {
  const neededStepIds = new Set<string>()

  // Collect context refs from all remaining segments' agent steps
  for (let i = ctx.currentSegmentIndex + 1; i < ctx.segments.length; i++) {
    for (const step of ctx.segments[i].steps) {
      if (isAgentStep(step)) {
        for (const ref of step.context) {
          neededStepIds.add(ref)
        }
      }
    }
  }

  // Collect context refs from the analysis block
  if (ctx.recipe.analysis?.context) {
    for (const ref of ctx.recipe.analysis.context) {
      neededStepIds.add(ref)
    }
  }

  // Filter to only step results that actually exist in ctx.results right now
  // (these are the pre-yield results that would be lost on resume)
  const carryForward: Record<string, unknown> = {}
  for (const stepId of neededStepIds) {
    const result = ctx.results.get(stepId)
    if (result) {
      carryForward[stepId] = result.data
    }
  }

  return carryForward
}

// -- Main entry point --

export async function executeRecipe(options: {
  yaml: string
  params: Record<string, string>
  clientOptions: ApiClientOptions
  resumeFromStep?: string
  resumeInput?: Record<string, unknown>
  carryForward?: Record<string, unknown>
  outputDir?: string
  outputFormat?: string
  recipeSource?: string
  onProgress?: (event: ForeachProgressEvent) => void
  verbosity?: number
}): Promise<RecipeAwaitingAgent | RecipeComplete> {
  const verbosity = options.verbosity ?? 0
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

  // Restore carry-forward data from previous yield
  if (options.carryForward) {
    for (const [stepId, data] of Object.entries(options.carryForward)) {
      ctx.results.set(stepId, {
        stepId,
        data,
        rateLimit: null,
        timing: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        },
      })
    }
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
      // Parallel agent results come wrapped as { _results: [...] }
      const data = isParallelAgentStep(segment.precedingAgentStep) && ctx.agentInput._results
        ? ctx.agentInput._results
        : ctx.agentInput
      ctx.results.set(segment.precedingAgentStep.id, {
        stepId: segment.precedingAgentStep.id,
        data,
        rateLimit: null,
        timing: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        },
      })
      ctx.agentInput = null
    }

    const segmentStart = Date.now()
    const layers = buildExecutionLayers(segment.steps, new Set(ctx.results.keys()))

    for (const layer of layers) {
      // Agent steps are always alone in their layer
      if (layer.length === 1 && isParallelAgentStep(layer[0])) {
        const carryForward = computeCarryForward(ctx)
        return buildAwaitingParallelAgentOutput(ctx, layer[0], options.params, options.recipeSource, carryForward)
      }
      if (layer.length === 1 && isAgentStep(layer[0])) {
        const carryForward = computeCarryForward(ctx)
        return buildAwaitingAgentOutput(ctx, layer[0], options.params, options.recipeSource, carryForward)
      }

      if (layer.length === 1) {
        const step = layer[0]
        const result = await executeStep(step, ctx, options.clientOptions, options.onProgress)
        ctx.results.set(step.id, result)
        ctx.currentRateLimit = result.rateLimit
        debugStepLog(verbosity, result, step)
      } else {
        const results = await Promise.all(
          layer.map(step => executeStep(step, ctx, options.clientOptions, options.onProgress)),
        )
        // Store in recipe-declared order (layer preserves recipe order)
        for (let j = 0; j < layer.length; j++) {
          ctx.results.set(layer[j].id, results[j])
          debugStepLog(verbosity, results[j], layer[j], true)
        }
        ctx.currentRateLimit = mergeRateLimits(results.map(r => r.rateLimit))
      }
    }

    debugSegmentLog(verbosity, i, Date.now() - segmentStart)
  }

  return buildCompleteOutput(ctx, options.outputDir, options.outputFormat)
}
