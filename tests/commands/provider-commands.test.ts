import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'

import type { Provider } from '../../src/lib/providers/types.js'
import { registerProviderCommands } from '../../src/commands/provider-commands.js'
import { setConfigPath } from '../../src/lib/config.js'

// -- Mock ora (suppress spinners in tests) --

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}))

// -- Mock providerRequest --

const mockProviderRequest = vi.fn()
vi.mock('../../src/lib/providers/client.js', () => ({
  providerRequest: (...args: unknown[]) => mockProviderRequest(...args),
}))

// -- Mock provider config (needed by resolveFormat -> readConfig path) --

vi.mock('../../src/lib/providers/config.js', () => ({
  resolveProviderKey: vi.fn().mockReturnValue(null),
  saveProviderKey: vi.fn(),
  removeProviderKey: vi.fn(),
}))

// -- Mock provider for testing --

const mockProvider: Provider = {
  name: 'test',
  displayName: 'Test Provider',
  actions: {
    'get-thing': {
      method: 'GET' as const,
      path: '/things/{id}',
      description: 'Get a thing',
      hint: 'When you need a thing',
      params: [
        { name: 'id', required: true, description: 'Thing ID', inPath: true },
        { name: 'format', required: false, description: 'Output format' },
      ],
      minTier: 'free' as const,
    },
    'list-things': {
      method: 'GET' as const,
      path: '/things',
      description: 'List things',
      hint: 'When you need multiple things',
      params: [],
      minTier: 'free' as const,
    },
  },
  baseUrl: { byTier: { free: 'https://test.api' }, default: 'https://test.api' },
  rateLimits: { perMinute: { free: 30 } },
  normalize: (body) => body,
}

