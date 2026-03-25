import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { encode } from '@toon-format/toon'
import type {
  ExecutionContext, AgentStep, ForeachResult,
  RecipeAwaitingAgent, RecipeComplete, ParallelAgentMeta,
  RecipeYieldProgress,
} from '../../types.js'
import { isApiStep, isAgentStep, hasForModifier } from '../../types.js'
import { resolveValue, resolveExpression } from './template.js'
import { resolveContextHints } from '../agents/context.js'
import { estimateTokenCount } from '../tokens.js'

/** Collect _fallbackNote entries from foreach results into a single notes object. */
function collectFallbackNotes(
  ctx: ExecutionContext,
  stepIds: string[],
): Record<string, string> | undefined {
  const notes: Record<string, string> = {}
  for (const stepId of stepIds) {
    const result = ctx.results.get(stepId) as ForeachResult | undefined
    if (result?._fallbackNote) {
      notes[stepId] = result._fallbackNote
    }
  }
  return Object.keys(notes).length > 0 ? notes : undefined
}

export function buildProgressAndRemaining(
  ctx: ExecutionContext,
): { progress: RecipeYieldProgress; remaining: string } {
  const progress: RecipeYieldProgress = {
    stepsCompleted: ctx.results.size,
    stepsTotal: ctx.recipe.steps.length,
    segmentIndex: ctx.currentSegmentIndex,
    segmentsTotal: ctx.segments.length,
  }

  // Check if there are remaining segments after the current one
  const remainingSegments = ctx.segments.slice(ctx.currentSegmentIndex + 1)

  if (remainingSegments.length === 0) {
    return {
      progress,
      remaining: 'This is the final agent step. No remaining steps.',
    }
  }

  // Count remaining steps by type across all remaining segments
  let apiCount = 0
  let agentCount = 0
  const stepIds: string[] = []

  for (const segment of remainingSegments) {
    for (const step of segment.steps) {
      if (isAgentStep(step)) {
        agentCount++
      } else {
        apiCount++
      }
      stepIds.push(step.id)
    }
  }

  // Build prose description
  const parts: string[] = []
  if (apiCount > 0) {
    parts.push(`${apiCount} API step${apiCount > 1 ? 's' : ''} (${stepIds.filter((id) => {
      const step = ctx.recipe.steps.find((s) => s.id === id)
      return step && !isAgentStep(step)
    }).join(', ')})`)
  }
  if (agentCount > 0) {
    parts.push(`${agentCount} agent step${agentCount > 1 ? 's' : ''} (${stepIds.filter((id) => {
      const step = ctx.recipe.steps.find((s) => s.id === id)
      return step && isAgentStep(step)
    }).join(', ')})`)
  }

  const remaining = `Data assembled (raw). Remaining: ${parts.join(' and ')} to produce: ${ctx.recipe.description}`

  return { progress, remaining }
}

