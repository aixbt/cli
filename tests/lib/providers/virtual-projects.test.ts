import { describe, it, expect } from 'vitest'

import { projectsProvider } from '../../../src/lib/providers/virtual.js'

// Minimal ResolveContext — resolve() only uses params; ctx is unused for this action
const ctx = {
  tier: 'free',
  hint: undefined,
  request: async () => { throw new Error('request not expected in unit tests') },
} as never

describe('projectsProvider', () => {
  it('should have name "projects"', () => {
    expect(projectsProvider.name).toBe('projects')
  })

  it('should expose a single "metrics" action', () => {
    const actionNames = Object.keys(projectsProvider.actions)
    expect(actionNames).toEqual(['metrics'])
  })

  it('should be a virtual provider with no baseUrl', () => {
    expect(projectsProvider.baseUrl).toBeUndefined()
  })

  describe('metrics action — resolve()', () => {
    const resolve = projectsProvider.actions.metrics.resolve!

    // -- happy path --

    it('routes projectId-only to aixbt:metrics', () => {
      const result = resolve({ projectId: 'abc123' }, ctx)
      expect(result).toEqual({
        provider: 'aixbt',
        action: 'metrics',
        params: { id: 'abc123' },
      })
    })

    it('passes through optional at param when provided', () => {
      const result = resolve({ projectId: 'abc123', at: '2024-01-15T00:00:00Z' }, ctx)
      expect(result).toEqual({
        provider: 'aixbt',
        action: 'metrics',
        params: { id: 'abc123', at: '2024-01-15T00:00:00Z' },
      })
    })

    it('does not include at in params when not provided', () => {
      const result = resolve({ projectId: 'abc123' }, ctx) as { params: Record<string, unknown> }
      expect(result).not.toHaveProperty('params.at')
      expect('at' in result.params).toBe(false)
    })

    // -- rejection paths --

    it('rejects geckoId with a clear error', () => {
      const result = resolve({ geckoId: 'bitcoin' }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/geckoId/)
    })

    it('rejects address with a clear error', () => {
      const result = resolve({ address: '0xdeadbeef' }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/address/)
    })

    it('rejects network with a clear error', () => {
      const result = resolve({ network: 'ethereum' }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/network/)
    })

    it('rejects empty params (no projectId) with a clear error', () => {
      const result = resolve({}, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/projectId/)
    })

    it('rejects undefined projectId with a clear error', () => {
      const result = resolve({ projectId: undefined }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/projectId/)
    })

    it('rejects empty-string projectId with a clear error', () => {
      const result = resolve({ projectId: '' }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/projectId/)
    })

    // geckoId check fires before projectId check
    it('rejects geckoId even when projectId is also present', () => {
      const result = resolve({ projectId: 'abc123', geckoId: 'bitcoin' }, ctx)
      expect(result).toHaveProperty('error')
      const { error } = result as { error: string }
      expect(error).toMatch(/geckoId/)
    })
  })
})
