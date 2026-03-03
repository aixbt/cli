import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createProgram } from '../src/cli.js'

describe('CLI', () => {
  it('creates a program with the correct name', () => {
    const program = createProgram()
    expect(program.name()).toBe('aixbt')
  })

  it('has all expected commands', () => {
    const program = createProgram()
    const commandNames = program.commands.map((cmd) => cmd.name())
    expect(commandNames).toContain('login')
    expect(commandNames).toContain('logout')
    expect(commandNames).toContain('whoami')
    expect(commandNames).toContain('config')
    expect(commandNames).toContain('projects')
    expect(commandNames).toContain('signals')
    expect(commandNames).toContain('clusters')
    expect(commandNames).toContain('recipe')
  })

  describe('description', () => {
    it('should have the expected program description', () => {
      const program = createProgram()
      expect(program.description()).toBe('AIXBT intelligence CLI')
    })
  })

  describe('global options', () => {
    it('should have --json option registered', () => {
      const program = createProgram()
      const jsonOpt = program.options.find((o) => o.long === '--json')
      expect(jsonOpt).toBeDefined()
      expect(jsonOpt!.description).toBe('Output as JSON (machine-readable)')
    })

    it('should have --delayed option registered', () => {
      const program = createProgram()
      const delayedOpt = program.options.find((o) => o.long === '--delayed')
      expect(delayedOpt).toBeDefined()
      expect(delayedOpt!.description).toBe(
        'Use free tier with delayed data (no auth required)',
      )
    })

    it('should have --pay-per-use option registered', () => {
      const program = createProgram()
      const ppuOpt = program.options.find((o) => o.long === '--pay-per-use')
      expect(ppuOpt).toBeDefined()
      expect(ppuOpt!.description).toBe('Pay per API call via x402')
    })

    it('should have --api-key option registered with required argument', () => {
      const program = createProgram()
      const apiKeyOpt = program.options.find((o) => o.long === '--api-key')
      expect(apiKeyOpt).toBeDefined()
      expect(apiKeyOpt!.description).toBe(
        'API key (overrides config and env)',
      )
      // Commander marks option arguments as required vs optional
      expect(apiKeyOpt!.required).toBe(true)
    })

    it('should parse --json flag correctly', () => {
      const program = createProgram()
      program.exitOverride()
      // Use 'login' subcommand to avoid Commander displaying help for no-action root
      program.parse(['node', 'test', '--json', 'login'], { from: 'node' })
      expect(program.opts().json).toBe(true)
    })

    it('should parse --delayed flag correctly', () => {
      const program = createProgram()
      program.exitOverride()
      program.parse(['node', 'test', '--delayed', 'login'], { from: 'node' })
      expect(program.opts().delayed).toBe(true)
    })

    it('should parse --pay-per-use flag correctly', () => {
      const program = createProgram()
      program.exitOverride()
      program.parse(['node', 'test', '--pay-per-use', 'login'], {
        from: 'node',
      })
      expect(program.opts().payPerUse).toBe(true)
    })

    it('should parse --api-key with a value correctly', () => {
      const program = createProgram()
      program.exitOverride()
      program.parse(
        ['node', 'test', '--api-key', 'my-secret-key', 'login'],
        { from: 'node' },
      )
      expect(program.opts().apiKey).toBe('my-secret-key')
    })

    it('should default all global options to undefined when not passed', () => {
      const program = createProgram()
      program.exitOverride()
      program.parse(['node', 'test', 'login'], { from: 'node' })
      const opts = program.opts()
      expect(opts.json).toBeUndefined()
      expect(opts.delayed).toBeUndefined()
      expect(opts.payPerUse).toBeUndefined()
      expect(opts.apiKey).toBeUndefined()
    })

    it('should have --json as a boolean flag (no argument)', () => {
      const program = createProgram()
      const jsonOpt = program.options.find((o) => o.long === '--json')
      expect(jsonOpt).toBeDefined()
      // Boolean flags have no required or optional argument
      expect(jsonOpt!.required).toBe(false)
      expect(jsonOpt!.optional).toBe(false)
    })

    it('should have --delayed as a boolean flag (no argument)', () => {
      const program = createProgram()
      const delayedOpt = program.options.find((o) => o.long === '--delayed')
      expect(delayedOpt).toBeDefined()
      expect(delayedOpt!.required).toBe(false)
      expect(delayedOpt!.optional).toBe(false)
    })

    it('should have --pay-per-use as a boolean flag (no argument)', () => {
      const program = createProgram()
      const ppuOpt = program.options.find((o) => o.long === '--pay-per-use')
      expect(ppuOpt).toBeDefined()
      expect(ppuOpt!.required).toBe(false)
      expect(ppuOpt!.optional).toBe(false)
    })
  })

  describe('version', () => {
    it('should have version configured', () => {
      const program = createProgram()
      expect(program.version()).toBeDefined()
      expect(typeof program.version()).toBe('string')
    })

    it('should have a valid semver-like version string', () => {
      const program = createProgram()
      const version = program.version()!
      // Should match a version pattern like "0.1.0" or "1.0.0-beta.1"
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('should configure -v as the short flag for version', () => {
      const program = createProgram()
      const versionOpt = program.options.find(
        (o) => o.short === '-v' && o.long === '--version',
      )
      expect(versionOpt).toBeDefined()
    })

    it('should exit with version output when -v is used', () => {
      const program = createProgram()
      program.exitOverride()

      // Commander throws a CommanderError with code 'commander.version' on --version
      expect(() => {
        program.parse(['node', 'test', '-v'], { from: 'node' })
      }).toThrow()
    })
  })

  describe('configureOutput', () => {
    let mockStdoutWrite: ReturnType<typeof vi.spyOn>
    let mockStderrWrite: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true)
      mockStderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should route help output through process.stdout.write', () => {
      const program = createProgram()
      program.outputHelp()

      expect(mockStdoutWrite).toHaveBeenCalled()
      const fullOutput = mockStdoutWrite.mock.calls
        .map((call) => String(call[0]))
        .join('')
      // eslint-disable-next-line no-control-regex
      const stripped = fullOutput.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripped).toContain('aixbt')
      expect(stripped).toContain('AIXBT intelligence CLI')
    })

    it('should have writeOut configured to use process.stdout.write', () => {
      const program = createProgram()
      const outputConfig = program.configureOutput()
      expect(outputConfig.writeOut).toBeDefined()
      expect(typeof outputConfig.writeOut).toBe('function')

      // Call writeOut directly and verify it writes to stdout
      outputConfig.writeOut!('test output')
      expect(mockStdoutWrite).toHaveBeenCalled()
    })

    it('should have writeErr configured to use process.stderr.write', () => {
      const program = createProgram()
      const outputConfig = program.configureOutput()
      expect(outputConfig.writeErr).toBeDefined()
      expect(typeof outputConfig.writeErr).toBe('function')

      // Call writeErr directly and verify it writes to stderr
      outputConfig.writeErr!('test error message')
      expect(mockStderrWrite).toHaveBeenCalled()
    })

    it('should pass output text through colorizeHelp before writing to stdout', () => {
      const program = createProgram()

      // Call writeOut with a string containing "Usage:" which colorizeHelp transforms
      const outputConfig = program.configureOutput()
      outputConfig.writeOut!('Usage: test\n')

      expect(mockStdoutWrite).toHaveBeenCalled()
      // The written output should be the result of colorizeHelp('Usage: test\n')
      // Verify the content is preserved (colorizeHelp doesn't strip text)
      const written = String(mockStdoutWrite.mock.calls[0][0])
      // eslint-disable-next-line no-control-regex
      const stripped = written.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripped).toContain('Usage: test')
    })

    it('should pass error text through colorizeHelp before writing to stderr', () => {
      const program = createProgram()

      const outputConfig = program.configureOutput()
      outputConfig.writeErr!('Options:\n  --help  show help\n')

      expect(mockStderrWrite).toHaveBeenCalled()
      const written = String(mockStderrWrite.mock.calls[0][0])
      // eslint-disable-next-line no-control-regex
      const stripped = written.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripped).toContain('Options:')
      expect(stripped).toContain('--help')
    })

    it('should include all global options in help output', () => {
      const program = createProgram()
      program.outputHelp()

      const fullOutput = mockStdoutWrite.mock.calls
        .map((call) => String(call[0]))
        .join('')
      // eslint-disable-next-line no-control-regex
      const stripped = fullOutput.replace(/\x1b\[[0-9;]*m/g, '')

      expect(stripped).toContain('--json')
      expect(stripped).toContain('--delayed')
      expect(stripped).toContain('--pay-per-use')
      expect(stripped).toContain('--api-key')
      expect(stripped).toContain('-v, --version')
    })

    it('should include all subcommands in help output', () => {
      const program = createProgram()
      program.outputHelp()

      const fullOutput = mockStdoutWrite.mock.calls
        .map((call) => String(call[0]))
        .join('')
      // eslint-disable-next-line no-control-regex
      const stripped = fullOutput.replace(/\x1b\[[0-9;]*m/g, '')

      expect(stripped).toContain('login')
      expect(stripped).toContain('config')
      expect(stripped).toContain('projects')
      expect(stripped).toContain('signals')
      expect(stripped).toContain('clusters')
      expect(stripped).toContain('recipe')
    })
  })

  describe('command count', () => {
    it('should have exactly 8 registered commands', () => {
      const program = createProgram()
      expect(program.commands).toHaveLength(8)
    })
  })

  describe('createProgram returns independent instances', () => {
    it('should return a new program instance on each call', () => {
      const program1 = createProgram()
      const program2 = createProgram()
      expect(program1).not.toBe(program2)
    })

    it('should not share state between instances', () => {
      const program1 = createProgram()
      program1.exitOverride()
      const program2 = createProgram()
      program2.exitOverride()

      program1.parse(['node', 'test', '--json', 'login'], { from: 'node' })

      // program2 should not be affected by program1's parsing
      program2.parse(['node', 'test', 'login'], { from: 'node' })
      expect(program2.opts().json).toBeUndefined()
    })
  })
})
