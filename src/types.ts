// Shared types for @aixbt/cli

export type KeyType = 'full' | 'x402'

export interface RateLimitInfo {
  limitPerMinute: number
  remainingPerMinute: number
  resetMinute: string         // ISO 8601
  limitPerDay: number
  remainingPerDay: number
  resetDay: string            // ISO 8601
  retryAfterSeconds?: number  // Only present on 429
}

export interface UpgradeMeta {
  upgrade: {
    description: string
    protocol: string
    payment: string
    options: Array<{ period: string; price: string; method: string; url: string }>
  }
}

export interface ApiResponse<T> {
  status: number
  data: T
  meta?: UpgradeMeta
  pagination?: {
    page: number
    limit: number
    totalCount: number
    hasMore: boolean
  }
  rateLimit: RateLimitInfo | null
  paymentResponse?: Record<string, unknown> | null
}

export interface ValidationIssue {
  path: string
  message: string
}

// -- API response types --

export interface SignalData {
  id: string
  detectedAt: string
  reinforcedAt: string
  description: string
  projectName: string
  projectId: string
  category: string
  hasOfficialSource: boolean
  clusters: Array<{ id: string; name: string }>
  activity: ActivityEntry[]
}

export interface ActivityEntry {
  date: string
  source: string
  cluster: { id: string; name: string } | null
  incoming: string
  result: string
  isOfficial?: boolean
  fromSignal?: { signalId: string; projectId: string; projectName: string }
}

// -- Recipe YAML schema types --

export interface Recipe {
  name: string
  version: string
  description: string
  estimatedTokens?: number | null
  params?: Record<string, RecipeParam>
  requiredOneOf?: string[]
  steps: RecipeStep[]
  hints?: RecipeHints
  analysis?: RecipeAnalysis
}

export interface RecipeParam {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  default?: string | number | boolean
}

export type RecipeStep = ApiStep | AgentStep

export interface ApiStep {
  id: string
  type: 'api'
  action: string
  source?: string
  params?: Record<string, unknown>
  transform?: TransformBlock
  /** Optional iteration modifier — iterates over the referenced array */
  'for'?: string
  /** Message shown to agent when step is skipped due to missing provider key/tier */
  fallback?: string
}

export interface AgentStep {
  id: string
  type: 'agent'
  context: string[]
  instructions: string
  returns: Record<string, string>
  /** Optional iteration modifier — runs the agent step for each item in the array */
  'for'?: string
}

export interface RecipeHints {
  combine?: string[]
  key?: string
  include?: string[]
}

export interface RecipeAnalysis {
  instructions: string
  output?: string
  context?: string[]
}

// -- Transform block types --

export interface SampleTransform {
  count?: number
  tokenBudget?: number
  guaranteePercent?: number
  guaranteeCount?: number
  weight_by?: string
}

export interface TransformBlock {
  select?: string[]
  sample?: SampleTransform
}

// -- Step type guards --

export function isAgentStep(step: RecipeStep): step is AgentStep {
  return step.type === 'agent'
}

export function isApiStep(step: RecipeStep): step is ApiStep {
  return step.type === 'api'
}

export function hasForModifier(step: RecipeStep): step is RecipeStep & { 'for': string } {
  return typeof step['for'] === 'string' && step['for'].length > 0
}

export function isParallelAgentStep(step: RecipeStep): step is AgentStep & { 'for': string } {
  return isAgentStep(step) && hasForModifier(step)
}

// -- Step result types (used by agent context resolution) --

export interface StepResult {
  stepId: string
  data: unknown
  rateLimit: RateLimitInfo | null
  timing: StepTiming
  /** Present when a sample transform reduced the result set */
  sampled?: { before: number; after: number; weightedBy: string }
}

export interface StepTiming {
  startedAt: string
  completedAt: string
  durationMs: number
  rateLimitPaused?: boolean
  waitedMs?: number
}

// -- Recipe execution output types --

export interface RecipeYieldProgress {
  stepsCompleted: number    // ctx.results.size
  stepsTotal: number        // ctx.recipe.steps.length
  segmentIndex: number      // ctx.currentSegmentIndex (0-based)
  segmentsTotal: number     // ctx.segments.length
}

export interface ParallelAgentMeta {
  items: unknown[]
  itemKey: string
  concurrency: number
  perItemContext: string[]
  sharedContext: string[]
}

export interface RecipeAwaitingAgent {
  status: 'awaiting_agent'
  recipe: string
  version: string
  step: string
  instructions: string
  returns: Record<string, string>
  data: Record<string, unknown>
  tokenCount: number
  resumeCommand: string
  progress: RecipeYieldProgress
  remaining: string
  parallel?: ParallelAgentMeta
  /** Present only on parallel steps — tells the operating agent how to execute */
  parallelExecution?: string
  /** Domain context blocks resolved from recipe actions */
  contextHints?: string[]
  /** Pre-yield step data needed by downstream consumers (agent steps, analysis) */
  carryForward?: Record<string, unknown>
}

export interface RecipeComplete {
  status: 'complete'
  recipe: string
  version: string
  timestamp: string
  data: Record<string, unknown>
  tokenCount: number
  hints?: RecipeHints
  analysis?: RecipeAnalysis
  /** Domain context blocks resolved from recipe actions */
  contextHints?: string[]
}
