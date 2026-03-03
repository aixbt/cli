import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../../src/cli.js'
import { setConfigPath } from '../../src/lib/config.js'
import { CliError } from '../../src/lib/errors.js'

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

// -- Helpers --

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response
}

// -- Mock data --

const MOCK_CLUSTERS = [
  {
    id: 'cluster-1',
    name: 'DeFi Trends',
    description: 'Signals related to decentralized finance trends and protocols',
  },
  {
    id: 'cluster-2',
    name: 'Market Sentiment',
    description: 'Signals related to overall market sentiment and macro indicators',
  },
  {
    id: 'cluster-3',
    name: 'L2 Growth',
    description: 'Layer 2 ecosystem growth and adoption signals',
  },
]

describe('clusters commands', () => {
  let tempDir: string
  let logs: string[]
  let errors: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-clusters-test-'))
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
    setConfigPath(join(tmpdir(), 'aixbt-clusters-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // -- clusters list --

  describe('clusters list', () => {
    it('should fetch clusters in JSON mode', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'clusters'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/clusters')

      // Verify JSON output
      const jsonOutput = logs.find(l => l.includes('cluster-1'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed).toHaveLength(3)
      expect(parsed[0].name).toBe('DeFi Trends')
      expect(parsed[1].name).toBe('Market Sentiment')
      expect(parsed[2].name).toBe('L2 Growth')
    })

    it('should not pass any query params to the API', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'clusters'], { from: 'node' })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      // Clusters endpoint takes no params
      expect(callUrl.search).toBe('')
    })

    it('should display table output with name, description, and ID', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'clusters'], { from: 'node' })

      const allOutput = logs.join('\n')
      // Table headers
      expect(allOutput).toContain('Name')
      expect(allOutput).toContain('Description')
      expect(allOutput).toContain('ID')
      // Data rows
      expect(allOutput).toContain('DeFi Trends')
      expect(allOutput).toContain('Market Sentiment')
      expect(allOutput).toContain('L2 Growth')
      expect(allOutput).toContain('cluster-1')
      // Footer count
      expect(allOutput).toContain('3 clusters')
    })

    it('should show "No results" when cluster list is empty', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: [] }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'clusters'], { from: 'node' })

      const allOutput = logs.join('\n')
      expect(allOutput).toContain('No results')
    })
  })

  // -- pay-per-use guard --

  describe('pay-per-use guard', () => {
    it('should throw CliError with X402_NOT_AVAILABLE when --pay-per-use is used', async () => {
      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(['node', 'aixbt', '--pay-per-use', 'clusters'], { from: 'node' }),
      ).rejects.toThrow()

      // Verify the error is a CliError with the correct code
      try {
        const p = createProgram()
        p.exitOverride()
        await p.parseAsync(['node', 'aixbt', '--pay-per-use', 'clusters'], { from: 'node' })
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('X402_NOT_AVAILABLE')
        expect((err as CliError).message).toContain('Pay-per-use is not available')
      }
    })

    it('should not call the API when --pay-per-use is used', async () => {
      const program = createProgram()
      program.exitOverride()

      try {
        await program.parseAsync(['node', 'aixbt', '--pay-per-use', 'clusters'], { from: 'node' })
      } catch {
        // Expected to throw
      }

      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // -- auth modes --

  describe('auth modes', () => {
    it('should work with --delayed flag (no auth required)', async () => {
      delete process.env.AIXBT_API_KEY

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', '--delayed', 'clusters'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBeUndefined()
    })

    it('should send API key in headers when authenticated', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--json', 'clusters'], { from: 'node' })

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-key-123')
    })
  })
})
