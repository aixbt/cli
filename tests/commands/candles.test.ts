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

// -- Mock @inquirer/prompts --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

// -- Mock data --

const MOCK_CANDLES = {
  projectId: 'proj-1',
  projectName: 'Bitcoin',
  interval: '1h',
  candles: [
    [1712700000000, 69000, 69500, 68800, 69200, 12345678],
    [1712703600000, 69200, 69800, 69100, 69700, 12456789],
    [1712707200000, 69700, 70100, 69600, 70000, 12567890],
  ],
}

describe('projects candles command', () => {
  let tempDir: string
  let logs: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-candles-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    process.env.AIXBT_API_KEY = 'test-key-123'
    logs = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-candles-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // API endpoint and params
  // -----------------------------------------------------------------------

  it('should call the correct API endpoint with project ID', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1'],
      { from: 'node' },
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.pathname).toBe('/v2/projects/proj-1/candles')
  })

  it('should default interval to 1h', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('interval')).toBe('1h')
  })

  it('should pass --interval as query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: { ...MOCK_CANDLES, interval: '5m' } }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1', '--interval', '5m'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('interval')).toBe('5m')
  })

  it('should pass --start and --end as query params', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1',
       '--start', '2026-04-01', '--end', '2026-04-10'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('start')).toBe('2026-04-01')
    expect(callUrl.searchParams.get('end')).toBe('2026-04-10')
  })

  it('should pass --at as query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1', '--at', '2026-04-09T00:00:00Z'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('at')).toBe('2026-04-09T00:00:00Z')
  })

  // -----------------------------------------------------------------------
  // Relative date resolution
  // -----------------------------------------------------------------------

  it('should resolve relative dates for --start and --end', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'))

    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1',
       '--start', '-7d', '--end', '-1d'],
      { from: 'node' },
    )

    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.searchParams.get('start')).toBe('2026-04-03T12:00:00.000Z')
    expect(callUrl.searchParams.get('end')).toBe('2026-04-09T12:00:00.000Z')

    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // JSON output
  // -----------------------------------------------------------------------

  it('should output candle data as JSON in json format', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1'],
      { from: 'node' },
    )

    const jsonOut = logs.find(l => l.includes('"projectName"'))
    expect(jsonOut).toBeDefined()
    const parsed = JSON.parse(jsonOut!)
    expect(parsed.data.projectName).toBe('Bitcoin')
    expect(parsed.data.candles).toHaveLength(3)
  })

  // -----------------------------------------------------------------------
  // URL encoding
  // -----------------------------------------------------------------------

  it('should URL-encode the project ID', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'id/with/slashes'],
      { from: 'node' },
    )

    const callUrl = mockFetch.mock.calls[0][0] as string
    expect(callUrl).toContain('id%2Fwith%2Fslashes')
  })

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  it('should send API key in headers', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_CANDLES }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(
      ['node', 'aixbt', '--format', 'json', 'projects', 'candles', 'proj-1'],
      { from: 'node' },
    )

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('test-key-123')
  })
})
