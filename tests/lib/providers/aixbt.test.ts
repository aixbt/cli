import { describe, it, expect } from 'vitest'

import {
  AIXBT_ACTION_PATHS,
  aixbtProvider,
} from '../../../src/lib/providers/aixbt.js'

describe('AIXBT_ACTION_PATHS', () => {
  const expectedActions = [
    'projects',
    'project',
    'momentum',
    'chains',
    'signals',
    'clusters',
  ]

  it('should have entries for all 6 action names', () => {
    const keys = Object.keys(AIXBT_ACTION_PATHS)
    expect(keys).toHaveLength(6)
    for (const name of expectedActions) {
      expect(AIXBT_ACTION_PATHS).toHaveProperty(name)
    }
  })

  it('should have all paths starting with /v2/', () => {
    for (const [name, path] of Object.entries(AIXBT_ACTION_PATHS)) {
      expect(path, `path for "${name}" should start with /v2/`).toMatch(
        /^\/v2\//,
      )
    }
  })

  it('should include {id} parameter in project path', () => {
    expect(AIXBT_ACTION_PATHS.project).toContain('{id}')
  })

  it('should include {id} parameter in momentum path', () => {
    expect(AIXBT_ACTION_PATHS.momentum).toContain('{id}')
  })

  it('should not include {id} in paths that do not need it', () => {
    expect(AIXBT_ACTION_PATHS.projects).not.toContain('{id}')
    expect(AIXBT_ACTION_PATHS.chains).not.toContain('{id}')
    expect(AIXBT_ACTION_PATHS.signals).not.toContain('{id}')
    expect(AIXBT_ACTION_PATHS.clusters).not.toContain('{id}')
  })
})

