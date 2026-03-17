// Shared types for @aixbt/cli

export type KeyType = 'demo' | 'full' | 'x402'

export interface RateLimitInfo {
  limitPerMinute: number
  remainingPerMinute: number
  resetMinute: string         // ISO 8601
  limitPerDay: number
  remainingPerDay: number
  resetDay: string            // ISO 8601
  retryAfterSeconds?: number  // Only present on 429
}

export interface FreeTierMeta {
  tier: 'free'
  dataDelayHours: number
  dataAsOf: string
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
  meta?: FreeTierMeta
  pagination?: {
    page: number
    limit: number
    totalCount: number
    hasMore: boolean
  }
  rateLimit: RateLimitInfo | null
  paymentResponse?: Record<string, unknown> | null
}

export const TEMPLATE_REGEX = /\{([^}]+)\}/g

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
  tier?: string
  estimatedTokens?: number | null
  params?: Record<string, RecipeParam>
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

export type RecipeStep = ApiStep | ForeachStep | AgentStep | TransformStep

export interface ApiStep {
  id: string
  action: string
  source?: string
  params?: Record<string, unknown>
  transform?: TransformBlock
  /** Message shown to agent when step is skipped due to missing provider key/tier */
  fallback?: string
  type?: never
  foreach?: never
  input?: never
}

export interface ForeachStep {
  id: string
  foreach: string
  action: string
  source?: string
  params?: Record<string, unknown>
  transform?: TransformBlock
  /** Message shown to agent when step is skipped due to missing provider key/tier */
  fallback?: string
  type?: never
  input?: never
}

export interface AgentStep {
  id: string
  type: 'agent'
  context: string[]
  task: string
  instructions: string
  returns: Record<string, string>
  foreach?: never
  input?: never
  transform?: never
}

export interface TransformStep {
  id: string
  input: string
  transform: TransformBlock
  foreach?: never
  type?: never
}

export interface RecipeHints {
  combine?: string[]
  key?: string
  include?: string[]
}

export interface RecipeAnalysis {
  instructions?: string
  task?: string
  output?: string
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
  return (step as AgentStep).type === 'agent'
}

export function isForeachStep(step: RecipeStep): step is ForeachStep {
  return 'foreach' in step && (step as ForeachStep).foreach !== undefined
}

export function isTransformStep(step: RecipeStep): step is TransformStep {
  return 'input' in step && (step as TransformStep).input !== undefined
}

export function isApiStep(step: RecipeStep): step is ApiStep {
  return !isAgentStep(step) && !isForeachStep(step) && !isTransformStep(step)
}

// -- Execution types --

export interface ExecutionContext {
  readonly recipe: Recipe
  readonly params: Record<string, string>
  results: Map<string, StepResult>
  currentRateLimit: RateLimitInfo | null
  currentSegmentIndex: number
  readonly segments: Segment[]
  agentInput: Record<string, unknown> | null
  resumedFromStep: string | null
}

export interface StepResult {
  stepId: string
  data: unknown
  rateLimit: RateLimitInfo | null
  timing: StepTiming
}

export interface ForeachResult extends StepResult {
  items: unknown[]
  failures: ForeachFailure[]
}

export interface ForeachFailure {
  item: unknown
  error: string
  status?: number
}

export interface StepTiming {
  startedAt: string
  completedAt: string
  durationMs: number
  rateLimitPaused?: boolean
  waitedMs?: number
}

export interface Segment {
  index: number
  steps: RecipeStep[]
  precedingAgentStep?: AgentStep
}

// -- Recipe execution output types --

export interface RecipeAwaitingAgent {
  status: 'awaiting_agent'
  recipe: string
  version: string
  step: string
  task: string
  instructions: string
  returns: Record<string, string>
  data: Record<string, unknown>
  tokenCount: number
  resumeCommand: string
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
}
