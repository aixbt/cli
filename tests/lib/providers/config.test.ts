import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('provider config', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-prov-test-'))
    setConfigPath(join(tempDir, 'config.json'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    setConfigPath(join(tmpdir(), 'aixbt-prov-test-reset-nonexistent', 'config.json'))

    // Clean up env vars that tests may have set
    delete process.env.COINGECKO_API_KEY
    delete process.env.DEFILLAMA_API_KEY
    delete process.env.GOPLUS_ACCESS_TOKEN
  })

  // -- resolveProviderKey --

  describe('resolveProviderKey', () => {
    it('should return null when no key is configured anywhere', () => {
      const result = resolveProviderKey('coingecko')
      expect(result).toBeNull()
    })

    // -- Layer 1: flag key --

    describe('flag key (layer 1)', () => {
      it('should use flag key with source "flag"', () => {
        const result = resolveProviderKey('coingecko', 'flag-key-123')

        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('flag-key-123')
        expect(result!.source).toBe('flag')
      })

      it('should use flagTier when provided', () => {
        const result = resolveProviderKey('coingecko', 'flag-key', 'pro')

        expect(result!.tier).toBe('pro')
      })

      it('should use default tier for known provider when flagTier is omitted', () => {
        // coingecko default tier is 'demo'
        const result = resolveProviderKey('coingecko', 'flag-key')
        expect(result!.tier).toBe('demo')

        // defillama default tier is 'pro'
        const result2 = resolveProviderKey('defillama', 'flag-key')
        expect(result2!.tier).toBe('pro')

        // goplus default tier is 'free'
        const result3 = resolveProviderKey('goplus', 'flag-key')
        expect(result3!.tier).toBe('free')
      })

      it('should fall back to "free" tier for unknown provider when flagTier is omitted', () => {
        const result = resolveProviderKey('unknown-provider', 'flag-key')
        expect(result!.tier).toBe('free')
      })

      it('should take priority over env var', () => {
        process.env.COINGECKO_API_KEY = 'env-key'

        const result = resolveProviderKey('coingecko', 'flag-key')
        expect(result!.apiKey).toBe('flag-key')
        expect(result!.source).toBe('flag')
      })

      it('should take priority over config file', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'pro' } },
        })

        const result = resolveProviderKey('coingecko', 'flag-key')
        expect(result!.apiKey).toBe('flag-key')
        expect(result!.source).toBe('flag')
      })
    })

    // -- Layer 2: env var --

    describe('env var (layer 2)', () => {
      it('should pick up COINGECKO_API_KEY from environment', () => {
        process.env.COINGECKO_API_KEY = 'env-cg-key'

        const result = resolveProviderKey('coingecko')
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('env-cg-key')
        expect(result!.source).toBe('env')
      })

      it('should pick up DEFILLAMA_API_KEY from environment', () => {
        process.env.DEFILLAMA_API_KEY = 'env-dl-key'

        const result = resolveProviderKey('defillama')
        expect(result!.apiKey).toBe('env-dl-key')
        expect(result!.source).toBe('env')
      })

      it('should pick up GOPLUS_ACCESS_TOKEN from environment', () => {
        process.env.GOPLUS_ACCESS_TOKEN = 'env-gp-key'

        const result = resolveProviderKey('goplus')
        expect(result!.apiKey).toBe('env-gp-key')
        expect(result!.source).toBe('env')
      })

      it('should use default tier for provider from env', () => {
        process.env.COINGECKO_API_KEY = 'env-key'
        expect(resolveProviderKey('coingecko')!.tier).toBe('demo')

        process.env.DEFILLAMA_API_KEY = 'env-key'
        expect(resolveProviderKey('defillama')!.tier).toBe('pro')

        process.env.GOPLUS_ACCESS_TOKEN = 'env-key'
        expect(resolveProviderKey('goplus')!.tier).toBe('free')
      })

      it('should take priority over config file', () => {
        process.env.COINGECKO_API_KEY = 'env-key'
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'pro' } },
        })

        const result = resolveProviderKey('coingecko')
        expect(result!.apiKey).toBe('env-key')
        expect(result!.source).toBe('env')
      })

      it('should return null for unknown provider with no env var mapping', () => {
        // 'unknown-provider' has no entry in PROVIDER_ENV_VARS
        const result = resolveProviderKey('unknown-provider')
        expect(result).toBeNull()
      })
    })

    // -- Layer 3: config file --

    describe('config file (layer 3)', () => {
      it('should use config file key when no flag or env is set', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'pro' } },
        })

        const result = resolveProviderKey('coingecko')
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('config-key')
        expect(result!.tier).toBe('pro')
        expect(result!.source).toBe('config')
      })

      it('should fallback to free tier when tier is missing from config', () => {
        // Simulate manually edited config with missing tier
        writeConfig({
          providers: { defillama: { apiKey: 'dl-key' } as unknown as Record<string, { apiKey: string; tier: string }>[string] },
        })

        const result = resolveProviderKey('defillama')
        expect(result).not.toBeNull()
        expect(result!.apiKey).toBe('dl-key')
        expect(result!.tier).toBe('free')
        expect(result!.source).toBe('config')
      })
    })

    // -- Priority chain --

    describe('priority: flag > env > config', () => {
      it('should resolve flag over env over config', () => {
        writeConfig({
          providers: { coingecko: { apiKey: 'config-key', tier: 'pro' } },
        })
        process.env.COINGECKO_API_KEY = 'env-key'

        // All three present: flag wins
        const withFlag = resolveProviderKey('coingecko', 'flag-key')
        expect(withFlag!.apiKey).toBe('flag-key')
        expect(withFlag!.source).toBe('flag')

        // No flag: env wins over config
        const withEnv = resolveProviderKey('coingecko')
        expect(withEnv!.apiKey).toBe('env-key')
        expect(withEnv!.source).toBe('env')

        // No flag, no env: config wins
        delete process.env.COINGECKO_API_KEY
        const configOnly = resolveProviderKey('coingecko')
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

      saveProviderKey('coingecko', { apiKey: 'new-key', tier: 'pro' })

      const config = readConfig()
      expect(config.providers!.coingecko).toEqual({ apiKey: 'new-key', tier: 'pro' })
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

      saveProviderKey('defillama', { apiKey: 'dl-key', tier: 'pro' })

      const config = readConfig()
      expect(config.providers!.coingecko).toEqual({ apiKey: 'cg-key', tier: 'demo' })
      expect(config.providers!.defillama).toEqual({ apiKey: 'dl-key', tier: 'pro' })
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
        providers: { defillama: { apiKey: 'dl-key', tier: 'pro' } },
      })

      const result = removeProviderKey('coingecko')
      expect(result).toBe(false)
    })

    it('should remove provider and return true', () => {
      writeConfig({
        providers: {
          coingecko: { apiKey: 'cg-key', tier: 'demo' },
          defillama: { apiKey: 'dl-key', tier: 'pro' },
        },
      })

      const result = removeProviderKey('coingecko')
      expect(result).toBe(true)

      const config = readConfig()
      expect(config.providers!.coingecko).toBeUndefined()
      expect(config.providers!.defillama).toEqual({ apiKey: 'dl-key', tier: 'pro' })
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
