import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { encode } from '@toon-format/toon'
import type {
  ExecutionContext, AgentStep, ForeachResult,
  RecipeAwaitingAgent, RecipeComplete, ParallelAgentMeta,
} from '../../types.js'
import { isForeachStep } from '../../types.js'
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
    ...(contextHints.length > 0 ? { contextHints } : {}),
  }
}

export function buildAwaitingParallelAgentOutput(
  ctx: ExecutionContext,
  agentStep: AgentStep & { foreach: string },
  originalParams: Record<string, string>,
  recipeSource?: string,
): RecipeAwaitingAgent {
  // Resolve foreach items
  const items = resolveExpression(agentStep.foreach, ctx) as unknown[]

  // Classify context steps as per-item vs shared
  const perItemContext: string[] = []
  const sharedContext: string[] = []

  for (const ref of agentStep.context) {
    const refStep = ctx.recipe.steps.find((s) => s.id === ref)
    if (refStep && isForeachStep(refStep) && refStep.foreach === agentStep.foreach) {
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
    itemKey: agentStep.foreach,
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
