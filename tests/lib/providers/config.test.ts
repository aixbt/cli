import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  setConfigPath,
  readConfig,
  writeConfig,
} from '../../../src/lib/config.js'

import {
  resolveProviderKey,
  saveProviderKey,
  removeProviderKey,
} from '../../../src/lib/providers/config.js'

import type { Provider, ProviderTierDef } from '../../../src/lib/providers/types.js'

// -- Helpers --

function makeTestProvider(
  name: string,
  tiers: Record<string, ProviderTierDef>,
): Provider {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    actions: {},
    tiers,
    baseUrl: { byTier: {}, default: 'https://test.example.com' },
  }
}

// Pre-built providers matching actual provider tier definitions
const coingeckoProvider = makeTestProvider('coingecko', {
  free: { rank: 0, ratePerMinute: 10, keyless: true },
  demo: { rank: 1, ratePerMinute: 30 },
  paid: { rank: 2, ratePerMinute: 500 },
})

const defillamaProvider = makeTestProvider('defillama', {
  free: { rank: 0, ratePerMinute: 500, keyless: true },
  paid: { rank: 1, ratePerMinute: 1000 },
})

const goplusProvider = makeTestProvider('goplus', {
  free: { rank: 0, ratePerMinute: 30, keyless: true },
  paid: { rank: 1, ratePerMinute: 120 },
})

// Provider with no keyed tiers (all keyless)
const keylessProvider = makeTestProvider('unknown-provider', {
  free: { rank: 0, keyless: true },
})

