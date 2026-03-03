import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  setConfigPath,
  getConfigPath,
  readConfig,
  writeConfig,
  clearConfig,
  resolveConfig,
  DEFAULT_API_URL,
} from '../../src/lib/config.js'

import type { AixbtConfig } from '../../src/lib/config.js'

describe('config', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aixbt-test-'))
    setConfigPath(join(tempDir, 'config.json'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    // Reset config path override by setting to a neutral value.
    // The next beforeEach will set a fresh path anyway.
    setConfigPath(join(tmpdir(), 'aixbt-test-reset-nonexistent', 'config.json'))

    // Clean up env vars that tests may have set
    delete process.env.AIXBT_API_KEY
    delete process.env.AIXBT_API_URL
    delete process.env.AIXBT_CONFIG
  })

  // -- readConfig --

  describe('readConfig', () => {
    it('should return empty config when no config file exists', () => {
      const config = readConfig()
      expect(config).toEqual({})
    })

    it('should return parsed config after writeConfig', () => {
      const input: AixbtConfig = {
        apiKey: 'test-key-123',
        apiUrl: 'https://custom.api.com',
        keyType: 'full',
        expiresAt: '2026-12-31T00:00:00Z',
        scopes: ['read', 'write'],
      }
      writeConfig(input)
      const result = readConfig()
      expect(result).toEqual(input)
    })

    it('should return empty config when file contains corrupt JSON', () => {
      writeFileSync(getConfigPath(), 'this is not valid json{{{', 'utf-8')

      const config = readConfig()
      expect(config).toEqual({})
    })
  })

  // -- writeConfig --

  describe('writeConfig', () => {
    it('should create the config file with 0o600 permissions', () => {
      writeConfig({ apiKey: 'secret' })

      const stats = statSync(getConfigPath())
      // 0o600 = owner read+write, no group/other permissions
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('should create the config directory with 0o700 permissions', () => {
      const nestedDir = join(tempDir, 'nested', 'deep')
      setConfigPath(join(nestedDir, 'config.json'))

      writeConfig({ apiKey: 'test' })

      const stats = statSync(nestedDir)
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o700)
    })

    it('should persist config as formatted JSON with trailing newline', () => {
      const input: AixbtConfig = { apiKey: 'abc' }
      writeConfig(input)

      const raw = readFileSync(getConfigPath(), 'utf-8')
      expect(raw).toBe(JSON.stringify(input, null, 2) + '\n')
    })
  })

  // -- clearConfig --

  describe('clearConfig', () => {
    it('should remove the config file', () => {
      writeConfig({ apiKey: 'to-delete' })
      expect(existsSync(getConfigPath())).toBe(true)

      clearConfig()
      expect(existsSync(getConfigPath())).toBe(false)
    })

    it('should not throw when no config file exists', () => {
      // No file has been written -- clearConfig should be safe
      expect(() => clearConfig()).not.toThrow()
    })
  })

  // -- resolveConfig --

  describe('resolveConfig', () => {
    it('should use default API URL when none configured', () => {
      const resolved = resolveConfig()

      expect(resolved.apiUrl).toBe(DEFAULT_API_URL)
      expect(resolved.apiKey).toBeUndefined()
      expect(resolved.keyType).toBeUndefined()
      expect(resolved.expiresAt).toBeUndefined()
      expect(resolved.scopes).toEqual([])
    })

    it('should use config file values as fallback', () => {
      writeConfig({
        apiKey: 'config-key',
        apiUrl: 'https://config.api.com',
        keyType: 'full',
        expiresAt: '2026-06-01T00:00:00Z',
        scopes: ['read'],
      })

      const resolved = resolveConfig()
      expect(resolved.apiKey).toBe('config-key')
      expect(resolved.apiUrl).toBe('https://config.api.com')
      expect(resolved.keyType).toBe('full')
      expect(resolved.expiresAt).toBe('2026-06-01T00:00:00Z')
      expect(resolved.scopes).toEqual(['read'])
    })

    it('should override config file values with env vars', () => {
      writeConfig({
        apiKey: 'config-key',
        apiUrl: 'https://config.api.com',
      })

      process.env.AIXBT_API_KEY = 'env-key'
      process.env.AIXBT_API_URL = 'https://env.api.com'

      const resolved = resolveConfig()
      expect(resolved.apiKey).toBe('env-key')
      expect(resolved.apiUrl).toBe('https://env.api.com')
    })

    it('should override env vars with flags', () => {
      process.env.AIXBT_API_KEY = 'env-key'
      process.env.AIXBT_API_URL = 'https://env.api.com'

      const resolved = resolveConfig({
        apiKey: 'flag-key',
        apiUrl: 'https://flag.api.com',
      })

      expect(resolved.apiKey).toBe('flag-key')
      expect(resolved.apiUrl).toBe('https://flag.api.com')
    })

    it('should follow full priority chain: flag > env > config', () => {
      writeConfig({ apiKey: 'config-key', apiUrl: 'https://config.api.com' })
      process.env.AIXBT_API_KEY = 'env-key'
      process.env.AIXBT_API_URL = 'https://env.api.com'

      // Flags win over everything
      const withFlags = resolveConfig({
        apiKey: 'flag-key',
        apiUrl: 'https://flag.api.com',
      })
      expect(withFlags.apiKey).toBe('flag-key')
      expect(withFlags.apiUrl).toBe('https://flag.api.com')

      // Without flags, env wins over config
      const withoutFlags = resolveConfig()
      expect(withoutFlags.apiKey).toBe('env-key')
      expect(withoutFlags.apiUrl).toBe('https://env.api.com')

      // Without flags or env, config wins
      delete process.env.AIXBT_API_KEY
      delete process.env.AIXBT_API_URL
      const configOnly = resolveConfig()
      expect(configOnly.apiKey).toBe('config-key')
      expect(configOnly.apiUrl).toBe('https://config.api.com')
    })

    it('should default scopes to empty array when not set in config', () => {
      writeConfig({ apiKey: 'test' })

      const resolved = resolveConfig()
      expect(resolved.scopes).toEqual([])
    })

    it('should preserve scopes from config when set', () => {
      writeConfig({ scopes: ['admin', 'read', 'write'] })

      const resolved = resolveConfig()
      expect(resolved.scopes).toEqual(['admin', 'read', 'write'])
    })
  })

  // -- setConfigPath / getConfigPath --

  describe('setConfigPath', () => {
    it('should override the default config path', () => {
      const customPath = join(tempDir, 'custom-config.json')
      setConfigPath(customPath)

      expect(getConfigPath()).toBe(customPath)
    })

    it('should cause reads and writes to use the overridden path', () => {
      const customPath = join(tempDir, 'alt', 'config.json')
      setConfigPath(customPath)

      writeConfig({ apiKey: 'via-custom-path' })

      expect(existsSync(customPath)).toBe(true)
      expect(readConfig().apiKey).toBe('via-custom-path')
    })
  })
})
