import type { RecipeAwaitingAgent, RecipeComplete } from '../../types.js'
import { postRaw, type ApiClientOptions } from '../api-client.js'
import { CliError } from '../errors.js'

export interface ExecuteRecipeOptions {
  yaml?: string
  recipeName?: string
  params: Record<string, string>
  resumeFromStep?: string
  resumeInput?: Record<string, unknown>
  carryForward?: Record<string, unknown>
  clientOptions: ApiClientOptions
}

export async function executeRecipeServer(
  options: ExecuteRecipeOptions,
): Promise<RecipeAwaitingAgent | RecipeComplete> {
  const { yaml, recipeName, params, resumeFromStep, resumeInput, carryForward, clientOptions } = options

  if (!yaml && !recipeName) {
    throw new CliError('Either yaml or recipeName must be provided', 'NO_RECIPE_SOURCE')
  }

  const body: Record<string, unknown> = { params }

  if (yaml) {
    body.yaml = yaml
  } else {
    body.recipeName = recipeName
  }

  if (resumeFromStep) {
    body.resumeFromStep = resumeFromStep
  }

  if (resumeInput) {
    body.resumeInput = resumeInput
  }

  if (carryForward) {
    body.carryForward = carryForward
  }

  const result = await postRaw<RecipeAwaitingAgent | RecipeComplete>(
    '/v2/recipes/execute',
    body,
    clientOptions,
  )

  return result
}

export interface ValidateRecipeOptions {
  yaml: string
  clientOptions: ApiClientOptions
}

export interface ValidateRecipeResult {
  valid: boolean
  recipe?: {
    name: string
    version: string
    stepCount: number
    paramCount: number
  }
  issues?: Array<{ path: string; message: string }>
}

export async function validateRecipeServer(
  options: ValidateRecipeOptions,
): Promise<ValidateRecipeResult> {
  const result = await postRaw<ValidateRecipeResult>(
    '/v2/recipes/validate',
    { yaml: options.yaml },
    options.clientOptions,
  )
  return result
}
