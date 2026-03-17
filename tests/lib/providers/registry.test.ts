import { describe, it, expect } from 'vitest'

import {
  registerProvider,
  getProvider,
  getAllProviders,
  getProviderNames,
} from '../../../src/lib/providers/registry.js'
import { CliError } from '../../../src/lib/errors.js'
import type { Provider } from '../../../src/lib/providers/types.js'

/**
 * Build a minimal Provider fixture for testing.
 * Each test uses a unique name to avoid collisions with the module-level Map
 * that persists across tests (there is no reset/clear function).
 */
function makeTestProvider(name: string): Provider {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    actions: {
      test: {
        method: 'GET' as const,
        path: '/test',
        description: 'Test action',
        hint: 'test hint',
        params: [],
        minTier: 'free' as const,
      },
    },
    baseUrl: { byTier: {}, default: 'https://test.example.com' },
    rateLimits: { perMinute: { free: 30 } },
    normalize: (body: unknown) => body,
  }
}

describe('provider registry', () => {
  // -- registerProvider --

  describe('registerProvider', () => {
    it('should register a provider that can be retrieved by name', () => {
      const provider = makeTestProvider('reg-lookup')
      registerProvider(provider)

      const result = getProvider('reg-lookup')
      expect(result.name).toBe('reg-lookup')
      expect(result.displayName).toBe('Reg-lookup')
    })

    it('should throw on duplicate provider name', () => {
      const provider = makeTestProvider('reg-dup')
      registerProvider(provider)

      expect(() => registerProvider(makeTestProvider('reg-dup'))).toThrow(
        'Provider "reg-dup" is already registered',
      )
    })
  })

  // -- getProvider --

  describe('getProvider', () => {
    it('should return the correct provider for a registered name', () => {
      const provider = makeTestProvider('get-correct')
      registerProvider(provider)

      const result = getProvider('get-correct')
      expect(result).toBe(provider)
    })

    it('should throw CliError with code UNKNOWN_PROVIDER for unknown name', () => {
      try {
        getProvider('nonexistent-provider-xyz')
        expect.fail('Expected getProvider to throw')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('UNKNOWN_PROVIDER')
      }
    })

    it('should include available provider names in the error message', () => {
      // Register a provider so it appears in the available list
      registerProvider(makeTestProvider('get-listed'))

      try {
        getProvider('missing-provider-abc')
        expect.fail('Expected getProvider to throw')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        const message = (err as CliError).message
        expect(message).toContain('Unknown provider "missing-provider-abc"')
        expect(message).toContain('get-listed')
      }
    })
  })

  // -- getAllProviders --

  describe('getAllProviders', () => {
    it('should return an array containing all registered providers', () => {
      const p1 = makeTestProvider('all-one')
      const p2 = makeTestProvider('all-two')
      registerProvider(p1)
      registerProvider(p2)

      const all = getAllProviders()
      expect(all).toContain(p1)
      expect(all).toContain(p2)
    })

    it('should return a new array (not a reference to internal state)', () => {
      const all1 = getAllProviders()
      const all2 = getAllProviders()
      expect(all1).not.toBe(all2)
      expect(all1).toEqual(all2)
    })
  })

  // -- getProviderNames --

  describe('getProviderNames', () => {
    it('should return an array of all registered provider name strings', () => {
      registerProvider(makeTestProvider('names-alpha'))
      registerProvider(makeTestProvider('names-beta'))

      const names = getProviderNames()
      expect(names).toContain('names-alpha')
      expect(names).toContain('names-beta')
    })

    it('should return a new array (not a reference to internal state)', () => {
      const names1 = getProviderNames()
      const names2 = getProviderNames()
      expect(names1).not.toBe(names2)
      expect(names1).toEqual(names2)
    })
  })
})
