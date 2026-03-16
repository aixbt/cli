import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { encode } from '@toon-format/toon'
import type {
  ExecutionContext, AgentStep,
  RecipeAwaitingAgent, RecipeComplete,
} from '../../types.js'
import { resolveValue } from './template.js'

/**
 * Estimate token count from a data payload.
 * Uses byte-length heuristic (~4 chars per token for JSON/English).
 */
export function estimateTokenCount(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4)
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
    instructions: agentStep.instructions,
    returns: agentStep.returns,
    data,
    tokenCount: estimateTokenCount(data),
    resumeCommand,
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
  }
}
