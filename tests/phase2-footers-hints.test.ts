import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../src/cli.js'
import { setConfigPath } from '../src/lib/config.js'
import { outputApiResult, printHints } from '../src/lib/output.js'
import { estimateTokenCount } from '../src/lib/tokens.js'

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}))

// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g, '')

describe('Phase 2: Contextual Footers & Hints', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-phase2-test-'))
    setConfigPath(join(tempDir, 'config.json'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-phase2-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
  })

  // ── outputApiResult with hints ──

  describe('outputApiResult', () => {
    let logs: string[]
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      logs = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
    })

    afterEach(() => {
      consoleSpy.mockRestore()
    })

    it('should include hints in meta when hints are provided', () => {
      outputApiResult({ data: { foo: 1 }, hints: ['hint1'] }, 'json')
      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.hints).toEqual(['hint1'])
    })

    it('should not include meta when hints array is empty', () => {
      outputApiResult({ data: { foo: 1 }, hints: [] }, 'json')
      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeUndefined()
    })

    it('should merge hints with existing meta', () => {
      outputApiResult({ data: { foo: 1 }, meta: { tier: 'free' }, hints: ['hint1'] }, 'json')
      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta.tier).toBe('free')
      expect(parsed.meta.hints).toEqual(['hint1'])
    })

    it('should preserve meta without hints field when no hints provided', () => {
      outputApiResult({ data: { foo: 1 }, meta: { tier: 'free' } }, 'json')
      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.tier).toBe('free')
      expect(parsed.meta.hints).toBeUndefined()
    })

    it('should output only data when no meta and no hints', () => {
      outputApiResult({ data: { foo: 1 } }, 'json')
      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.data).toEqual({ foo: 1 })
      expect(parsed.meta).toBeUndefined()
    })
  })

  // ── printHints ──

  describe('printHints', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let logCalls: unknown[][]

    beforeEach(() => {
      logCalls = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logCalls.push(args)
      })
    })

    afterEach(() => {
      consoleSpy.mockRestore()
    })

    it('should print each hint as dim text via console.log', () => {
      printHints(['first hint', 'second hint'])
      // Each hint() call produces two console.log calls: one blank line + one dim text
      // So 2 hints = 4 console.log calls
      const textCalls = logCalls
        .filter(args => args.length > 0)
        .map(args => stripAnsi(String(args[0])))
      expect(textCalls).toContain('first hint')
      expect(textCalls).toContain('second hint')
    })

    it('should not call console.log for an empty array', () => {
      printHints([])
      expect(logCalls.length).toBe(0)
    })
  })

  // ── estimateTokenCount ──

  describe('estimateTokenCount', () => {
    it('should return correct token estimate for known data', () => {
      const data = { a: 'hello' }
      expect(estimateTokenCount(data)).toBe(4)
    })

    it('should handle empty object', () => {
      expect(estimateTokenCount({})).toBe(1)
    })

    it('should handle nested data', () => {
      const data = { a: { b: { c: 'deep' } } }
      expect(estimateTokenCount(data)).toBe(6)
    })
  })

  // ── Command integration tests ──

  describe('intel command hints', () => {
    let logs: string[]
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>
    const mockFetch = vi.fn()

    const mockIntelData = [
      {
        id: 'sig-1',
        projectName: 'Test',
        projectId: 'proj-1',
        category: 'cat',
        description: 'desc',
        detectedAt: '2026-01-01T00:00:00Z',
        reinforcedAt: '2026-01-01T00:00:00Z',
        hasOfficialSource: false,
        clusters: [],
        activity: [],
      },
    ]

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockReset()
      process.env.AIXBT_API_KEY = 'test-key-123'
      logs = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      vi.unstubAllGlobals()
    })

    it('should include recipe suggestion hint in structured output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockIntelData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', 'intel'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.hints).toContain('For pipeline analysis, try: aixbt recipe run intel_scanner -f toon')
    })

    it('should include verbosity hint in structured output at v0', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockIntelData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', 'intel'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta.hints).toContain('Use -v for activity details')
    })

    it('should not include verbosity hint in structured output at v1', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockIntelData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', '-v', 'intel'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta.hints).not.toContain('Use -v for activity details')
    })

    it('should print recipe suggestion as hint in human output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockIntelData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', 'intel'], { from: 'node' })

      const allOutput = stripAnsi(logs.join('\n'))
      expect(allOutput).toContain('recipe run intel_scanner')
    })
  })

  describe('intel clusters command hints', () => {
    let logs: string[]
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>
    const mockFetch = vi.fn()

    const mockClusterData = [
      { id: 'c-1', name: 'Alpha Cluster', description: 'A test cluster' },
      { id: 'c-2', name: 'Beta Cluster', description: 'Another test cluster' },
    ]

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockReset()
      process.env.AIXBT_API_KEY = 'test-key-123'
      logs = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      vi.unstubAllGlobals()
    })

    it('should include verbosity hint in structured output at v0', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockClusterData,
          pagination: { page: 1, limit: 10, totalCount: 2, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', 'intel', 'clusters'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.hints).toContain('Use -v for cluster descriptions')
    })

    it('should not include verbosity hint in structured output at v1', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockClusterData,
          pagination: { page: 1, limit: 10, totalCount: 2, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', '-v', 'intel', 'clusters'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      // At v1, no verbosity hint should be present; meta may still exist if there are other hints
      const hints = parsed.meta?.hints ?? []
      expect(hints).not.toContain('Use -v for cluster descriptions')
    })
  })

  describe('projects command hints', () => {
    let logs: string[]
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>
    const mockFetch = vi.fn()

    const mockProjectData = [
      {
        id: 'proj-1',
        name: 'TestProject',
        description: 'A test project',
        rationale: 'Test rationale',
        momentumScore: 5.0,
        scoreDelta: 1,
        popularityScore: 10,
        xHandle: 'test',
        signals: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        reinforcedAt: '2026-01-01T00:00:00Z',
      },
    ]

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockReset()
      process.env.AIXBT_API_KEY = 'test-key-123'
      logs = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      vi.unstubAllGlobals()
    })

    it('should include v0 hint in structured output at default verbosity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockProjectData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', 'projects'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.hints).toContain('Use -v for details, -vv for signals')
    })

    it('should include v1 hint in structured output at verbosity 1', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockProjectData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', '-v', 'projects'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.hints).toContain('Use -vv for inline signals')
    })

    it('should not include v0 hint when verbosity is 1', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockProjectData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', '-v', 'projects'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta.hints).not.toContain('Use -v for details, -vv for signals')
    })

    it('should include token estimate hint at verbosity 2', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: 200,
          data: mockProjectData,
          pagination: { page: 1, limit: 10, totalCount: 1, hasMore: false },
        }),
      })

      const program = createProgram()
      program.exitOverride()
      await program.parseAsync(['node', 'aixbt', '-f', 'json', '-vv', 'projects'], { from: 'node' })

      const jsonLine = logs.find(l => l.includes('"data"'))
      expect(jsonLine).toBeDefined()
      const parsed = JSON.parse(jsonLine!)
      expect(parsed.meta).toBeDefined()
      const tokenHint = parsed.meta.hints.find((h: string) => h.includes('tokens'))
      expect(tokenHint).toBeDefined()
      expect(tokenHint).toContain('transform:')
    })
  })
})
