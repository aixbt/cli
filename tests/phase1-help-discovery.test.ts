import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createProgram } from '../src/cli.js'
import { setConfigPath } from '../src/lib/config.js'

// -- Mock @inquirer/prompts (imported by login.ts which is registered on the program) --

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

// -- Mock ora (suppress spinners in tests) --

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

/**
 * Captures the full help output from a Commander program by intercepting writeOut.
 */
function captureHelpOutput(program: ReturnType<typeof createProgram>): string {
  const chunks: string[] = []
  program.configureOutput({
    writeOut: (str: string) => { chunks.push(str) },
    writeErr: (str: string) => { chunks.push(str) },
  })
  program.outputHelp()
  return chunks.join('')
}

describe('Phase 1: CLI Help & Discovery', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-phase1-test-'))
    setConfigPath(join(tempDir, 'config.json'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-phase1-test-nonexistent', 'config.json'))
    delete process.env.AIXBT_API_KEY
  })

  // ── Task 1.1: Banner rewrite ──

  describe('banner content', () => {
    it('should include prose directives with concrete commands', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('recipe list')
      expect(text).toContain('signals and projects with -f toon')
      expect(text).toContain('help all')
    })

    it('should include the CLI docs link', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('docs.aixbt.tech/builders/cli.mdx')
    })

    it('should include the FOR AI AGENTS title bar', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('FOR AI AGENTS')
    })
  })

  // ── Task 1.2: Auth status line ──

  describe('auth status — key loaded', () => {
    it('should display key loaded status when API key is present', () => {
      process.env.AIXBT_API_KEY = 'test-key-123'
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('key loaded (env)')
    })

    it('should not display the unauthenticated message when API key is present', () => {
      process.env.AIXBT_API_KEY = 'test-key-123'
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).not.toContain('no API key')
      expect(text).not.toContain('run aixbt login')
    })
  })

  describe('auth status — unauthenticated', () => {
    it('should display unauthenticated status when no API key is set', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('no API key')
    })

    it('should direct user to login and docs when unauthenticated', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('run aixbt login')
      expect(text).toContain('docs.aixbt.tech')
    })

    it('should not display key loaded status when no API key is set', () => {
      delete process.env.AIXBT_API_KEY
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).not.toContain('key loaded')
    })
  })

  describe('auth status always renders', () => {
    it('should always show auth state regardless of auth state', () => {
      // Unauthenticated
      delete process.env.AIXBT_API_KEY
      const program1 = createProgram()
      const text1 = stripAnsi(captureHelpOutput(program1))
      expect(text1).toContain('no API key')

      // Authenticated
      process.env.AIXBT_API_KEY = 'test-key'
      const program2 = createProgram()
      const text2 = stripAnsi(captureHelpOutput(program2))
      expect(text2).toContain('key loaded')
    })
  })

  // ── Task 1.4: Format option descriptions ──

  describe('format option descriptions', () => {
    it('should include per-format explanations in the format option description', () => {
      const program = createProgram()
      const formatOpt = program.options.find((o) => o.long === '--format')
      expect(formatOpt).toBeDefined()
      expect(formatOpt!.description).toContain('human')
      expect(formatOpt!.description).toContain('json')
      expect(formatOpt!.description).toContain('toon')
    })

    it('should list all three formats with human as default', () => {
      const program = createProgram()
      const formatOpt = program.options.find((o) => o.long === '--format')
      expect(formatOpt).toBeDefined()
      expect(formatOpt!.description).toContain('human')
      expect(formatOpt!.description).toContain('default')
    })

    it('should show format descriptions in help output', () => {
      const program = createProgram()
      const raw = captureHelpOutput(program)
      const text = stripAnsi(raw)

      expect(text).toContain('toon')
    })
  })

  // ── Task 1.3: Recipe help aftertext ──

  describe('recipe help aftertext', () => {
    it('should include recipe explanation in recipe --help', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')
      expect(recipeCmd).toBeDefined()

      const chunks: string[] = []
      recipeCmd!.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd!.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('declarative YAML pipelines')
    })

    it('should include spec and building blocks doc links', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')!
      const chunks: string[] = []
      recipeCmd.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('recipe-specification.mdx')
      expect(text).toContain('recipe-building-blocks.mdx')
    })

    it('should include quick start commands', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')!
      const chunks: string[] = []
      recipeCmd.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('recipe list')
      expect(text).toContain('recipe info')
      expect(text).toContain('recipe run')
    })

    it('should include the full-verbosity rule note', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')!
      const chunks: string[] = []
      recipeCmd.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('transform:')
      expect(text).toContain('no effect on recipe output')
    })

    it('should include agent integration section', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')!
      const chunks: string[] = []
      recipeCmd.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('Agent integration')
      expect(text).toContain('--agent')
    })

    it('should include guide doc link', () => {
      const program = createProgram()
      const recipeCmd = program.commands.find(c => c.name() === 'recipe')!
      const chunks: string[] = []
      recipeCmd.configureOutput({
        writeOut: (str: string) => { chunks.push(str) },
        writeErr: (str: string) => { chunks.push(str) },
      })
      recipeCmd.outputHelp()
      const text = stripAnsi(chunks.join(''))

      expect(text).toContain('recipes.mdx')
    })
  })

  // ── Task 1.5: Clusters under signals ──

  describe('signals clusters subcommand', () => {
    it('should register clusters as a subcommand of signals', () => {
      const program = createProgram()
      const signalsCmd = program.commands.find(c => c.name() === 'signals')
      expect(signalsCmd).toBeDefined()

      const subcommandNames = signalsCmd!.commands.map(c => c.name())
      expect(subcommandNames).toContain('clusters')
    })

    it('should have a description for the clusters subcommand', () => {
      const program = createProgram()
      const signalsCmd = program.commands.find(c => c.name() === 'signals')!
      const clustersCmd = signalsCmd.commands.find(c => c.name() === 'clusters')
      expect(clustersCmd).toBeDefined()
      expect(clustersCmd!.description()).toBeTruthy()
    })

    it('should mention -v in the clusters subcommand description', () => {
      const program = createProgram()
      const signalsCmd = program.commands.find(c => c.name() === 'signals')!
      const clustersCmd = signalsCmd.commands.find(c => c.name() === 'clusters')!
      expect(clustersCmd.description()).toContain('-v')
    })
  })

  // ── Task 1.6: Recipe -f human error ──

  describe('recipe -f human error message', () => {
    let logs: string[]
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>
    let mockExit: ReturnType<typeof vi.spyOn>

    const mockFetch = vi.fn()

    beforeEach(() => {
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockReset()
      process.env.AIXBT_API_KEY = 'test-key-123'
      logs = []
      consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as never)
    })

    afterEach(() => {
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      mockExit.mockRestore()
      vi.unstubAllGlobals()
    })

    it('should reject -f human on recipe run with an explanation of why', async () => {
      const recipeFile = join(tempDir, 'test.yaml')
      writeFileSync(recipeFile, `
name: test-recipe
version: "1.0"
description: A test recipe
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'human', 'recipe', 'run', recipeFile],
          { from: 'node' },
        ),
      ).rejects.toThrow('structured data for agent consumption')
    })

    it('should suggest toon or json as alternatives in the error', async () => {
      const recipeFile = join(tempDir, 'test.yaml')
      writeFileSync(recipeFile, `
name: test-recipe
version: "1.0"
description: A test recipe
steps:
  - id: projects
    type: api
    action: "GET /v2/projects"
`)

      const program = createProgram()
      program.exitOverride()

      await expect(
        program.parseAsync(
          ['node', 'aixbt', '--format', 'human', 'recipe', 'run', recipeFile],
          { from: 'node' },
        ),
      ).rejects.toThrow('toon')
    })
  })

  // ── Task 1.7: Validate-to-measure chain ──
  // (recipe measure was removed; these tests are no longer applicable)
})
