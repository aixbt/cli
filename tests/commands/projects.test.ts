import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath } from '../../src/lib/config.js'
import { jsonResponse } from '../helpers.js'

// -- Mock fetch globally --

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// -- Mock ora (suppress spinners in tests) --

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}))

// -- Mock @inquirer/prompts (imported by login.ts which is registered on the program) --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

// -- Mock data --

const MOCK_PROJECTS = [
  {
    id: 'proj-1',
    name: 'Bitcoin',
    xHandle: 'bitcoin',
    momentumScore: 85.5,
    popularityScore: 100,
    signals: [{ id: 's1', category: 'DeFi', description: 'Test signal' }],
  },
  {
    id: 'proj-2',
    name: 'Ethereum',
    xHandle: 'ethereum',
    momentumScore: 72.3,
    popularityScore: 95,
    signals: [],
  },
]

const MOCK_PROJECT_DETAIL = {
  id: 'proj-1',
  name: 'Bitcoin',
  xHandle: 'bitcoin',
  description: 'The first cryptocurrency',
  momentumScore: 85.5,
  popularityScore: 100,
  metrics: {
    usd: 65000.123456,
    usdMarketCap: 1300000000000,
    usd24hVol: 25000000000,
    usd24hChange: 2.35,
    lastUpdatedAt: 1709433600,
  },
  tokens: [{ chain: 'bitcoin', address: 'native', source: 'coingecko' }],
  coingeckoData: {
    apiId: 'bitcoin',
    type: 'coin',
    symbol: 'BTC',
    slug: 'bitcoin',
    description: 'Bitcoin is a cryptocurrency',
    homepage: 'https://bitcoin.org',
    contractAddress: '',
    categories: ['Cryptocurrency', 'Store of Value'],
  },
  signals: [
    { id: 's1', category: 'DeFi', description: 'BTC DeFi adoption increasing across L2s' },
    { id: 's2', category: 'Adoption', description: 'Institutional buying pressure detected' },
  ],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  reinforcedAt: '2026-03-01T00:00:00Z',
}

const MOCK_MOMENTUM = {
  projectId: 'proj-1',
  projectName: 'Bitcoin',
  data: [
    {
      timestamp: '2026-02-28T00:00:00Z',
      momentumScore: 82.1,
      clusters: [
        { id: 'c1', name: 'DeFi Trends', count: 15 },
        { id: 'c2', name: 'Market Sentiment', count: 8 },
      ],
    },
    {
      timestamp: '2026-03-01T00:00:00Z',
      momentumScore: 85.5,
      clusters: [{ id: 'c1', name: 'DeFi Trends', count: 20 }],
    },
  ],
}

const MOCK_CHAINS = ['ethereum', 'solana', 'base', 'arbitrum', 'bitcoin']

