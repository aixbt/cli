// Shared types for @aixbt/cli

export interface RateLimitInfo {
  limitPerMinute: number
  remainingPerMinute: number
  resetMinute: string         // ISO 8601
  limitPerDay: number
  remainingPerDay: number
  resetDay: string            // ISO 8601
  retryAfterSeconds?: number  // Only present on 429
}

export interface ApiResponse<T> {
  status: number
  data: T
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

// -- Recipe YAML schema types --

export interface Recipe {
  name: string
  version: string
  description: string
  tier?: string
  params?: Record<string, RecipeParam>
  steps: RecipeStep[]
  output?: RecipeOutput
  analysis?: RecipeAnalysis
}

export interface RecipeParam {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  default?: string | number | boolean
}

export type RecipeStep = ApiStep | ForeachStep | AgentStep

export interface ApiStep {
  id: string
  endpoint: string
  params?: Record<string, unknown>
  type?: never
  foreach?: never
}

export interface ForeachStep {
  id: string
  foreach: string
  endpoint: string
  params?: Record<string, unknown>
  type?: never
}

export interface AgentStep {
  id: string
  type: 'agent'
  context: string[]
  task: string
  description: string
  returns: Record<string, string>
}

export interface RecipeOutput {
  merge?: string[]
  join_on?: string
  include?: string[]
}

export interface RecipeAnalysis {
  instructions?: string
  context?: string
  task?: string
  output_format?: string
}

// -- Step type guards --

export function isAgentStep(step: RecipeStep): step is AgentStep {
  return (step as AgentStep).type === 'agent'
}

export function isForeachStep(step: RecipeStep): step is ForeachStep {
  return 'foreach' in step && (step as ForeachStep).foreach !== undefined
}

export function isApiStep(step: RecipeStep): step is ApiStep {
  return !isAgentStep(step) && !isForeachStep(step)
}

// -- Execution types --

export interface ExecutionContext {
  recipe: Recipe
  params: Record<string, string>
  results: Map<string, StepResult>
  currentRateLimit: RateLimitInfo | null
  currentSegmentIndex: number
  segments: Segment[]
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
  description: string
  returns: Record<string, string>
  data: Record<string, unknown>
  resumeCommand: string
}

export interface RecipeComplete {
  status: 'complete'
  recipe: string
  version: string
  timestamp: string
  data: Record<string, unknown>
  output?: RecipeOutput
  analysis?: RecipeAnalysis
}
