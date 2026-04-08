/**
 * Standalone measure-recipe script.
 *
 * This was demoted from the CLI's `recipe measure` subcommand during the
 * server-side recipe execution migration. It uses executeRecipeServer to
 * run recipes on the server and measure token usage at each agent yield.
 */

import { encode } from '@toon-format/toon'
import type { RecipeAwaitingAgent, RecipeComplete } from '../src/types.js'
import { executeRecipeServer } from '../src/lib/recipe/server.js'
import type { ApiClientOptions } from '../src/lib/api-client.js'

const BITCOIN_PROJECT_ID = '66f4fdc76811ccaef955de3e'

// -- Mock generation from returns schema --

function mockValueForType(typeStr: string): unknown {
  const t = typeStr.trim()
  if (t === 'string') return BITCOIN_PROJECT_ID
  if (t === 'string[]') return [BITCOIN_PROJECT_ID]
  if (t === 'number') return 0
  if (t === 'number[]') return [0]
  if (t === 'boolean') return true
  if (t === 'boolean[]') return [true]
  if (t.endsWith('[]') && t.startsWith('{')) {
    const inner = t.slice(0, -2).trim()
    return [mockObjectFromTypeString(inner)]
  }
  if (t.startsWith('{')) {
    return mockObjectFromTypeString(t)
  }
  return BITCOIN_PROJECT_ID
}

function mockObjectFromTypeString(typeStr: string): Record<string, unknown> {
  const inner = typeStr.replace(/^\{/, '').replace(/\}$/, '').trim()
  const obj: Record<string, unknown> = {}
  for (const part of inner.split(',')) {
    const colonIdx = part.indexOf(':')
    if (colonIdx === -1) continue
    const key = part.slice(0, colonIdx).trim()
    const val = part.slice(colonIdx + 1).trim()
    obj[key] = mockValueForType(val)
  }
  return obj
}

export function generateMockResponse(returns: Record<string, string>): Record<string, unknown> {
  const mock: Record<string, unknown> = {}
  for (const [key, typeStr] of Object.entries(returns)) {
    mock[key] = mockValueForType(typeStr)
  }
  return mock
}

// -- Token estimation --

export interface TokenEstimate {
  json: number
  toon: number
}

export function estimateTokens(data: unknown): TokenEstimate {
  const jsonStr = JSON.stringify(data)
  let toonStr: string
  try {
    toonStr = encode(data)
  } catch {
    toonStr = jsonStr
  }
  return {
    json: Math.ceil(jsonStr.length / 4),
    toon: Math.ceil(toonStr.length / 4),
  }
}

// -- Segment measurement --

export interface SegmentMeasurement {
  label: string
  stepId: string
  type: 'data' | 'post-yield'
  tokens: TokenEstimate
  mockItemCount: number
}

export interface MeasureResult {
  recipeName: string
  segments: SegmentMeasurement[]
  totalTokens: TokenEstimate
}

export async function measureRecipe(options: {
  yaml: string
  params: Record<string, string>
  clientOptions: ApiClientOptions
  onSegment?: (label: string) => void
}): Promise<MeasureResult> {
  const segments: SegmentMeasurement[] = []
  let recipeName = ''

  options.onSegment?.('Running data steps...')
  let result: RecipeAwaitingAgent | RecipeComplete = await executeRecipeServer({
    yaml: options.yaml,
    params: options.params,
    clientOptions: options.clientOptions,
  })

  if (result.status === 'complete') {
    const complete = result as RecipeComplete
    return {
      recipeName: complete.recipe,
      segments: [{
        label: 'All data steps',
        stepId: '(all)',
        type: 'data',
        tokens: estimateTokens(complete.data),
        mockItemCount: 0,
      }],
      totalTokens: estimateTokens(complete.data),
    }
  }

  let yieldCount = 0

  while (result.status === 'awaiting_agent') {
    const awaiting = result as RecipeAwaitingAgent
    recipeName = awaiting.recipe
    yieldCount++

    const segmentTokens = estimateTokens(awaiting.data)
    const label = yieldCount === 1
      ? `Data -> ${awaiting.step}`
      : `Post-yield data -> ${awaiting.step}`

    segments.push({
      label,
      stepId: awaiting.step,
      type: yieldCount === 1 ? 'data' : 'post-yield',
      tokens: segmentTokens,
      mockItemCount: yieldCount === 1 ? 0 : 1,
    })

    const mock = generateMockResponse(awaiting.returns)
    const resumeInput = awaiting.parallel ? { _results: [mock] } : mock

    options.onSegment?.(`Resuming after ${awaiting.step}...`)
    result = await executeRecipeServer({
      yaml: options.yaml,
      params: options.params,
      clientOptions: options.clientOptions,
      resumeFromStep: `step:${awaiting.step}`,
      resumeInput,
    })
  }

  const complete = result as RecipeComplete
  if (!recipeName) recipeName = complete.recipe

  if (yieldCount > 0) {
    const postYieldTokens = estimateTokens(complete.data)
    if (postYieldTokens.json >= 500) {
      segments.push({
        label: 'Post-yield data (final)',
        stepId: '(final)',
        type: 'post-yield',
        tokens: postYieldTokens,
        mockItemCount: 1,
      })
    }
  }

  const totalTokens: TokenEstimate = {
    json: segments.reduce((sum, s) => sum + s.tokens.json, 0),
    toon: segments.reduce((sum, s) => sum + s.tokens.toon, 0),
  }

  return { recipeName, segments, totalTokens }
}
