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

const MOCK_SIGNALS = [
  {
    id: 'sig-1',
    detectedAt: '2026-02-28T12:00:00Z',
    reinforcedAt: '2026-03-01T08:00:00Z',
    description: 'Significant increase in DeFi TVL across Ethereum L2s',
    projectName: 'Ethereum',
    projectId: 'proj-eth',
    category: 'DeFi',
    hasOfficialSource: true,
    clusters: [
      { id: 'c1', name: 'DeFi Trends' },
      { id: 'c2', name: 'L2 Growth' },
    ],
    activity: [
      { date: '2026-03-01', source: 'twitter' },
    ],
  },
  {
    id: 'sig-2',
    detectedAt: '2026-02-27T15:00:00Z',
    reinforcedAt: '2026-03-01T06:00:00Z',
    description: 'New institutional custody solution launched',
    projectName: 'Bitcoin',
    projectId: 'proj-btc',
    category: 'Adoption',
    hasOfficialSource: false,
    clusters: [
      { id: 'c3', name: 'Institutional' },
    ],
    activity: [],
  },
]

describe('signals commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-signals-test-'))
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
    setConfigPath(join(tmpdir(), 'aixbt-signals-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // -- signals list --

  describe('signals list', () => {
    it('should fetch signals with default params in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_SIGNALS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'signals'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/signals')
      expect(callUrl.searchParams.get('page')).toBe('1')
      expect(callUrl.searchParams.get('limit')).toBeNull()
      expect(callUrl.searchParams.get('sortBy')).toBe('createdAt')

      // Verify JSON output
      const jsonOutput = logs.find(l => l.includes('Ethereum'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toHaveLength(2)
      expect(parsed.data[0].projectName).toBe('Ethereum')
      expect(parsed.data[1].projectName).toBe('Bitcoin')
    })

    it('should pass filter options as query params', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [MOCK_SIGNALS[0]] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'signals',
          '--cluster-ids', 'c1,c2',
          '--categories', 'DeFi',
          '--detected-after', '2026-01-01',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('clusterIds')).toBe('c1,c2')
      expect(callUrl.searchParams.get('categories')).toBe('DeFi')
      expect(callUrl.searchParams.get('detectedAfter')).toBe('2026-01-01')
    })

    it('should pass all date range filters', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'signals',
          '--detected-after', '2026-01-01',
          '--detected-before', '2026-02-01',
          '--reinforced-after', '2026-01-15',
          '--reinforced-before', '2026-02-15',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('detectedAfter')).toBe('2026-01-01')
      expect(callUrl.searchParams.get('detectedBefore')).toBe('2026-02-01')
      expect(callUrl.searchParams.get('reinforcedAfter')).toBe('2026-01-15')
      expect(callUrl.searchParams.get('reinforcedBefore')).toBe('2026-02-15')
    })

    it('should pass project filter options', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'signals',
          '--project-ids', 'proj-1,proj-2',
          '--names', 'Bitcoin,Ethereum',
          '--x-handles', 'bitcoin,ethereum',
          '--tickers', 'BTC,ETH',
          '--address', '0xabc123',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('projectIds')).toBe('proj-1,proj-2')
      expect(callUrl.searchParams.get('names')).toBe('Bitcoin,Ethereum')
      expect(callUrl.searchParams.get('xHandles')).toBe('bitcoin,ethereum')
      expect(callUrl.searchParams.get('tickers')).toBe('BTC,ETH')
      expect(callUrl.searchParams.get('address')).toBe('0xabc123')
    })

    it('should display card layout with project name, category, and description', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_SIGNALS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      // Project names shown
      expect(allOutput).toContain('Ethereum')
      expect(allOutput).toContain('Bitcoin')
      // Categories shown inline
      expect(allOutput).toContain('DeFi')
      expect(allOutput).toContain('Adoption')
      // Descriptions shown inline (no label)
      expect(allOutput).toContain('Significant increase in DeFi TVL across Ethereum L2s')
      expect(allOutput).toContain('New institutional custody solution launched')
      // Detected/Reinforced in meta line
      expect(allOutput).toContain('Detected')
      expect(allOutput).toContain('Reinforced')
      // Cluster names shown via dots
      expect(allOutput).toContain('DeFi Trends')
      expect(allOutput).toContain('Institutional')
      // Verbose hint shown
      expect(allOutput).toContain('-v')
    })

    it('should display OFFICIAL badge when hasOfficialSource is true', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [MOCK_SIGNALS[0]] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('OFFICIAL')
    })

    it('should display HOT badge when signal has 3 or more clusters', async () => {
      const hotSignal = {
        ...MOCK_SIGNALS[0],
        clusters: [
          { id: 'c1', name: 'DeFi Trends' },
          { id: 'c2', name: 'L2 Growth' },
          { id: 'c3', name: 'Market Sentiment' },
        ],
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [hotSignal] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('HOT')
    })

    it('should not display HOT badge when signal has fewer than 3 clusters', async () => {
      // sig-2 has only 1 cluster and hasOfficialSource: false
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [MOCK_SIGNALS[1]] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).not.toContain('HOT')
      expect(allOutput).not.toContain('OFFICIAL')
    })

    it('should display verbose output with -v flag including cluster names', async () => {
      const signalWithActivity = {
        ...MOCK_SIGNALS[0],
        activity: [
          { date: '2026-03-01', source: 'twitter', incoming: 'L2 TVL surge detected' },
          { date: '2026-03-02', source: 'twitter', incoming: 'Continued growth confirmed', result: 'Signal reinforced' },
        ],
      }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [signalWithActivity] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-v', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      // Project name still shown
      expect(allOutput).toContain('Ethereum')
      // Cluster names shown via dots
      expect(allOutput).toContain('DeFi Trends')
      expect(allOutput).toContain('L2 Growth')
      // Activity section shown when activity.length > 1
      expect(allOutput).toContain('activity')
    })

    it('should show pagination hint when hasMore is true', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: MOCK_SIGNALS,
          pagination: { page: 1, limit: 20, totalCount: 50, hasMore: true },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('page 1')
      expect(allOutput).toContain('of 50')
      expect(allOutput).toContain('--page 2')
    })

    it('should not show next page hint when hasMore is false', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: MOCK_SIGNALS,
          pagination: { page: 1, limit: 20, totalCount: 2, hasMore: false },
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('page 1')
      expect(allOutput).not.toContain('--page 2')
    })

    it('should show verbose hint when signal list is empty', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('-v')
    })
  })

  // -- signals categories --

  describe('signals categories', () => {
    const MOCK_CATEGORIES = [
      { id: 'cat-1', name: 'DeFi', description: 'Decentralized finance signals' },
      { id: 'cat-2', name: 'Adoption', description: 'Adoption and institutional signals' },
      { id: 'cat-3', name: 'Security', description: 'Security and vulnerability signals' },
    ]

    it('should fetch categories in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CATEGORIES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'signals', 'categories'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/signal-categories')

      const jsonOutput = logs.find(l => l.includes('DeFi'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toHaveLength(3)
      expect(parsed.data[0].name).toBe('DeFi')
      expect(parsed.data[1].name).toBe('Adoption')
    })

    it('should display cards without descriptions by default', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CATEGORIES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals', 'categories'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('DeFi')
      expect(allOutput).toContain('Security')
      expect(allOutput).not.toContain('Decentralized finance signals')
      expect(allOutput).toContain('Use -v for category descriptions')
    })

    it('should show descriptions with -v', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CATEGORIES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals', 'categories', '-v'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('DeFi')
      expect(allOutput).toContain('Decentralized finance signals')
      expect(allOutput).not.toContain('Use -v for category descriptions')
    })

    it('should show empty state when no categories', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'signals', 'categories'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No categories available')
    })

    it('should not require auth (uses public client)', async () => {
      delete process.env.AIXBT_API_KEY

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CATEGORIES }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'signals', 'categories'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })
  })

  // -- date resolver integration --

  describe('date resolver', () => {
    it('should resolve relative time for --detected-after', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'signals', '--detected-after', '-7d'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('detectedAfter')).toBe('2026-03-18T12:00:00.000Z')

      vi.useRealTimers()
    })

    it('should resolve relative time for all date options', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'signals',
          '--detected-after', '-7d',
          '--detected-before', '-1d',
          '--reinforced-after', '-24h',
          '--reinforced-before', '-30m',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('detectedAfter')).toBe('2026-03-18T12:00:00.000Z')
      expect(callUrl.searchParams.get('detectedBefore')).toBe('2026-03-24T12:00:00.000Z')
      expect(callUrl.searchParams.get('reinforcedAfter')).toBe('2026-03-24T12:00:00.000Z')
      expect(callUrl.searchParams.get('reinforcedBefore')).toBe('2026-03-25T11:30:00.000Z')

      vi.useRealTimers()
    })

    it('should pass through ISO dates without resolving', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'signals', '--detected-after', '2026-01-01T00:00:00Z'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('detectedAfter')).toBe('2026-01-01T00:00:00Z')
    })
  })

  // -- auth modes --

  describe('auth modes', () => {
    it('should send API key in headers when authenticated', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_SIGNALS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'signals'], { from: 'node' })

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-key-123')
    })
  })
})
