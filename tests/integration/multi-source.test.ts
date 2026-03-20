import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { executeRecipe } from '../../src/lib/recipe/engine.js'
import { setConfigPath } from '../../src/lib/config.js'
import type { RecipeComplete } from '../../src/types.js'
import { jsonResponse, apiSuccess } from '../helpers.js'

// -- Mock fetch globally to intercept all HTTP calls --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- URL routing helper --

/**
 * Configure mockFetch to route by URL prefix.
 * Each entry maps a URL prefix to a Response (or a function that returns one).
 * Requests are matched in order; first match wins.
 */
function routeByUrl(
  routes: Array<{
    match: string | ((url: string) => boolean)
    respond: Response | ((url: string) => Response)
  }>,
): void {
  mockFetch.mockImplementation((url: string) => {
    for (const route of routes) {
      const matched = typeof route.match === 'string'
        ? url.startsWith(route.match)
        : route.match(url)
      if (matched) {
        const response = typeof route.respond === 'function'
          ? route.respond(url)
          : route.respond
        return Promise.resolve(response)
      }
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`))
  })
}

// -- YAML Recipe fixtures --

const AIXBT_PLUS_DEFILLAMA_RECIPE = `
name: aixbt-defillama-enrichment
version: "1.0"
description: Fetch AIXBT projects, enrich with DeFiLlama protocol TVL data
steps:
  - id: projects
    action: projects
  - id: protocols
    foreach: "projects.data"
    action: protocol
    source: defillama
    params:
      protocol: "{item.slug}"
  - id: summary
    input: protocols
    transform:
      select:
        - name
        - tvl
`

const DEFILLAMA_TVL_RECIPE = `
name: defillama-tvl
version: "1.0"
description: Get total historical TVL from DeFiLlama
steps:
  - id: tvl
    action: tvl
    source: defillama
`

const GOPLUS_SCAN_RECIPE = `
name: goplus-scan
version: "1.0"
description: Fetch AIXBT projects then scan each with GoPlus
steps:
  - id: tokens
    action: projects
  - id: security
    foreach: "tokens.data"
    action: token-security
    source: goplus
    params:
      chain_id: "1"
      contract_addresses: "{item.address}"
`

const GOPLUS_SINGLE_STEP_RECIPE = `
name: goplus-single
version: "1.0"
description: Single GoPlus token security check
steps:
  - id: check
    action: token-security
    source: goplus
    params:
      chain_id: "1"
      contract_addresses: "0xabc123"
`

const MIXED_RECIPE = `
name: mixed-sources
version: "1.0"
description: Mix of AIXBT steps and external provider steps
steps:
  - id: projects
    action: projects
  - id: chains_tvl
    action: chains
    source: defillama
  - id: signals
    action: signals
    params:
      projectIds: "{projects.data[*].id}"
`

// -- Test setup --

describe('multi-source integration tests', () => {
  let tempDir: string
  const TEST_API_KEY = 'test-multi-source-key'

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-multi-source-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = TEST_API_KEY
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-multi-source-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
  })

  // =========================================================================
  // 1. Multi-source recipe: AIXBT projects + DeFiLlama protocol foreach
  // =========================================================================

  describe('AIXBT projects + DeFiLlama protocol foreach + transform', () => {
    const PROJECTS = [
      { id: 'proj-1', name: 'Aave', slug: 'aave' },
      { id: 'proj-2', name: 'Lido', slug: 'lido' },
    ]

    const DEFILLAMA_AAVE = { name: 'Aave', tvl: 12_000_000_000, chains: ['Ethereum', 'Polygon'] }
    const DEFILLAMA_LIDO = { name: 'Lido', tvl: 25_000_000_000, chains: ['Ethereum'] }

    it('should fetch AIXBT projects then enrich each with DeFiLlama protocol data', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
        {
          match: (url) => url.startsWith('https://api.llama.fi') && url.includes('/protocol/aave'),
          respond: jsonResponse(200, DEFILLAMA_AAVE),
        },
        {
          match: (url) => url.startsWith('https://api.llama.fi') && url.includes('/protocol/lido'),
          respond: jsonResponse(200, DEFILLAMA_LIDO),
        },
      ])

      const result = await executeRecipe({
        yaml: AIXBT_PLUS_DEFILLAMA_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // Step 1: AIXBT projects should have fetched the project list
      expect(complete.data.projects).toEqual(PROJECTS)

      // Step 2: foreach should have fetched protocol data from DeFiLlama for each project
      const protocols = complete.data.protocols as unknown[]
      expect(protocols).toHaveLength(2)

      // Step 3: transform should have applied select to pick name and tvl
      const summary = complete.data.summary as Array<Record<string, unknown>>
      expect(summary).toHaveLength(2)
      expect(summary[0]).toHaveProperty('name')
      expect(summary[0]).toHaveProperty('tvl')
    })

    it('should call AIXBT API with X-API-Key and DeFiLlama without it', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, DEFILLAMA_AAVE),
        },
      ])

      await executeRecipe({
        yaml: AIXBT_PLUS_DEFILLAMA_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Find the AIXBT call and the DeFiLlama calls
      const calls = mockFetch.mock.calls as [string, { headers: Record<string, string> }][]
      const aixbtCalls = calls.filter(([url]) => url.startsWith('https://api.aixbt.tech'))
      const llamaCalls = calls.filter(([url]) => url.startsWith('https://api.llama.fi'))

      expect(aixbtCalls.length).toBeGreaterThanOrEqual(1)
      expect(llamaCalls.length).toBeGreaterThanOrEqual(1)

      // AIXBT calls should have the X-API-Key header
      for (const [, opts] of aixbtCalls) {
        expect(opts.headers['X-API-Key']).toBe(TEST_API_KEY)
      }

      // DeFiLlama calls should NOT have the X-API-Key header
      for (const [, opts] of llamaCalls) {
        expect(opts.headers['X-API-Key']).toBeUndefined()
      }
    })

    it('should construct correct DeFiLlama URLs from foreach item params', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, DEFILLAMA_AAVE),
        },
      ])

      await executeRecipe({
        yaml: AIXBT_PLUS_DEFILLAMA_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      const llamaUrls = (mockFetch.mock.calls as [string, unknown][])
        .map(([url]) => url)
        .filter((url: string) => url.startsWith('https://api.llama.fi'))

      // Should have two calls: one for each project slug
      expect(llamaUrls).toHaveLength(2)
      expect(llamaUrls.some((url: string) => url.includes('/protocol/aave'))).toBe(true)
      expect(llamaUrls.some((url: string) => url.includes('/protocol/lido'))).toBe(true)
    })
  })

  // =========================================================================
  // 2. External provider step (no foreach) — single DeFiLlama TVL step
  // =========================================================================

  describe('single external provider step (DeFiLlama TVL)', () => {
    const TVL_HISTORY = [
      { date: 1710000000, totalLiquidityUSD: 90_000_000_000 },
      { date: 1710086400, totalLiquidityUSD: 91_000_000_000 },
    ]

    it('should execute a single DeFiLlama step and return the data', async () => {
      routeByUrl([
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, TVL_HISTORY),
        },
      ])

      const result = await executeRecipe({
        yaml: DEFILLAMA_TVL_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // DeFiLlama normalize passes through plain JSON as-is
      expect(complete.data.tvl).toEqual(TVL_HISTORY)
    })

    it('should not send AIXBT API key to DeFiLlama', async () => {
      routeByUrl([
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, []),
        },
      ])

      await executeRecipe({
        yaml: DEFILLAMA_TVL_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Should have made exactly one call, to DeFiLlama
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(url).toContain('api.llama.fi')
      expect(opts.headers['X-API-Key']).toBeUndefined()
    })

    it('should not call AIXBT API at all for a purely external recipe', async () => {
      routeByUrl([
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, []),
        },
      ])

      await executeRecipe({
        yaml: DEFILLAMA_TVL_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      const aixbtCalls = (mockFetch.mock.calls as [string, unknown][])
        .filter(([url]) => url.startsWith('https://api.aixbt.tech'))

      expect(aixbtCalls).toHaveLength(0)
    })
  })

  // =========================================================================
  // 3. Foreach with external source (GoPlus token-security)
  // =========================================================================

  describe('foreach with GoPlus external source', () => {
    const TOKENS = [
      { id: 'proj-a', name: 'Token A', address: '0xaaa111' },
      { id: 'proj-b', name: 'Token B', address: '0xbbb222' },
    ]

    it('should iterate over AIXBT projects and scan each with GoPlus', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(TOKENS),
        },
        {
          match: (url) => url.startsWith('https://api.gopluslabs.io') && url.includes('0xaaa111'),
          respond: jsonResponse(200, {
            code: 1,
            result: {
              '0xaaa111': { is_honeypot: '0', buy_tax: '0', sell_tax: '0' },
            },
          }),
        },
        {
          match: (url) => url.startsWith('https://api.gopluslabs.io') && url.includes('0xbbb222'),
          respond: jsonResponse(200, {
            code: 1,
            result: {
              '0xbbb222': { is_honeypot: '1', buy_tax: '0.05', sell_tax: '0.10' },
            },
          }),
        },
      ])

      const result = await executeRecipe({
        yaml: GOPLUS_SCAN_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // AIXBT step should return projects
      expect(complete.data.tokens).toEqual(TOKENS)

      // GoPlus foreach should have results for each token
      const security = complete.data.security as unknown[]
      expect(security).toHaveLength(2)

      // GoPlus normalize flattens single-address results from { "0xaaa111": {...} } to {...}
      expect(security[0]).toEqual({ is_honeypot: '0', buy_tax: '0', sell_tax: '0', _source_id: 'proj-a', _source_name: 'Token A' })
      expect(security[1]).toEqual({ is_honeypot: '1', buy_tax: '0.05', sell_tax: '0.10', _source_id: 'proj-b', _source_name: 'Token B' })
    })

    it('should construct GoPlus URLs with correct chain_id path parameter and contract_addresses query', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(TOKENS),
        },
        {
          match: 'https://api.gopluslabs.io',
          respond: jsonResponse(200, {
            code: 1,
            result: { '0x000': { is_honeypot: '0' } },
          }),
        },
      ])

      await executeRecipe({
        yaml: GOPLUS_SCAN_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      const goplusCalls = (mockFetch.mock.calls as [string, unknown][])
        .map(([url]) => url)
        .filter((url: string) => url.startsWith('https://api.gopluslabs.io'))

      expect(goplusCalls.length).toBeGreaterThanOrEqual(2)

      // Each GoPlus call should have chain_id = 1 in the path
      for (const url of goplusCalls) {
        expect(url).toContain('/api/v1/token_security/1')
      }

      // Should have contract_addresses for each token
      expect(goplusCalls.some((url: string) => url.includes('contract_addresses=0xaaa111'))).toBe(true)
      expect(goplusCalls.some((url: string) => url.includes('contract_addresses=0xbbb222'))).toBe(true)
    })
  })

  // =========================================================================
  // 4. Error handling: external provider step fails
  // =========================================================================

  describe('error handling for external provider failures', () => {
    it('should propagate error when GoPlus returns code !== 1', async () => {
      routeByUrl([
        {
          match: 'https://api.gopluslabs.io',
          respond: jsonResponse(200, {
            code: 2,
            message: 'Invalid chain id',
          }),
        },
      ])

      await expect(
        executeRecipe({
          yaml: GOPLUS_SINGLE_STEP_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        }),
      ).rejects.toThrow(/Invalid chain id/)
    })

    it('should include step context in the error when an external provider call fails with HTTP error', async () => {
      routeByUrl([
        {
          match: 'https://api.gopluslabs.io',
          respond: jsonResponse(500, { message: 'Internal server error' }),
        },
      ])

      await expect(
        executeRecipe({
          yaml: GOPLUS_SINGLE_STEP_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        }),
      ).rejects.toThrow(/Step "check" failed/)
    })

    it('should record per-item failures in foreach when external provider returns errors', async () => {
      const TOKENS = [
        { id: 'proj-a', name: 'Token A', address: '0xgood' },
        { id: 'proj-b', name: 'Token B', address: '0xbad' },
      ]

      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(TOKENS),
        },
        {
          match: (url) => url.startsWith('https://api.gopluslabs.io') && url.includes('0xgood'),
          respond: jsonResponse(200, {
            code: 1,
            result: { '0xgood': { is_honeypot: '0' } },
          }),
        },
        {
          match: (url) => url.startsWith('https://api.gopluslabs.io') && url.includes('0xbad'),
          respond: jsonResponse(500, { message: 'Token not found' }),
        },
      ])

      const result = await executeRecipe({
        yaml: GOPLUS_SCAN_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Foreach catches per-item errors and records them as _error markers
      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      const security = complete.data.security as unknown[]
      expect(security).toHaveLength(2)

      // First result should be the successful GoPlus data
      expect(security[0]).toEqual({ is_honeypot: '0', _source_id: 'proj-a', _source_name: 'Token A' })

      // Second result should be an error marker
      const errorItem = security[1] as { _error: boolean; error: string }
      expect(errorItem._error).toBe(true)
      expect(errorItem.error).toBeDefined()
    })

    it('should propagate DeFiLlama HTTP error for a non-foreach step', async () => {
      routeByUrl([
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(404, { message: 'Endpoint not found' }),
        },
      ])

      await expect(
        executeRecipe({
          yaml: DEFILLAMA_TVL_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        }),
      ).rejects.toThrow(/Step "tvl" failed/)
    })
  })

  // =========================================================================
  // 5. Mixed AIXBT and external steps (non-foreach)
  // =========================================================================

  describe('mixed AIXBT and external steps without foreach', () => {
    const PROJECTS = [
      { id: 'proj-x', name: 'Protocol X' },
      { id: 'proj-y', name: 'Protocol Y' },
    ]

    const CHAINS_DATA = [
      { name: 'Ethereum', tvl: 60_000_000_000 },
      { name: 'Solana', tvl: 8_000_000_000 },
    ]

    const SIGNALS = [
      { id: 'sig-1', projectId: 'proj-x', description: 'Bullish signal' },
    ]

    it('should execute AIXBT and DeFiLlama steps in sequence', async () => {
      routeByUrl([
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/projects'),
          respond: apiSuccess(PROJECTS),
        },
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, CHAINS_DATA),
        },
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/signals'),
          respond: apiSuccess(SIGNALS),
        },
      ])

      const result = await executeRecipe({
        yaml: MIXED_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // AIXBT projects step
      expect(complete.data.projects).toEqual(PROJECTS)

      // DeFiLlama chains step
      expect(complete.data.chains_tvl).toEqual(CHAINS_DATA)

      // AIXBT signals step (with resolved projectIds from projects step)
      expect(complete.data.signals).toEqual(SIGNALS)
    })

    it('should route to correct providers based on source field', async () => {
      routeByUrl([
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/projects'),
          respond: apiSuccess(PROJECTS),
        },
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, CHAINS_DATA),
        },
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/signals'),
          respond: apiSuccess(SIGNALS),
        },
      ])

      await executeRecipe({
        yaml: MIXED_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      const calls = mockFetch.mock.calls as [string, unknown][]
      const urls = calls.map(([url]) => url)

      // Step 1 (projects, no source -> AIXBT): should hit AIXBT API
      expect(urls.some((u: string) => u.startsWith('https://api.aixbt.tech') && u.includes('/v2/projects'))).toBe(true)

      // Step 2 (chains, source: defillama): should hit DeFiLlama API
      expect(urls.some((u: string) => u.startsWith('https://api.llama.fi'))).toBe(true)

      // Step 3 (signals, no source -> AIXBT): should hit AIXBT API
      expect(urls.some((u: string) => u.startsWith('https://api.aixbt.tech') && u.includes('/v2/signals'))).toBe(true)
    })

    it('should resolve template params from AIXBT step results in subsequent AIXBT steps', async () => {
      routeByUrl([
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/projects'),
          respond: apiSuccess(PROJECTS),
        },
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, CHAINS_DATA),
        },
        {
          match: (url) => url.startsWith('https://api.aixbt.tech') && url.includes('/v2/signals'),
          respond: apiSuccess(SIGNALS),
        },
      ])

      await executeRecipe({
        yaml: MIXED_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Find the signals call and verify that projectIds were resolved from the projects step
      const signalsUrl = (mockFetch.mock.calls as [string, unknown][])
        .map(([url]) => url)
        .find((url: string) => url.includes('/v2/signals'))

      expect(signalsUrl).toBeDefined()
      // The pluck expression {projects.data[*].id} should have resolved to "proj-x,proj-y"
      expect(signalsUrl).toContain('projectIds=proj-x%2Cproj-y')
    })
  })

  // =========================================================================
  // 6. Fallback: steps degrade gracefully when provider key is missing
  // =========================================================================

  describe('step fallback on missing provider key/tier', () => {
    // CoinGecko ohlc requires demo tier; with no key configured, effective tier is free
    const COINGECKO_SINGLE_RECIPE = `
name: coingecko-fallback-test
version: "1.0"
description: Test fallback for CoinGecko step requiring demo tier
steps:
  - id: projects
    action: projects
  - id: price_history
    action: ohlc
    source: coingecko
    params:
      id: "bitcoin"
      days: "30"
    fallback: "Pull 30-day OHLC price data from CoinGecko for bitcoin"
`

    const COINGECKO_NO_FALLBACK_RECIPE = `
name: coingecko-no-fallback-test
version: "1.0"
description: Test step without fallback for CoinGecko step
steps:
  - id: projects
    action: projects
  - id: price_history
    action: ohlc
    source: coingecko
    params:
      id: "bitcoin"
      days: "30"
`

    const COINGECKO_FOREACH_RECIPE = `
name: coingecko-foreach-fallback-test
version: "1.0"
description: Test fallback for foreach CoinGecko step
steps:
  - id: projects
    action: projects
  - id: price_history
    foreach: "projects.data"
    action: ohlc
    source: coingecko
    params:
      id: "{item.cgId}"
      days: "30"
    fallback: "Pull 30-day OHLC price data from CoinGecko for each project"
`

    const PROJECTS = [
      { id: 'proj-1', name: 'Bitcoin', cgId: 'bitcoin' },
      { id: 'proj-2', name: 'Ethereum', cgId: 'ethereum' },
    ]

    it('should return fallback data when provider tier is insufficient (single step)', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
      ])

      const result = await executeRecipe({
        yaml: COINGECKO_SINGLE_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // AIXBT step should still work
      expect(complete.data.projects).toEqual(PROJECTS)

      // CoinGecko step should have fallback data, not throw
      const priceHistory = complete.data.price_history as { _fallback: boolean; message: string }
      expect(priceHistory._fallback).toBe(true)
      expect(priceHistory.message).toContain('skipped')
      expect(priceHistory.message).toContain('coingecko')
      expect(priceHistory.message).toContain('Pull 30-day OHLC price data from CoinGecko for bitcoin')

      // Should NOT have made any CoinGecko API calls
      const cgCalls = (mockFetch.mock.calls as [string, unknown][])
        .filter(([url]) => url.includes('coingecko'))
      expect(cgCalls).toHaveLength(0)
    })

    it('should return fallback data without message when no fallback field is defined', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
      ])

      const result = await executeRecipe({
        yaml: COINGECKO_NO_FALLBACK_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      const priceHistory = complete.data.price_history as { _fallback: boolean; message: string }
      expect(priceHistory._fallback).toBe(true)
      expect(priceHistory.message).toContain('skipped')
    })

    it('should return fallback for foreach step before iterating (no API calls made)', async () => {
      routeByUrl([
        {
          match: 'https://api.aixbt.tech',
          respond: apiSuccess(PROJECTS),
        },
      ])

      const result = await executeRecipe({
        yaml: COINGECKO_FOREACH_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // AIXBT step should still work
      expect(complete.data.projects).toEqual(PROJECTS)

      // Foreach CoinGecko step should have fallback data
      const priceHistory = complete.data.price_history as { _fallback: boolean; message: string }
      expect(priceHistory._fallback).toBe(true)
      expect(priceHistory.message).toContain('Pull 30-day OHLC price data from CoinGecko for each project')

      // Should NOT have made any CoinGecko API calls
      const cgCalls = (mockFetch.mock.calls as [string, unknown][])
        .filter(([url]) => url.includes('coingecko') || url.includes('geckoterminal'))
      expect(cgCalls).toHaveLength(0)
    })

    it('should execute normally when provider key meets tier requirement', async () => {
      // DeFiLlama is free tier — should always work without a key
      const DEFILLAMA_STEP_RECIPE = `
name: defillama-with-fallback
version: "1.0"
description: DeFiLlama step with fallback (should not trigger since free tier)
steps:
  - id: tvl
    action: tvl
    source: defillama
    fallback: "Get total TVL from DeFiLlama"
`
      const TVL_DATA = [{ date: 1710000000, tvl: 90_000_000_000 }]

      routeByUrl([
        {
          match: 'https://api.llama.fi',
          respond: jsonResponse(200, TVL_DATA),
        },
      ])

      const result = await executeRecipe({
        yaml: DEFILLAMA_STEP_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      // Should have actual data, not fallback
      expect(complete.data.tvl).toEqual(TVL_DATA)
    })
  })
})
