import { get, type ApiClientOptions } from './api-client.js'
import { CliError, ApiError } from './errors.js'

export interface RecipeSummary {
  name: string
  version: string
  description: string
  paramCount: number
}

export interface RecipeDetail {
  name: string
  updatedAt: string
  yaml: string
}

export async function fetchRecipeList(clientOptions?: ApiClientOptions): Promise<RecipeSummary[]> {
  const result = await get<RecipeSummary[]>('/v2/cli/recipes', undefined, {
    ...clientOptions,
    noAuth: true,
  })
  return result.data
}

export async function fetchRecipeDetail(name: string, clientOptions?: ApiClientOptions): Promise<RecipeDetail> {
  try {
    const result = await get<RecipeDetail>(
      `/v2/cli/recipes/${encodeURIComponent(name)}`,
      undefined,
      { ...clientOptions, noAuth: true },
    )
    return result.data
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      throw new CliError(
        `Recipe "${name}" not found in the registry. Run "aixbt recipe list" to see available recipes.`,
        'RECIPE_NOT_FOUND',
      )
    }
    throw err
  }
}

export async function fetchRecipeFromRegistry(name: string, clientOptions?: ApiClientOptions): Promise<string> {
  const detail = await fetchRecipeDetail(name, clientOptions)
  return detail.yaml
}
