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

const MOCK_GROUNDING = {
  createdAt: '2026-03-25T12:00:00Z',
  windowHours: 12,
  sections: {
    crypto: {
      title: 'Crypto & Digital Assets',
      items: ['BTC dominance rising', 'DeFi TVL expanding', 'Meme coins cooling'],
      generatedAt: '2026-03-25T11:00:00Z',
    },
    macro: {
      title: 'Global Liquidity',
      items: ['Fed holding rates', 'Dollar weakening', 'Bond yields stable'],
      generatedAt: '2026-03-25T11:00:00Z',
    },
    geopolitics: {
      title: 'Geopolitics',
      items: ['Trade tensions easing', 'EU regulation clarity', 'Asian markets bullish'],
      generatedAt: '2026-03-25T11:00:00Z',
    },
  },
}

const MOCK_HISTORY_SNAPSHOTS = [
  {
    createdAt: '2026-03-25T12:00:00.000Z',
    windowHours: 12,
    sections: {
      crypto: {
        title: 'Crypto & Digital Assets',
        items: ['BTC dominance rising'],
        generatedAt: '2026-03-25T11:00:00Z',
      },
    },
  },
  {
    createdAt: '2026-03-25T11:00:00.000Z',
    windowHours: 12,
    sections: {
      crypto: {
        title: 'Crypto & Digital Assets',
        items: ['ETH staking surge'],
        generatedAt: '2026-03-25T10:00:00Z',
      },
      macro: {
        title: 'Global Liquidity',
        items: ['Fed holding rates'],
        generatedAt: '2026-03-25T10:00:00Z',
      },
    },
  },
]

const MOCK_HISTORY_PAGINATION = {
  page: 1,
  limit: 50,
  totalCount: 168,
  hasMore: true,
}

function historyResponse(data = MOCK_HISTORY_SNAPSHOTS, pagination = MOCK_HISTORY_PAGINATION) {
  return jsonResponse(200, { status: 200, data, pagination })
}

