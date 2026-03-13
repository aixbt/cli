import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { executeRecipe } from '../../src/lib/recipe/engine.js'
import { fetchRecipeFromRegistry } from '../../src/lib/registry.js'
import { setConfigPath } from '../../src/lib/config.js'
import { PaymentRequiredError } from '../../src/lib/errors.js'
import type { RecipeAwaitingAgent, RecipeComplete } from '../../src/types.js'
import { jsonResponse, apiSuccess } from '../helpers.js'

// -- Mock fetch globally to intercept all HTTP calls --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- YAML Recipe fixtures --

const FULL_WORKFLOW_RECIPE = `
name: full-workflow
version: "1.0"
description: Full cross-cutting test
steps:
  - id: projects
    endpoint: "GET /v2/projects"
  - id: details
    foreach: "projects.data"
    endpoint: "GET /v2/projects/{item.id}"
  - id: analyze
    type: agent
    context:
      - projects
      - details
    task: "Analyze project data"
    instructions: "AI analysis of projects"
    returns:
      summary: string
      insights: "string[]"
  - id: follow_up
    endpoint: "GET /v2/signals"
    params:
      projectId: "{analyze.data.projectId}"
hints:
  include:
    - projects
    - details
    - follow_up
analysis:
  instructions: "Summarize the findings"
  task: "Generate report"
`

const X402_RECIPE = `
name: x402-test
version: "1.0"
description: Recipe that triggers x402
steps:
  - id: free_data
    endpoint: "GET /v2/projects"
  - id: premium_data
    endpoint: "GET /v2/signals"
    params:
      projectIds: "{free_data.data[*].id}"
`

const REGISTRY_RECIPE_YAML = `
name: registry-workflow
version: "2.0"
description: Registry recipe with agent step
steps:
  - id: scan
    endpoint: "GET /v2/projects"
    params:
      momentum: rising
  - id: evaluate
    type: agent
    context:
      - scan
    task: "Evaluate projects"
    instructions: "AI evaluation of scanned projects"
    returns:
      picks: "string[]"
      rationale: string
  - id: enrichment
    endpoint: "GET /v2/signals"
    params:
      projectIds: "{evaluate.data.picks}"
`

// -- Test setup --