describe('projects commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-projects-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = 'test-key-123'
    logs = []
    errors = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-projects-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // -- projects list --

  describe('projects list', () => {
    it('should fetch projects with default params in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECTS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'projects'], { from: 'node' })

      // Verify the correct API endpoint was called
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects')
      expect(callUrl.searchParams.get('page')).toBe('1')
      expect(callUrl.searchParams.get('limit')).toBeNull()
      expect(callUrl.searchParams.get('sortBy')).toBe('momentumScore')

      // Verify JSON output contains project data
      const jsonOutput = logs.find(l => l.includes('Bitcoin'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toHaveLength(2)
      expect(parsed.data[0].name).toBe('Bitcoin')
      expect(parsed.data[1].name).toBe('Ethereum')
    })

    it('should pass filter options as query params', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [MOCK_PROJECTS[0]] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'projects', '--chain', 'ethereum', '--min-momentum', '50', '--limit', '10'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('chain')).toBe('ethereum')
      expect(callUrl.searchParams.get('minMomentum')).toBe('50')
      expect(callUrl.searchParams.get('limit')).toBe('10')
    })

    it('should display human output with score, name, rationale, and 24h change', async () => {
      const projectsWithRationale = [
        {
          ...MOCK_PROJECTS[0],
          rationale: 'Institutional interest rising',
          coingeckoData: { apiId: 'bitcoin', type: 'coin', symbol: 'BTC', slug: 'bitcoin', description: '', homepage: '', contractAddress: '', categories: [] },
          metrics: { usd: 50000, usdMarketCap: 1e12, usd24hVol: 5e10, usd24hChange: 2.5, lastUpdatedAt: 0 },
        },
        {
          ...MOCK_PROJECTS[1],
          rationale: 'DeFi ecosystem expanding',
          coingeckoData: { apiId: 'ethereum', type: 'coin', symbol: 'ETH', slug: 'ethereum', description: '', homepage: '', contractAddress: '', categories: [] },
          metrics: { usd: 3000, usdMarketCap: 3.6e11, usd24hVol: 2e10, usd24hChange: -1.2, lastUpdatedAt: 0 },
        },
      ]
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: projectsWithRationale }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects'], { from: 'node' })

      const allOutput = logs.join('\n')
      // New table headers
      expect(allOutput).toContain('Score')
      expect(allOutput).toContain('Name')
      expect(allOutput).toContain('Rationale')
      expect(allOutput).toContain('24h')
      // Project names with ticker suffix
      expect(allOutput).toContain('Bitcoin')
      expect(allOutput).toContain('BTC')
      expect(allOutput).toContain('Ethereum')
      expect(allOutput).toContain('ETH')
      // Score should be shown as-is from API
      expect(allOutput).toContain('85.5')
      expect(allOutput).toContain('72.3')
      // 24h change values
      expect(allOutput).toContain('2.50%')
      expect(allOutput).toContain('1.20%')
      // Rationale should be shown
      expect(allOutput).toContain('Institutional interest rising')
      expect(allOutput).toContain('DeFi ecosystem expanding')
      // Verbose hint should be shown
      expect(allOutput).toContain('-v')
    })

    it('should display card layout with -v flag', async () => {
      const projectsWithDetails = [
        {
          ...MOCK_PROJECTS[0],
          description: 'The first cryptocurrency',
          rationale: 'Institutional interest rising',
          coingeckoData: { apiId: 'bitcoin', type: 'coin', symbol: 'BTC', slug: 'bitcoin', description: '', homepage: '', contractAddress: '', categories: [] },
          tokens: [{ chain: 'bitcoin', address: 'native', source: 'coingecko' }],
          createdAt: '2024-01-01T00:00:00Z',
          reinforcedAt: '2026-03-01T00:00:00Z',
        },
      ]
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: projectsWithDetails }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-v', 'projects'], { from: 'node' })

      const allOutput = logs.join('\n')
      // Card layout should show project name
      expect(allOutput).toContain('Bitcoin')
      // Ticker as subtitle
      expect(allOutput).toContain('$BTC')
      // Card fields
      expect(allOutput).toContain('ID')
      expect(allOutput).toContain('proj-1')
      expect(allOutput).toContain('Score')
      expect(allOutput).toContain('Popularity')
      expect(allOutput).toContain('X Handle')
      expect(allOutput).toContain('@bitcoin')
      expect(allOutput).toContain('Description')
      expect(allOutput).toContain('The first cryptocurrency')
      expect(allOutput).toContain('Rationale')
      expect(allOutput).toContain('Institutional interest rising')
      expect(allOutput).toContain('Signals')
      expect(allOutput).toContain('Tokens')
      expect(allOutput).toContain('Created')
      expect(allOutput).toContain('Reinforced')
    })

    it('should show pagination hint when hasMore is true', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: MOCK_PROJECTS,
          pagination: { page: 1, limit: 20, totalCount: 100, hasMore: true },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('page 1')
      expect(allOutput).toContain('of 100')
      expect(allOutput).toContain('--page 2')
    })

    it('should not show next page hint when hasMore is false', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: MOCK_PROJECTS,
          pagination: { page: 1, limit: 20, totalCount: 2, hasMore: false },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('page 1')
      expect(allOutput).not.toContain('--page 2')
    })

    it('should pass has-token and exclude-stables filters', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'projects', '--has-token', 'true', '--exclude-stables'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('hasToken')).toBe('true')
      expect(callUrl.searchParams.get('excludeStables')).toBe('true')
    })
  })

  // -- projects detail --

  describe('projects detail', () => {
    it('should fetch project by ID in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECT_DETAIL }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', '-v', 'projects', 'proj-1'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects/proj-1')

      const jsonOutput = logs.find(l => l.includes('Bitcoin'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data.id).toBe('proj-1')
      expect(parsed.data.name).toBe('Bitcoin')
    })

    it('should display key-value output in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECT_DETAIL }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects', 'proj-1'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Bitcoin')
      expect(allOutput).toContain('proj-1')
      expect(allOutput).toContain('@bitcoin')
      expect(allOutput).toContain('85.50')
      // Metrics should be displayed
      expect(allOutput).toContain('Price')
      expect(allOutput).toContain('Market Cap')
      // Token info
      expect(allOutput).toContain('bitcoin')
      // CoinGecko info
      expect(allOutput).toContain('BTC')
    })

    it('should URL-encode the project ID', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { ...MOCK_PROJECT_DETAIL, id: 'proj/special' } }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'projects', 'proj/special'], { from: 'node' })

      const callUrl = mockFetch.mock.calls[0][0] as string
      expect(callUrl).toContain('/v2/projects/proj%2Fspecial')
    })
  })

  // -- projects momentum --

  describe('projects momentum', () => {
    it('should fetch momentum history in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_MOMENTUM }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'projects', 'momentum', 'proj-1'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects/proj-1/momentum')

      const jsonOutput = logs.find(l => l.includes('projectId'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data.projectId).toBe('proj-1')
      expect(parsed.data.data).toHaveLength(2)
    })

    it('should pass start and end date params', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_MOMENTUM }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'projects', 'momentum', 'proj-1', '--start', '2026-01-01', '--end', '2026-02-01'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('start')).toBe('2026-01-01')
      expect(callUrl.searchParams.get('end')).toBe('2026-02-01')
    })

    it('should display human output with momentum data', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_MOMENTUM }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects', 'momentum', 'proj-1'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Momentum History')
      expect(allOutput).toContain('Bitcoin')
      // Table headers
      expect(allOutput).toContain('Score')
      expect(allOutput).toContain('Clusters:mentions')
    })

    it('should show "No momentum data" when data array is empty', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { projectId: 'proj-1', projectName: 'Bitcoin', data: [] } }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects', 'momentum', 'proj-1'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No momentum data')
    })
  })

  // -- projects chains --

  describe('projects chains', () => {
    it('should fetch chains in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CHAINS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'projects', 'chains'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/projects/chains')

      const jsonOutput = logs.find(l => l.includes('ethereum'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toEqual(MOCK_CHAINS)
    })

    it('should display chain list in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CHAINS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects', 'chains'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('ethereum')
      expect(allOutput).toContain('solana')
      expect(allOutput).toContain('base')
      expect(allOutput).toContain('5 chains available')
    })

    it('should show "No chains available" when list is empty', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'projects', 'chains'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No chains available')
    })
  })

  // -- auth modes --

  describe('auth modes', () => {
    it('should work with --delayed flag (no auth required)', async () => {
      delete process.env.AIXBT_API_KEY

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECTS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', '--delayed', 'projects'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      // noAuth mode should not send X-API-Key
      expect(headers['X-API-Key']).toBeUndefined()
    })

    it('should send API key in headers when authenticated', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_PROJECTS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'projects'], { from: 'node' })

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-key-123')
    })
  })
})
