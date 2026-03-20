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
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'clusters'], { from: 'node' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      expect(callUrl.pathname).toBe('/v2/clusters')

      // Verify JSON output
      const jsonOutput = logs.find(l => l.includes('cluster-1'))
      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput!)
      expect(parsed.data).toHaveLength(3)
      expect(parsed.data[0].name).toBe('DeFi Trends')
      expect(parsed.data[1].name).toBe('Market Sentiment')
      expect(parsed.data[2].name).toBe('L2 Growth')
    })

    it('should not pass any query params to the API', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'clusters'], { from: 'node' })

      const callUrl = new URL(mockFetch.mock.calls[0][0] as string)
      // Clusters endpoint takes no params
      expect(callUrl.search).toBe('')
    })

    it('should display card layout with name, description, and ID', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-v', 'clusters'], { from: 'node' })

      const allOutput = logs.join('\n')
      // Card titles (cluster names)
      expect(allOutput).toContain('DeFi Trends')
      expect(allOutput).toContain('Market Sentiment')
      expect(allOutput).toContain('L2 Growth')
      // Card fields
      expect(allOutput).toContain('ID')
      expect(allOutput).toContain('cluster-1')
      expect(allOutput).toContain('cluster-2')
      expect(allOutput).toContain('cluster-3')
      expect(allOutput).toContain('Description')
      expect(allOutput).toContain('Signals related to decentralized finance')
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

  // -- auth modes --

  describe('auth modes', () => {
    it('should work with --delayed flag (no auth required)', async () => {
      delete process.env.AIXBT_API_KEY

      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: MOCK_CLUSTERS }),
      )

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '--format', 'json', '--delayed', 'clusters'], { from: 'node' })

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
      await program.parseAsync(['node', 'aixbt', '--format', 'json', 'clusters'], { from: 'node' })

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-key-123')
    })
  })
})