describe('registerProviderCommands', () => {
  let tempDir: string
  let logs: string[]
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockProviderRequest.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-provider-commands-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    logs = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-provider-commands-test-nonexistent', 'config.json'))
    consoleSpy.mockRestore()
  })

  it('should create a command group with the provider name', () => {
    const program = new Command()
    registerProviderCommands(program, mockProvider)

    const group = program.commands.find(c => c.name() === 'test')
    expect(group).toBeDefined()
    expect(group!.description()).toContain('Test Provider')
  })

  it('should create one subcommand per action', () => {
    const program = new Command()
    registerProviderCommands(program, mockProvider)

    const group = program.commands.find(c => c.name() === 'test')!
    const subNames = group.commands.map(c => c.name())
    expect(subNames).toContain('get-thing')
    expect(subNames).toContain('list-things')
  })

  it('should make path params positional arguments', () => {
    const program = new Command()
    registerProviderCommands(program, mockProvider)

    const group = program.commands.find(c => c.name() === 'test')!
    const getThingCmd = group.commands.find(c => c.name() === 'get-thing')!

    // Commander stores the usage/signature; the command itself registers arguments for path params
    // The command expects positional args (registeredArguments)
    expect(getThingCmd.registeredArguments.length).toBeGreaterThanOrEqual(1)
    expect(getThingCmd.registeredArguments[0].name()).toBe('id')
  })

  it('should make optional non-path params into options', () => {
    const program = new Command()
    registerProviderCommands(program, mockProvider)

    const group = program.commands.find(c => c.name() === 'test')!
    const getThingCmd = group.commands.find(c => c.name() === 'get-thing')!
    const formatOpt = getThingCmd.options.find(o => o.long === '--format')
    expect(formatOpt).toBeDefined()
    expect(formatOpt!.description).toBe('Output format')
  })

  it('should add --provider-key option to each action subcommand', () => {
    const program = new Command()
    registerProviderCommands(program, mockProvider)

    const group = program.commands.find(c => c.name() === 'test')!
    for (const sub of group.commands) {
      const pkOpt = sub.options.find(o => o.long === '--provider-key')
      expect(pkOpt).toBeDefined()
      expect(pkOpt!.description).toContain('Test Provider')
    }
  })

  it('should call providerRequest when an action subcommand is invoked', async () => {
    mockProviderRequest.mockResolvedValueOnce({
      data: { id: '123', name: 'Thing One' },
      status: 200,
      provider: 'test',
      action: 'get-thing',
    })

    const program = new Command()
    program.option('-f, --format <mode>', 'Output format')
    program.option('-v, --verbose', 'Verbose', (_: string, prev: number) => prev + 1, 0)
    registerProviderCommands(program, mockProvider)

    await program.parseAsync(['node', 'test', '-f', 'json', 'test', 'get-thing', 'my-id'], { from: 'node' })

    expect(mockProviderRequest).toHaveBeenCalledTimes(1)
    const callOpts = mockProviderRequest.mock.calls[0][0]
    expect(callOpts.provider).toBe(mockProvider)
    expect(callOpts.actionName).toBe('get-thing')
    expect(callOpts.params.id).toBe('my-id')
  })

  it('should pass optional params from options to providerRequest', async () => {
    mockProviderRequest.mockResolvedValueOnce({
      data: { id: '123' },
      status: 200,
      provider: 'test',
      action: 'get-thing',
    })

    const program = new Command()
    program.option('-f, --format <mode>', 'Output format')
    program.option('-v, --verbose', 'Verbose', (_: string, prev: number) => prev + 1, 0)
    program.enablePositionalOptions()
    registerProviderCommands(program, mockProvider)

    await program.parseAsync(
      ['node', 'test', '-f', 'json', 'test', 'get-thing', 'my-id', '--format', 'csv'],
      { from: 'node' },
    )

    expect(mockProviderRequest).toHaveBeenCalledTimes(1)
    const callOpts = mockProviderRequest.mock.calls[0][0]
    expect(callOpts.params.format).toBe('csv')
  })

  it('should pass --provider-key override to providerRequest', async () => {
    mockProviderRequest.mockResolvedValueOnce({
      data: [],
      status: 200,
      provider: 'test',
      action: 'list-things',
    })

    const program = new Command()
    program.option('-f, --format <mode>', 'Output format')
    program.option('-v, --verbose', 'Verbose', (_: string, prev: number) => prev + 1, 0)
    registerProviderCommands(program, mockProvider)

    await program.parseAsync(
      ['node', 'test', '-f', 'json', 'test', 'list-things', '--provider-key', 'override-key'],
      { from: 'node' },
    )

    expect(mockProviderRequest).toHaveBeenCalledTimes(1)
    const callOpts = mockProviderRequest.mock.calls[0][0]
    expect(callOpts.apiKeyOverride).toBe('override-key')
  })

  it('should output JSON when format is json', async () => {
    const responseData = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }]
    mockProviderRequest.mockResolvedValueOnce({
      data: responseData,
      status: 200,
      provider: 'test',
      action: 'list-things',
    })

    const program = new Command()
    program.option('-f, --format <mode>', 'Output format')
    program.option('-v, --verbose', 'Verbose', (_: string, prev: number) => prev + 1, 0)
    registerProviderCommands(program, mockProvider)

    await program.parseAsync(
      ['node', 'test', '-f', 'json', 'test', 'list-things'],
      { from: 'node' },
    )

    const jsonOutput = logs.find(l => l.includes('Alpha'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.data).toEqual(responseData)
  })

  describe('with a provider that has required non-path params', () => {
    const providerWithRequiredOpt: Provider = {
      ...mockProvider,
      name: 'testopt',
      actions: {
        'search': {
          method: 'GET' as const,
          path: '/search',
          description: 'Search for things',
          hint: 'When you need to search',
          params: [
            { name: 'query', required: true, description: 'Search query' },
          ],
          minTier: 'free' as const,
        },
      },
    }

    it('should make required non-path params into required options', () => {
      const program = new Command()
      registerProviderCommands(program, providerWithRequiredOpt)

      const group = program.commands.find(c => c.name() === 'testopt')!
      const searchCmd = group.commands.find(c => c.name() === 'search')!
      const queryOpt = searchCmd.options.find(o => o.long === '--query')
      expect(queryOpt).toBeDefined()
      expect(queryOpt!.required).toBe(true)
    })
  })
})