describe('aixbtProvider', () => {
  // -- Provider identity --

  describe('provider metadata', () => {
    it('should have name "aixbt"', () => {
      expect(aixbtProvider.name).toBe('aixbt')
    })

    it('should have displayName "AIXBT"', () => {
      expect(aixbtProvider.displayName).toBe('AIXBT')
    })

    it('should have authHeader "X-API-Key"', () => {
      expect(aixbtProvider.authHeader).toBe('X-API-Key')
    })

    it('should have default baseUrl pointing to api.aixbt.tech', () => {
      expect(aixbtProvider.baseUrl.default).toBe('https://api.aixbt.tech')
    })

    it('should have a single free keyless tier with no rate limit', () => {
      expect(aixbtProvider.tiers).toEqual({
        free: { rank: 0, keyless: true },
      })
    })
  })

  // -- Actions --

  describe('actions', () => {
    it('should define all 6 actions', () => {
      const actionNames = Object.keys(aixbtProvider.actions)
      expect(actionNames).toHaveLength(6)
      expect(actionNames).toContain('projects')
      expect(actionNames).toContain('project')
      expect(actionNames).toContain('momentum')
      expect(actionNames).toContain('chains')
      expect(actionNames).toContain('signals')
      expect(actionNames).toContain('clusters')
    })

    it('should use method GET for all actions', () => {
      for (const [name, action] of Object.entries(aixbtProvider.actions)) {
        expect(action.method, `action "${name}" should use GET`).toBe('GET')
      }
    })

    it('should use minTier "free" for all actions', () => {
      for (const [name, action] of Object.entries(aixbtProvider.actions)) {
        expect(
          action.minTier,
          `action "${name}" should have minTier "free"`,
        ).toBe('free')
      }
    })

    // -- projects action --

    describe('projects action', () => {
      it('should have params including page, limit, chain, and minMomentum', () => {
        const paramNames = aixbtProvider.actions.projects.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('page')
        expect(paramNames).toContain('limit')
        expect(paramNames).toContain('chain')
        expect(paramNames).toContain('minMomentum')
      })

      it('should have no required params', () => {
        const requiredParams = aixbtProvider.actions.projects.params.filter(
          (p) => p.required,
        )
        expect(requiredParams).toHaveLength(0)
      })
    })

    // -- project action --

    describe('project action', () => {
      it('should have id param that is required with inPath true', () => {
        const idParam = aixbtProvider.actions.project.params.find(
          (p) => p.name === 'id',
        )
        expect(idParam).toBeDefined()
        expect(idParam!.required).toBe(true)
        expect(idParam!.inPath).toBe(true)
      })
    })

    // -- momentum action --

    describe('momentum action', () => {
      it('should have id param that is required with inPath true', () => {
        const idParam = aixbtProvider.actions.momentum.params.find(
          (p) => p.name === 'id',
        )
        expect(idParam).toBeDefined()
        expect(idParam!.required).toBe(true)
        expect(idParam!.inPath).toBe(true)
      })

      it('should have start and end params', () => {
        const paramNames = aixbtProvider.actions.momentum.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('start')
        expect(paramNames).toContain('end')
      })
    })

    // -- chains action --

    describe('chains action', () => {
      it('should have empty params array', () => {
        expect(aixbtProvider.actions.chains.params).toEqual([])
      })
    })

    // -- signals action --

    describe('signals action', () => {
      it('should have params including projectIds, categories, and detectedAfter', () => {
        const paramNames = aixbtProvider.actions.signals.params.map(
          (p) => p.name,
        )
        expect(paramNames).toContain('projectIds')
        expect(paramNames).toContain('categories')
        expect(paramNames).toContain('detectedAfter')
      })

      it('should have no required params', () => {
        const requiredParams = aixbtProvider.actions.signals.params.filter(
          (p) => p.required,
        )
        expect(requiredParams).toHaveLength(0)
      })
    })

    // -- clusters action --

    describe('clusters action', () => {
      it('should have empty params array', () => {
        expect(aixbtProvider.actions.clusters.params).toEqual([])
      })
    })
  })

  // -- normalize function --

  describe('normalize', () => {
    it('should extract .data from an envelope response', () => {
      const body = { status: 200, data: [1, 2, 3] }
      const result = aixbtProvider.normalize(body, 'projects')
      expect(result).toEqual([1, 2, 3])
    })

    it('should extract .data even when data is a single object', () => {
      const body = { status: 200, data: { id: 'abc', name: 'test' } }
      const result = aixbtProvider.normalize(body, 'project')
      expect(result).toEqual({ id: 'abc', name: 'test' })
    })

    it('should return body as-is when no .data field is present', () => {
      const body = { status: 200, message: 'ok' }
      const result = aixbtProvider.normalize(body, 'projects')
      expect(result).toEqual({ status: 200, message: 'ok' })
    })

    it('should return null when body is null', () => {
      const result = aixbtProvider.normalize(null, 'projects')
      expect(result).toBeNull()
    })

    it('should return undefined when body is undefined', () => {
      const result = aixbtProvider.normalize(undefined, 'projects')
      expect(result).toBeUndefined()
    })

    it('should return body as-is when body is a primitive', () => {
      expect(aixbtProvider.normalize('raw string', 'projects')).toBe(
        'raw string',
      )
      expect(aixbtProvider.normalize(42, 'projects')).toBe(42)
    })

    it('should return body as-is when body is an array (no envelope)', () => {
      const body = [{ id: 1 }, { id: 2 }]
      const result = aixbtProvider.normalize(body, 'projects')
      expect(result).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('should handle .data being null inside envelope', () => {
      const body = { status: 200, data: null }
      const result = aixbtProvider.normalize(body, 'projects')
      expect(result).toBeNull()
    })

    it('should handle .data being an empty array', () => {
      const body = { status: 200, data: [] }
      const result = aixbtProvider.normalize(body, 'projects')
      expect(result).toEqual([])
    })
  })

  // -- AIXBT_ACTION_PATHS / provider.actions consistency --

  describe('AIXBT_ACTION_PATHS and actions consistency', () => {
    it('should have the same keys in AIXBT_ACTION_PATHS and provider actions', () => {
      const pathKeys = Object.keys(AIXBT_ACTION_PATHS).sort()
      const actionKeys = Object.keys(aixbtProvider.actions).sort()
      expect(pathKeys).toEqual(actionKeys)
    })

    it('should have matching paths between AIXBT_ACTION_PATHS and action definitions', () => {
      for (const [name, path] of Object.entries(AIXBT_ACTION_PATHS)) {
        expect(
          aixbtProvider.actions[name].path,
          `action "${name}" path should match AIXBT_ACTION_PATHS`,
        ).toBe(path)
      }
    })
  })
})
