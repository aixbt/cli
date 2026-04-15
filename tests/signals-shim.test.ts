import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createProgram } from '../src/cli.js'

/**
 * Deprecation shim for `aixbt signals` (and its subcommands).
 *
 * After the intel rewrite, `signals`, `signals clusters`, and `signals categories`
 * are hidden shims that MUST:
 *   - write a deprecation message to stderr that points at `aixbt intel`
 *     and includes the sunset date 2026-07-15
 *   - exit with code 2 (non-zero, reserved for deprecation)
 */

// Mocks: these modules are transitively imported by the CLI but irrelevant to the shim.
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

/**
 * Runs the CLI in-process with the given argv and captures stderr + exit code.
 *
 * The shim calls `process.exit(2)` which would kill the test runner, so we
 * stub it to throw a sentinel; the test then asserts on the captured state.
 */
function runCli(argv: string[]): { stderr: string; exitCode: number | undefined } {
  const program = createProgram()
  let stderr = ''
  let exitCode: number | undefined

  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })

  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error('__shim_exit__')
    }) as never)

  try {
    program.parse(['node', 'aixbt', ...argv], { from: 'node' })
  } catch (err) {
    // The shim throws via our exit stub — any other error is a real failure.
    if (!(err instanceof Error) || err.message !== '__shim_exit__') {
      throw err
    }
  } finally {
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return { stderr, exitCode }
}

describe('signals deprecation shim', () => {
  beforeEach(() => {
    // Prevent stray env from leaking into command resolution.
    delete process.env.AIXBT_API_KEY
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['signals'],
    ['signals', 'clusters'],
    ['signals', 'categories'],
  ])('aixbt %s prints a deprecation message to stderr and exits with code 2', (...args) => {
    const { stderr, exitCode } = runCli(args)

    expect(stderr).toContain('aixbt intel')
    expect(stderr).toContain('2026-07-15')
    expect(stderr.toLowerCase()).toContain('deprecated')
    expect(exitCode).toBe(2)
  })
})