export function buildAwaitingAgentOutput(
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
  const fallbackNotes = collectFallbackNotes(ctx, agentStep.context)
  if (fallbackNotes) {
    data._fallbackNotes = fallbackNotes
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

  const contextHints = resolveContextHints(ctx.recipe.steps, ctx.results)
  const { progress, remaining } = buildProgressAndRemaining(ctx)

  return {
    status: 'awaiting_agent',
    recipe: ctx.recipe.name,
    version: ctx.recipe.version,
    step: agentStep.id,
    instructions: agentStep.instructions,
    returns: agentStep.returns,
    data,
    tokenCount: estimateTokenCount(data),
    resumeCommand,
    progress,
    remaining,
    ...(contextHints.length > 0 ? { contextHints } : {}),
  }
}

export function buildAwaitingParallelAgentOutput(
  ctx: ExecutionContext,
  agentStep: AgentStep & { 'for': string },
  originalParams: Record<string, string>,
  recipeSource?: string,
): RecipeAwaitingAgent {
  // Resolve for: items
  const resolved = resolveExpression(agentStep['for'], ctx)
  const items = Array.isArray(resolved) ? resolved : []

  // Classify context steps as per-item vs shared
  const perItemContext: string[] = []
  const sharedContext: string[] = []

  for (const ref of agentStep.context) {
    const refStep = ctx.recipe.steps.find((s) => s.id === ref)
    if (refStep && isApiStep(refStep) && hasForModifier(refStep) && refStep['for'] === agentStep['for']) {
      perItemContext.push(ref)
    } else {
      sharedContext.push(ref)
    }
  }

  // Collect context data (same as regular agent output)
  const data: Record<string, unknown> = {}
  for (const ref of agentStep.context) {
    const result = ctx.results.get(ref)
    if (result) {
      data[ref] = result.data
    }
  }
  const fallbackNotes = collectFallbackNotes(ctx, agentStep.context)
  if (fallbackNotes) {
    data._fallbackNotes = fallbackNotes
  }

  // Build the regular awaiting output fields
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

  const parallel: ParallelAgentMeta = {
    items: items ?? [],
    itemKey: agentStep['for'],
    concurrency: 3,
    perItemContext,
    sharedContext,
  }

  const itemCount = (items ?? []).length
  const returnsKeys = Object.entries(agentStep.returns)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')

  const parallelExecution = [
    `This is a parallel step. Run the instructions once for EACH of the ${itemCount} items in parallel.items.\n`,
    `\nFor each item at index i:\n`,
    `- The item itself is parallel.items[i]\n`,
    perItemContext.length > 0
      ? `- Per-item context (sliced by position — item[i] gets data.${perItemContext[0]}[i], etc.): ${perItemContext.join(', ')}\n`
      : '',
    sharedContext.length > 0
      ? `- Shared context (same data for all items): ${sharedContext.join(', ')}\n`
      : '',
    `- Each result must match the returns schema: { ${returnsKeys} }\n`,
    `\nExecution strategy:\n`,
    `- PREFERRED: Spawn ${parallel.concurrency} sub-agents in parallel, each handling one item with its sliced context. This keeps each agent focused and improves quality.\n`,
    `- FALLBACK: If sub-agents are not available, process items sequentially inline — iterate over parallel.items and run the instructions for each.\n`,
    `\nResume: Wrap all results in { "_results": [result0, result1, ...] } and pass to --input. The array order should correspond to parallel.items order.`,
  ].join('')

  const contextHints = resolveContextHints(ctx.recipe.steps, ctx.results)
  const { progress, remaining } = buildProgressAndRemaining(ctx)

  return {
    status: 'awaiting_agent',
    recipe: ctx.recipe.name,
    version: ctx.recipe.version,
    step: agentStep.id,
    instructions: agentStep.instructions,
    returns: agentStep.returns,
    data,
    tokenCount: estimateTokenCount(data),
    resumeCommand,
    progress,
    remaining,
    parallel,
    parallelExecution,
    ...(contextHints.length > 0 ? { contextHints } : {}),
  }
}

export function buildCompleteOutput(
  ctx: ExecutionContext,
  outputDir?: string,
  outputFormat?: string,
): RecipeComplete {
  const data: Record<string, unknown> = {}

  if (outputDir) {
    const useToon = outputFormat === 'toon'
    const ext = useToon ? 'toon' : 'json'
    try {
      mkdirSync(outputDir, { recursive: true })
      let fileIndex = 1
      for (const [stepId, result] of ctx.results) {
        const filename = `segment-${String(fileIndex).padStart(3, '0')}.${ext}`
        const filePath = join(outputDir, filename)
        const content = useToon ? encode(result.data) : JSON.stringify(result.data, null, 2)
        writeFileSync(filePath, content)
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

  const allStepIds = [...ctx.results.keys()]
  const fallbackNotes = collectFallbackNotes(ctx, allStepIds)
  if (fallbackNotes) {
    data._fallbackNotes = fallbackNotes
  }

  const contextHints = resolveContextHints(ctx.recipe.steps, ctx.results)

  return {
    status: 'complete',
    recipe: ctx.recipe.name,
    version: ctx.recipe.version,
    timestamp: new Date().toISOString(),
    data,
    tokenCount: estimateTokenCount(data),
    hints: ctx.recipe.hints,
    analysis: ctx.recipe.analysis
      ? resolveValue(ctx.recipe.analysis, ctx) as RecipeComplete['analysis']
      : undefined,
    ...(contextHints.length > 0 ? { contextHints } : {}),
  }
}
