import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { fetchRecipeList, fetchRecipeDetail, fetchRecipeFromRegistry } from '../../src/lib/registry.js'
import { setConfigPath } from '../../src/lib/config.js'
import { CliError, ApiError } from '../../src/lib/errors.js'
import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- Mock data --

const MOCK_RECIPE_LIST = [
  { name: 'defi-analysis', version: '1.0', description: 'Analyze DeFi protocols', paramCount: 2 },
  { name: 'market-scanner', version: '2.1', description: 'Scan market trends', paramCount: 0 },
]

const MOCK_RECIPE_DETAIL = {
  name: 'defi-analysis',
  updatedAt: '2026-03-01T00:00:00Z',
  yaml: 'name: defi-analysis\nversion: "1.0"\nsteps:\n  - id: projects\n    endpoint: "GET /v2/projects"\n',
}

describe('registry', () => {
  let tempDir: string

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-registry-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    // No API key needed for registry (noAuth: true)
    delete process.env.AIXBT_API_KEY
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-registry-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_URL
  })

  // -- fetchRecipeList --

  describe('fetchRecipeList', () => {
    it('should call the correct URL (/v2/cli/recipes)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_LIST }),
      )

      await fetchRecipeList()

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes')
    })

    it('should not send an X-API-Key header (unauthenticated)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_LIST }),
      )

      await fetchRecipeList()

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })

    it('should return the parsed data array', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_LIST }),
      )

      const result = await fetchRecipeList()

      expect(result).toEqual(MOCK_RECIPE_LIST)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('defi-analysis')
      expect(result[1].name).toBe('market-scanner')
    })

    it('should return an empty array when no recipes exist', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const result = await fetchRecipeList()

      expect(result).toEqual([])
      expect(result).toHaveLength(0)
    })

    it('should forward clientOptions.apiUrl when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      await fetchRecipeList({ apiUrl: 'https://custom.api.com' })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.origin).toBe('https://custom.api.com')
      expect(callUrl.pathname).toBe('/v2/cli/recipes')
    })
  })

  // -- fetchRecipeDetail --

  describe('fetchRecipeDetail', () => {
    it('should call the correct URL with the recipe name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_DETAIL }),
      )

      await fetchRecipeDetail('defi-analysis')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/cli/recipes/defi-analysis')
    })

    it('should URL-encode the recipe name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_DETAIL }),
      )

      await fetchRecipeDetail('my recipe/special')

      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toContain('/v2/cli/recipes/my%20recipe%2Fspecial')
    })

    it('should return the detail object', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_DETAIL }),
      )

      const result = await fetchRecipeDetail('defi-analysis')

      expect(result).toEqual(MOCK_RECIPE_DETAIL)
      expect(result.name).toBe('defi-analysis')
      expect(result.yaml).toContain('defi-analysis')
      expect(result.updatedAt).toBe('2026-03-01T00:00:00Z')
    })

    it('should throw CliError with code RECIPE_NOT_FOUND on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(404, { error: 'Not Found' }),
      )

      try {
        await fetchRecipeDetail('nonexistent-recipe')
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('RECIPE_NOT_FOUND')
        expect((err as CliError).message).toContain('nonexistent-recipe')
        expect((err as CliError).message).toContain('not found in the registry')
      }
    })

    it('should re-throw non-404 errors unchanged', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(500, { error: 'Internal Server Error' }),
      )

      try {
        await fetchRecipeDetail('some-recipe')
        expect.fail('Expected ApiError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).statusCode).toBe(500)
      }
    })

    it('should not send an X-API-Key header (unauthenticated)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_DETAIL }),
      )

      await fetchRecipeDetail('defi-analysis')

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })
  })

  // -- fetchRecipeFromRegistry --

  describe('fetchRecipeFromRegistry', () => {
    it('should return the yaml string from the detail', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_RECIPE_DETAIL }),
      )

      const yaml = await fetchRecipeFromRegistry('defi-analysis')

      expect(yaml).toBe(MOCK_RECIPE_DETAIL.yaml)
      expect(yaml).toContain('defi-analysis')
    })

    it('should propagate RECIPE_NOT_FOUND error from fetchRecipeDetail', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(404, { error: 'Not Found' }),
      )

      try {
        await fetchRecipeFromRegistry('nonexistent')
        expect.fail('Expected CliError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('RECIPE_NOT_FOUND')
      }
    })
  })
})