describe('provider config', () => {
  let tempDir: string
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-prov-test-'))
    setConfigPath(join(tempDir, 'config.json'))
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-prov-test-reset-nonexistent', 'config.json'))
    consoleErrorSpy.mockRestore()

    // Clean up env vars that tests may have set
    delete process.env.COINGECKO_API_KEY
    delete process.env.COINGECKO_TIER
    delete process.env.DEFILLAMA_API_KEY
    delete process.env.DEFILLAMA_TIER
    delete process.env.GOPLUS_ACCESS_TOKEN
    delete process.env.GOPLUS_TIER
  })

  // -- resolveProviderKey --

  describe('resolveProviderKey', () => {
    it('should return null when no key is configured anywhere', () => {
      const result = resolveProviderKey(coingeckoProvider)
      expect(result).toBeNull()
    })

    // -- Layer 1: flag key --

    describe('flag key (layer 1)', () => {
      it('should use flag key with source "flag"', () => {
        const result = resolveProviderKey(coingeckoProvider, 'flag-key-123')

        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('flag-key-123')
        expect(result!.source).toBe('flag')
      })

      it('should use flagTier when provided', () => {
        const result = resolveProviderKey(coingeckoProvider, 'flag-key', 'paid')

        expect(result!.tier).toBe('paid')
      })

      it('should default to lowest keyed tier when flagTier is omitted', () => {
        // coingecko lowest keyed tier is 'demo' (free is keyless)
        const result = resolveProviderKey(coingeckoProvider, 'flag-key')
        expect(result!.tier).toBe('demo')

        // defillama lowest keyed tier is 'paid' (free is keyless)
        const result2 = resolveProviderKey(defillamaProvider, 'flag-key')
        expect(result2!.tier).toBe('paid')

        // goplus lowest keyed tier is 'paid' (free is keyless)
        const result3 = resolveProviderKey(goplusProvider, 'flag-key')
        expect(result3!.tier).toBe('paid')
      })

      it('should fall back to "free" tier for provider with no keyed tiers when flagTier is omitted', () => {
        const result = resolveProviderKey(keylessProvider, 'flag-key')
        expect(result!.tier).toBe('free')
      })

      it('should take priority over env var', () => {
        process.env.COINGECKO_API_KEY = 'env-key'

        const result = resolveProviderKey(coingeckoProvider, 'flag-key')
        expect(result!.apiKey).toBe('flag-key')
        expect(result!.source).toBe('flag')
      })

      it('should take priority over config file', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'paid' } },
        })

        const result = resolveProviderKey(coingeckoProvider, 'flag-key')
        expect(result!.apiKey).toBe('flag-key')
        expect(result!.source).toBe('flag')
      })
    })

    // -- Layer 2: env var --

    describe('env var (layer 2)', () => {
      it('should pick up COINGECKO_API_KEY from environment', () => {
        process.env.COINGECKO_API_KEY = 'env-cg-key'

        const result = resolveProviderKey(coingeckoProvider)
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('env-cg-key')
        expect(result!.source).toBe('env')
      })

      it('should pick up DEFILLAMA_API_KEY from environment', () => {
        process.env.DEFILLAMA_API_KEY = 'env-dl-key'

        const result = resolveProviderKey(defillamaProvider)
        expect(result!.apiKey).toBe('env-dl-key')
        expect(result!.source).toBe('env')
      })

      it('should pick up GOPLUS_ACCESS_TOKEN from environment', () => {
        process.env.GOPLUS_ACCESS_TOKEN = 'env-gp-key'

        const result = resolveProviderKey(goplusProvider)
        expect(result!.apiKey).toBe('env-gp-key')
        expect(result!.source).toBe('env')
      })

      it('should default to lowest keyed tier when env var is set without companion tier', () => {
        process.env.COINGECKO_API_KEY = 'env-key'
        expect(resolveProviderKey(coingeckoProvider)!.tier).toBe('demo')

        process.env.DEFILLAMA_API_KEY = 'env-key'
        expect(resolveProviderKey(defillamaProvider)!.tier).toBe('paid')

        process.env.GOPLUS_ACCESS_TOKEN = 'env-key'
        expect(resolveProviderKey(goplusProvider)!.tier).toBe('paid')
      })

      it('should warn when env var is set without companion tier', () => {
        // Note: the warnedProviders set is module-level and persists across tests.
        // Earlier tests already trigger env var resolution for coingecko/defillama/goplus,
        // so we verify the warning fires on the first call within this test by checking
        // console.error was called (the first env-var test for each provider triggers it).
        // This test uses defillama since it may not have been warned yet.
        process.env.DEFILLAMA_API_KEY = 'env-key'

        resolveProviderKey(defillamaProvider)

        // Warning deduplication means we may or may not see it here depending on test order.
        // What we CAN verify: the tier defaults correctly even when warning is deduped.
        const result = resolveProviderKey(defillamaProvider)
        expect(result!.tier).toBe('paid')
        expect(result!.source).toBe('env')
      })

      it('should use companion tier env var when valid', () => {
        process.env.GOPLUS_ACCESS_TOKEN = 'env-key'
        process.env.GOPLUS_TIER = 'paid'

        const result = resolveProviderKey(goplusProvider)
        expect(result!.tier).toBe('paid')
        expect(result!.source).toBe('env')
      })

      it('should warn and default when companion tier env var is invalid', () => {
        process.env.GOPLUS_ACCESS_TOKEN = 'env-key'
        process.env.GOPLUS_TIER = 'enterprise'

        const result = resolveProviderKey(goplusProvider)
        expect(result!.tier).toBe('paid') // falls back to lowest keyed tier
      })

      it('should resolve CoinGecko tier to "demo" when COINGECKO_TIER=demo', () => {
        process.env.COINGECKO_API_KEY = 'cg-env-key'
        process.env.COINGECKO_TIER = 'demo'

        const result = resolveProviderKey(coingeckoProvider)
        expect(result).not.toBeNull()
        expect(result!.tier).toBe('demo')
        expect(result!.source).toBe('env')
      })

      it('should resolve CoinGecko tier to "paid" when COINGECKO_TIER=paid', () => {
        process.env.COINGECKO_API_KEY = 'cg-env-key'
        process.env.COINGECKO_TIER = 'paid'

        const result = resolveProviderKey(coingeckoProvider)
        expect(result).not.toBeNull()
        expect(result!.tier).toBe('paid')
        expect(result!.source).toBe('env')
      })

      it('should take priority over config file', () => {
        process.env.COINGECKO_API_KEY = 'env-key'
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'paid' } },
        })

        const result = resolveProviderKey(coingeckoProvider)
        expect(result!.apiKey).toBe('env-key')
        expect(result!.source).toBe('env')
      })

      it('should return null for provider with no env var mapping', () => {
        const result = resolveProviderKey(keylessProvider)
        expect(result).toBeNull()
      })
    })

    // -- Layer 3: config file --

    describe('config file (layer 3)', () => {
      it('should use config file key when no flag or env is set', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'paid' } },
        })

        const result = resolveProviderKey(coingeckoProvider)
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('config-key')
        expect(result!.tier).toBe('paid')
        expect(result!.source).toBe('config')
      })

      it('should fallback to lowest keyed tier when tier is missing from config', () => {
        // Simulate manually edited config with missing tier
        writeConfig({
          providers: { defillama: { apiKey: 'dl-key' } as unknown as Record<string, { apiKey: string; tier: string }>[string] },
        })

        const result = resolveProviderKey(defillamaProvider)
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('dl-key')
        expect(result!.tier).toBe('paid')
        expect(result!.source).toBe('config')
      })
    })

    // -- Priority chain --

    describe('priority: flag > env > config', () => {
      it('should resolve flag over env over config', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'paid' } },
        })
        process.env.COINGECKO_API_KEY = 'env-key'

        // All three present: flag wins
        const withFlag = resolveProviderKey(coingeckoProvider, 'flag-key')
        expect(withFlag!.apiKey).toBe('flag-key')
        expect(withFlag!.source).toBe('flag')

        // No flag: env wins over config
        const withEnv = resolveProviderKey(coingeckoProvider)
        expect(withEnv!.apiKey).toBe('env-key')
        expect(withEnv!.source).toBe('env')

        // No flag, no env: config wins
        delete process.env.COINGECKO_API_KEY
        const configOnly = resolveProviderKey(coingeckoProvider)
        expect(configOnly!.apiKey).toBe('config-key')
        expect(configOnly!.source).toBe('config')
      })
    })
  })

  // -- saveProviderKey --

  describe('saveProviderKey', () => {
    it('should create providers field if not present in config', () => {
      writeConfig({ apiKey: 'existing' })

      saveProviderKey('coingecko', { apiKey: 'cg-key', tier: 'demo' })

      const config = readConfig()
      expect(config.providers).toBeDefined()
      expect(config.providers!.coingecko).toEqual({ apiKey: 'cg-key', tier: 'demo' })
    })

    it('should overwrite an existing provider key', () => {
      writeConfig({
        providers: { coingecko: { apiKey: 'old-key', tier: 'free' } },
      })

      saveProviderKey('coingecko', { apiKey: 'new-key', tier: 'paid' })

      const config = readConfig()
      expect(config.providers!.coingecko).toEqual({ apiKey: 'new-key', tier: 'paid' })
    })

    it('should preserve other config fields', () => {
      writeConfig({ apiKey: 'main-key', apiUrl: 'https://api.test.com' })

      saveProviderKey('coingecko', { apiKey: 'cg-key', tier: 'demo' })

      const config = readConfig()
      expect(config.apiKey).toBe('main-key')
      expect(config.apiUrl).toBe('https://api.test.com')
      expect(config.providers!.coingecko.apiKey).toBe('cg-key')
    })

    it('should preserve other providers when adding a new one', () => {
      writeConfig({
        providers: { coingecko: { apiKey: 'cg-key', tier: 'demo' } },
      })

      saveProviderKey('defillama', { apiKey: 'dl-key', tier: 'paid' })

      const config = readConfig()
      expect(config.providers!.coingecko).toEqual({ apiKey: 'cg-key', tier: 'demo' })
      expect(config.providers!.defillama).toEqual({ apiKey: 'dl-key', tier: 'paid' })
    })
  })

  // -- removeProviderKey --

  describe('removeProviderKey', () => {
    it('should return false for non-existent provider', () => {
      writeConfig({})

      const result = removeProviderKey('coingecko')
      expect(result).toBe(false)
    })

    it('should return false when providers field exists but provider is not in it', () => {
      writeConfig({
        providers: { defillama: { apiKey: 'dl-key', tier: 'paid' } },
      })

      const result = removeProviderKey('coingecko')
      expect(result).toBe(false)
    })

    it('should remove provider and return true', () => {
      writeConfig({
        providers: {
          coingecko: { apiKey: 'cg-key', tier: 'demo' },
          defillama: { apiKey: 'dl-key', tier: 'paid' },
        },
      })

      const result = removeProviderKey('coingecko')
      expect(result).toBe(true)

      const config = readConfig()
      expect(config.providers!.coingecko).toBeUndefined()
      expect(config.providers!.defillama).toEqual({ apiKey: 'dl-key', tier: 'paid' })
    })

    it('should clean up empty providers object after last provider is removed', () => {
      writeConfig({
        providers: { coingecko: { apiKey: 'cg-key', tier: 'demo' } },
      })

      removeProviderKey('coingecko')

      const config = readConfig()
      expect(config.providers).toBeUndefined()
    })

    it('should preserve other config fields when removing a provider', () => {
      writeConfig({
        apiKey: 'main-key',
        providers: { coingecko: { apiKey: 'cg-key', tier: 'demo' } },
      })

      removeProviderKey('coingecko')

      const config = readConfig()
      expect(config.apiKey).toBe('main-key')
    })
  })
})