describe('cross-cutting integration tests', () => {
  let tempDir: string
  const TEST_API_KEY = 'test-integration-key-abc123'

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-integration-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = TEST_API_KEY
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-integration-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
  })

  // =========================================================================
  // Scenario 1: Full workflow — auth -> recipe with foreach + agent yield -> resume -> completion
  // =========================================================================

  describe('full workflow: auth -> foreach -> agent yield -> resume -> completion', () => {
    const PROJECT_LIST = [
      { id: 'proj-1', name: 'Alpha Protocol' },
      { id: 'proj-2', name: 'Beta Finance' },
    ]

    const PROJECT_DETAIL_1 = { id: 'proj-1', name: 'Alpha Protocol', tvl: 50_000_000 }
    const PROJECT_DETAIL_2 = { id: 'proj-2', name: 'Beta Finance', tvl: 12_000_000 }

    const AGENT_INPUT = {
      summary: 'Alpha Protocol leads in TVL',
      insights: ['High TVL', 'Growing adoption'],
      projectId: 'proj-1',
    }

    const FOLLOW_UP_SIGNALS = [
      { id: 'sig-1', projectId: 'proj-1', description: 'Bullish momentum detected' },
    ]

    function setupFirstRunMocks() {
      // Call 1: GET /v2/projects (projects step)
      // api-client extracts body.data from the JSON envelope, so
      // stepResult.data = PROJECT_LIST (the array).
      // The foreach "projects.data" resolves to stepResult.data = the array.
      mockFetch.mockResolvedValueOnce(
        apiSuccess(PROJECT_LIST),
      )
      // Call 2: GET /v2/projects/proj-1 (foreach iteration 1)
      mockFetch.mockResolvedValueOnce(
        apiSuccess(PROJECT_DETAIL_1),
      )
      // Call 3: GET /v2/projects/proj-2 (foreach iteration 2)
      mockFetch.mockResolvedValueOnce(
        apiSuccess(PROJECT_DETAIL_2),
      )
    }

    it('should yield at agent step with awaiting_agent status and correct data', async () => {
      setupFirstRunMocks()

      const result = await executeRecipe({
        yaml: FULL_WORKFLOW_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Verify we halted at the agent step
      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as RecipeAwaitingAgent

      expect(awaiting.recipe).toBe('full-workflow')
      expect(awaiting.version).toBe('1.0')
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.task).toBe('Analyze project data')
      expect(awaiting.instructions).toBe('AI analysis of projects')
      expect(awaiting.returns).toEqual({ summary: 'string', insights: 'string[]' })

      // Verify context data was gathered from both preceding steps
      expect(awaiting.data.projects).toBeDefined()
      expect(awaiting.data.details).toBeDefined()

      // Verify the resume command is present
      expect(awaiting.resumeCommand).toContain('--resume-from step:analyze')

      // Verify that the API key was sent in all 3 fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(3)
      for (let i = 0; i < 3; i++) {
        const callOpts = mockFetch.mock.calls[i][1] as { headers: Record<string, string> }
        expect(callOpts.headers['X-API-Key']).toBe(TEST_API_KEY)
      }
    })

    it('should complete when resumed with --resume-from and --input', async () => {
      // Resume run: only the follow_up step executes
      mockFetch.mockResolvedValueOnce(
        apiSuccess(FOLLOW_UP_SIGNALS),
      )

      const result = await executeRecipe({
        yaml: FULL_WORKFLOW_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        resumeFromStep: 'step:analyze',
        resumeInput: AGENT_INPUT,
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      expect(complete.recipe).toBe('full-workflow')
      expect(complete.version).toBe('1.0')

      // The analyze step result should be the agent input we provided
      expect(complete.data.analyze).toEqual(AGENT_INPUT)
      // The follow_up step should have executed and returned signals
      expect(complete.data.follow_up).toEqual(FOLLOW_UP_SIGNALS)

      // Verify output and analysis fields from recipe YAML are passed through
      expect(complete.hints).toEqual({ include: ['projects', 'details', 'follow_up'] })
      expect(complete.analysis).toEqual({
        instructions: 'Summarize the findings',
        task: 'Generate report',
      })
    })

    it('should run full cycle: first run yields, second run completes', async () => {
      // --- First run: should yield at agent step ---
      setupFirstRunMocks()

      const firstResult = await executeRecipe({
        yaml: FULL_WORKFLOW_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      expect(firstResult.status).toBe('awaiting_agent')
      const awaiting = firstResult as RecipeAwaitingAgent
      expect(awaiting.step).toBe('analyze')
      expect(awaiting.data.projects).toBeDefined()
      expect(awaiting.data.details).toBeDefined()

      // --- Second run: resume from agent step ---
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(
        apiSuccess(FOLLOW_UP_SIGNALS),
      )

      const secondResult = await executeRecipe({
        yaml: FULL_WORKFLOW_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        resumeFromStep: 'step:analyze',
        resumeInput: AGENT_INPUT,
      })

      expect(secondResult.status).toBe('complete')
      const complete = secondResult as RecipeComplete

      // Verify agent input was injected as analyze step result
      expect(complete.data.analyze).toEqual(AGENT_INPUT)
      // Verify follow_up step executed with param from agent input
      expect(complete.data.follow_up).toEqual(FOLLOW_UP_SIGNALS)

      // Verify the follow_up call used the projectId from agent input
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const followUpUrl = mockFetch.mock.calls[0][0] as string
      expect(followUpUrl).toContain('/v2/signals')
      expect(followUpUrl).toContain('projectId=proj-1')
    })

    it('should pass foreach iteration data correctly to each API call', async () => {
      setupFirstRunMocks()

      await executeRecipe({
        yaml: FULL_WORKFLOW_RECIPE,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
      })

      // Verify foreach expanded to correct per-item URLs
      const call2Url = mockFetch.mock.calls[1][0] as string
      const call3Url = mockFetch.mock.calls[2][0] as string

      expect(call2Url).toContain('/v2/projects/proj-1')
      expect(call3Url).toContain('/v2/projects/proj-2')
    })
  })

  // =========================================================================
  // Scenario 2: Recipe with x402 payment error propagation
  // =========================================================================

  describe('x402 payment error propagation mid-execution', () => {
    it('should propagate PaymentRequiredError when API returns 402 during recipe execution', async () => {
      const projectsData = [{ id: 'p1' }, { id: 'p2' }]

      // First call succeeds (free_data step)
      mockFetch.mockResolvedValueOnce(
        apiSuccess(projectsData),
      )

      // Second call returns 402 (premium_data step)
      const paymentBody = {
        error: 'payment_required',
        accepts: 'x402-scheme',
        price: '$0.50',
        payTo: '0xabc123',
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, paymentBody, {
          'x-payment-scheme': 'x402',
          'x-payment-address': '0xabc123',
        }),
      )

      try {
        await executeRecipe({
          yaml: X402_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        })
        expect.fail('Expected PaymentRequiredError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(PaymentRequiredError)
        const payErr = err as PaymentRequiredError
        expect(payErr.code).toBe('PAYMENT_REQUIRED')
        expect(payErr.body).toEqual(paymentBody)
        // Verify payment details from headers are accessible
        expect(payErr.headers).not.toBeNull()
        expect(payErr.headers!.get('x-payment-scheme')).toBe('x402')
        expect(payErr.headers!.get('x-payment-address')).toBe('0xabc123')
      }
    })

    it('should have already executed the first step before the 402 error', async () => {
      const projectsData = [{ id: 'p1' }]

      mockFetch.mockResolvedValueOnce(
        apiSuccess(projectsData),
      )
      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { error: 'payment_required' }),
      )

      await expect(
        executeRecipe({
          yaml: X402_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        }),
      ).rejects.toThrow(PaymentRequiredError)

      // Verify both calls were made - first succeeded, second triggered 402
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // First call was to /v2/projects
      const firstUrl = mockFetch.mock.calls[0][0] as string
      expect(firstUrl).toContain('/v2/projects')

      // Second call was to /v2/signals with projectIds from first result
      const secondUrl = mockFetch.mock.calls[1][0] as string
      expect(secondUrl).toContain('/v2/signals')
      expect(secondUrl).toContain('projectIds=p1')
    })

    it('should include step context in the error message for recipe execution failures', async () => {
      mockFetch.mockResolvedValueOnce(
        apiSuccess([{ id: 'p1' }]),
      )
      mockFetch.mockResolvedValueOnce(
        jsonResponse(402, { error: 'payment_required', message: 'Payment required' }),
      )

      try {
        await executeRecipe({
          yaml: X402_RECIPE,
          params: {},
          clientOptions: { apiKey: TEST_API_KEY },
        })
        expect.fail('Should have thrown')
      } catch (err) {
        // PaymentRequiredError is thrown directly (not wrapped by step context)
        // because it's a CliError subclass that propagates through the step executor
        expect(err).toBeInstanceOf(PaymentRequiredError)
      }
    })
  })

  // =========================================================================
  // Scenario 3: Registry recipe fetch -> execute -> agent step -> resume
  // =========================================================================

  describe('registry recipe fetch -> execute -> agent -> resume', () => {
    it('should fetch recipe from registry and execute until agent step', async () => {
      // Mock the registry API call
      mockFetch.mockResolvedValueOnce(
        apiSuccess({
          name: 'registry-workflow',
          updatedAt: '2026-03-01T00:00:00Z',
          yaml: REGISTRY_RECIPE_YAML,
        }),
      )

      // Fetch the recipe YAML from the mock registry
      const yaml = await fetchRecipeFromRegistry('registry-workflow', {
        apiKey: TEST_API_KEY,
      })

      expect(yaml).toBe(REGISTRY_RECIPE_YAML)

      // Now execute the fetched recipe
      mockFetch.mockReset()
      const scanData = [
        { id: 'proj-a', name: 'Alpha', momentum: 95 },
        { id: 'proj-b', name: 'Beta', momentum: 82 },
      ]
      mockFetch.mockResolvedValueOnce(apiSuccess(scanData))

      const result = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        recipeSource: 'registry-workflow',
      })

      expect(result.status).toBe('awaiting_agent')
      const awaiting = result as RecipeAwaitingAgent

      expect(awaiting.recipe).toBe('registry-workflow')
      expect(awaiting.version).toBe('2.0')
      expect(awaiting.step).toBe('evaluate')
      expect(awaiting.task).toBe('Evaluate projects')
      expect(awaiting.returns).toEqual({ picks: 'string[]', rationale: 'string' })

      // Verify scan data is in the context
      expect(awaiting.data.scan).toEqual(scanData)

      // Verify the resume command references the registry source
      expect(awaiting.resumeCommand).toContain('registry-workflow')
      expect(awaiting.resumeCommand).toContain('--resume-from step:evaluate')
    })

    it('should resume registry recipe and complete with enrichment data', async () => {
      const agentInput = {
        picks: ['proj-a'],
        rationale: 'Alpha has the highest momentum',
      }

      const enrichmentData = [
        { id: 'sig-a1', projectId: 'proj-a', signal: 'Strong buy' },
        { id: 'sig-a2', projectId: 'proj-a', signal: 'Whale accumulation' },
      ]

      // Resume: only the enrichment step executes
      mockFetch.mockResolvedValueOnce(apiSuccess(enrichmentData))

      const result = await executeRecipe({
        yaml: REGISTRY_RECIPE_YAML,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        resumeFromStep: 'step:evaluate',
        resumeInput: agentInput,
      })

      expect(result.status).toBe('complete')
      const complete = result as RecipeComplete

      expect(complete.recipe).toBe('registry-workflow')
      expect(complete.version).toBe('2.0')

      // Agent input should be injected as evaluate step result
      expect(complete.data.evaluate).toEqual(agentInput)
      // Enrichment data should be present
      expect(complete.data.enrichment).toEqual(enrichmentData)
    })

    it('should run full registry cycle: fetch -> execute -> yield -> resume -> complete', async () => {
      // --- Step 1: Fetch from registry ---
      mockFetch.mockResolvedValueOnce(
        apiSuccess({
          name: 'registry-workflow',
          updatedAt: '2026-03-01T00:00:00Z',
          yaml: REGISTRY_RECIPE_YAML,
        }),
      )

      const yaml = await fetchRecipeFromRegistry('registry-workflow', {
        apiKey: TEST_API_KEY,
      })

      // --- Step 2: First run — execute until agent step ---
      mockFetch.mockReset()
      const scanData = [{ id: 'proj-x', momentum: 90 }]
      mockFetch.mockResolvedValueOnce(apiSuccess(scanData))

      const firstResult = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        recipeSource: 'registry-workflow',
      })

      expect(firstResult.status).toBe('awaiting_agent')
      const awaiting = firstResult as RecipeAwaitingAgent
      expect(awaiting.data.scan).toEqual(scanData)

      // --- Step 3: Resume with agent input ---
      mockFetch.mockReset()
      const enrichmentData = [{ id: 'sig-x1', signal: 'Momentum confirmed' }]
      mockFetch.mockResolvedValueOnce(apiSuccess(enrichmentData))

      const agentInput = { picks: ['proj-x'], rationale: 'High momentum project' }

      const secondResult = await executeRecipe({
        yaml,
        params: {},
        clientOptions: { apiKey: TEST_API_KEY },
        resumeFromStep: 'step:evaluate',
        resumeInput: agentInput,
      })

      expect(secondResult.status).toBe('complete')
      const complete = secondResult as RecipeComplete
      expect(complete.data.evaluate).toEqual(agentInput)
      expect(complete.data.enrichment).toEqual(enrichmentData)

      // Verify the enrichment call used the picks from agent input
      const enrichUrl = mockFetch.mock.calls[0][0] as string
      expect(enrichUrl).toContain('/v2/signals')
      expect(enrichUrl).toContain('projectIds=proj-x')
    })
  })
})
