import { describe, it, expect } from 'vitest'
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
    expect(commandNames).toContain('config')
    expect(commandNames).toContain('projects')
    expect(commandNames).toContain('signals')
    expect(commandNames).toContain('clusters')
    expect(commandNames).toContain('recipe')
  })
})
