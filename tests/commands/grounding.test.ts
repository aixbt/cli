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
    narratives: {
      title: 'Narratives',
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

  it('should fetch grounding and output data in JSON mode', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 200, data: MOCK_GROUNDING }),
    )

    const program = createProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'aixbt', '--format', 'json', 'grounding'], { from: 'node' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(callUrl.pathname).toBe('/v2/grounding/latest')

    const jsonOutput = logs.find(l => l.includes('Narratives'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.data.sections.narratives.items).toHaveLength(3)
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
    expect(allOutput).toContain('Narratives')
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
    expect(allOutput).toContain('updates every 12h')
  })
})