describe('grounding command', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-grounding-test-'))
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
    setConfigPath(join(tmpdir(), 'aixbt-grounding-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('should fetch grounding from /v2/grounding/latest and output data in JSON mode', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'aixbt', '--format', 'json', 'grounding'], { from: 'node' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.pathname).toBe('/v2/grounding/latest')

    const jsonOutput = logs.find(l => l.includes('Crypto & Digital Assets'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.data.sections.crypto.items).toHaveLength(3)
    expect(parsed.data.sections.macro.title).toBe('Global Liquidity')
    expect(parsed.data.sections.geopolitics.items).toContain('Trade tensions easing')
  })

  it('should pass --at option as query parameter', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'grounding', '--at', '2026-03-20T00:00:00Z'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('at')).toBe('2026-03-20T00:00:00Z')
  })

  it('should resolve relative --at to ISO timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'grounding', '--at', '-24h'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('at')).toBe('2026-03-24T12:00:00.000Z')

    vi.useRealTimers()
  })

  it('should render section titles and bullet items in human mode', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'aixbt', 'grounding'], { from: 'node' })

    const allOutput = logs.join('\n')
    // Section titles
    expect(allOutput).toContain('Crypto & Digital Assets')
    expect(allOutput).toContain('Global Liquidity')
    expect(allOutput).toContain('Geopolitics')
    // Bullet items from each section
    expect(allOutput).toContain('BTC dominance rising')
    expect(allOutput).toContain('Fed holding rates')
    expect(allOutput).toContain('Trade tensions easing')
    // Bullet character
    expect(allOutput).toContain('•')
  })

  it('should show refresh footer in human mode', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'aixbt', 'grounding'], { from: 'node' })

    const allOutput = logs.join('\n')
    expect(allOutput).toContain('ago')
    expect(allOutput).toContain('refreshes hourly')
    expect(allOutput).toContain('12h window')
  })

  describe('--sections flag', () => {
    it('should pass --sections as query parameter to the API', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', '--sections', 'crypto,macro'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('sections')).toBe('crypto,macro')
    })

    it('should pass single --sections value as query parameter', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', '--sections', 'crypto'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('sections')).toBe('crypto')
    })

    it('should accept --section (singular) as a backward-compatible alias', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', '--section', 'macro'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('sections')).toBe('macro')
    })

    it('should not include sections param when not specified', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.has('sections')).toBe(false)
    })
  })

  describe('grounding history subcommand', () => {
    it('should fetch from /v2/grounding/history and output JSON', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', 'history'],
        { from: 'node' },
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/grounding/history')
    })

    it('should include pagination in JSON output when present', async () => {
      const pagination = { page: 1, limit: 50, totalCount: 168, hasMore: true }
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 200,
          data: MOCK_HISTORY_SNAPSHOTS,
          pagination,
        }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', 'history'],
        { from: 'node' },
      )

      const jsonOutput = logs.find(l => l.includes('"pagination"'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.pagination).toEqual(pagination)
    })

    it('should pass --from and --to as query parameters', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'grounding', 'history',
          '--from', '2026-03-20T00:00:00Z',
          '--to', '2026-03-25T00:00:00Z',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('from')).toBe('2026-03-20T00:00:00Z')
      expect(callUrl.searchParams.get('to')).toBe('2026-03-25T00:00:00Z')
    })

    it('should pass --at as query parameter for anchor clamping', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'grounding', 'history',
          '--at', '2026-03-24T00:00:00Z',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('at')).toBe('2026-03-24T00:00:00Z')
    })

    it('should pass --sections as query parameter', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'grounding', 'history',
          '--sections', 'crypto,macro',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('sections')).toBe('crypto,macro')
    })

    it('should pass --page and --limit as query parameters', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        [
          'node', 'aixbt', '--format', 'json', 'grounding', 'history',
          '--page', '3',
          '--limit', '20',
        ],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('page')).toBe('3')
      expect(callUrl.searchParams.get('limit')).toBe('20')
    })

    it('should default page to 1 and limit to 50', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', 'history'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('page')).toBe('1')
      expect(callUrl.searchParams.get('limit')).toBe('50')
    })

    it('should resolve relative --from to ISO timestamp', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', '--format', 'json', 'grounding', 'history', '--from', '-7d'],
        { from: 'node' },
      )

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.searchParams.get('from')).toBe('2026-03-18T12:00:00.000Z')

      vi.useRealTimers()
    })

    it('should display pagination info in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Showing 2 of 168')
      expect(allOutput).toContain('page 1')
    })

    it('should show next page hint when hasMore is true', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('--page 2')
    })

    it('should not show next page hint when hasMore is false', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(MOCK_HISTORY_SNAPSHOTS, { page: 4, limit: 50, totalCount: 168, hasMore: false }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('page 4')
      expect(allOutput).not.toContain('--page')
    })

    it('should display snapshot timestamps as dividers in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('2026-03-25T12:00:00.000Z')
      expect(allOutput).toContain('2026-03-25T11:00:00.000Z')
    })

    it('should display section content for each snapshot in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse(),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      // Items from first snapshot
      expect(allOutput).toContain('BTC dominance rising')
      // Items from second snapshot
      expect(allOutput).toContain('ETH staking surge')
      expect(allOutput).toContain('Fed holding rates')
      // Section titles
      expect(allOutput).toContain('Crypto & Digital Assets')
      expect(allOutput).toContain('Global Liquidity')
    })

    it('should handle empty history response in human mode', async () => {
      mockFetch.mockResolvedValueOnce(
        historyResponse([], { page: 1, limit: 50, totalCount: 0, hasMore: false }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(
        ['node', 'aixbt', 'grounding', 'history'],
        { from: 'node' },
      )

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('Showing 0 of 0')
      // No snapshot dividers should appear
      expect(allOutput).not.toContain('───')
    })
  })
})
