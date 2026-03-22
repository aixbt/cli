import { describe, it, expect } from 'vitest'

import { goplusProvider } from '../../../src/lib/providers/goplus.js'
import { CliError } from '../../../src/lib/errors.js'

describe('goplusProvider', () => {
  // -- Provider identity --

  describe('provider metadata', () => {
    it('should have name "goplus"', () => {
      expect(goplusProvider.name).toBe('goplus')
    })

    it('should have displayName "GoPlus"', () => {
      expect(goplusProvider.displayName).toBe('GoPlus')
    })

    it('should have authHeader "Authorization"', () => {
      expect(goplusProvider.authHeader).toBe('Authorization')
    })

    it('should have default baseUrl pointing to api.gopluslabs.io', () => {
      expect(goplusProvider.baseUrl.default).toBe('https://api.gopluslabs.io')
    })

    it('should have free tier baseUrl pointing to api.gopluslabs.io', () => {
      expect(goplusProvider.baseUrl.byTier.free).toBe(
        'https://api.gopluslabs.io',
      )
    })
  })

  // -- Auth --

  describe('buildAuthValue', () => {
    it('should produce a Bearer token from the API key', () => {
      const result = goplusProvider.buildAuthValue!('my-secret-key')
      expect(result).toBe('Bearer my-secret-key')
    })

    it('should handle empty string API key', () => {
      const result = goplusProvider.buildAuthValue!('')
      expect(result).toBe('Bearer ')
    })
  })

  // -- Rate limits --

  describe('tiers', () => {
    it('should have free tier rate limit of 30 per minute', () => {
      expect(goplusProvider.tiers.free.ratePerMinute).toBe(30)
    })

    it('should have paid tier rate limit of 120 per minute', () => {
      expect(goplusProvider.tiers.paid.ratePerMinute).toBe(120)
    })
  })

  // -- Actions --

  describe('actions', () => {
    const expectedActions = [
      'token-security',
      'solana-token-security',
      'sui-token-security',
      'address-security',
      'nft-security',
      'approval-security',
      'phishing-site',
      'supported-chains',
      'security-check',
    ]

    it('should define all 9 actions', () => {
      const actionNames = Object.keys(goplusProvider.actions)
      expect(actionNames).toHaveLength(9)
      for (const name of expectedActions) {
        expect(goplusProvider.actions).toHaveProperty(name)
      }
    })

    it('should use method GET for all actions', () => {
      for (const [name, action] of Object.entries(goplusProvider.actions)) {
        expect(action.method, `action "${name}" should use GET`).toBe('GET')
      }
    })

    it('should use minTier "free" for all actions', () => {
      for (const [name, action] of Object.entries(goplusProvider.actions)) {
        expect(
          action.minTier,
          `action "${name}" should have minTier "free"`,
        ).toBe('free')
      }
    })

    it('should have a non-empty description and hint for every action', () => {
      for (const [name, action] of Object.entries(goplusProvider.actions)) {
        expect(
          action.description.length,
          `action "${name}" should have a description`,
        ).toBeGreaterThan(0)
        expect(
          action.hint.length,
          `action "${name}" should have a hint`,
        ).toBeGreaterThan(0)
      }
    })

    // -- token-security action --

    describe('token-security action', () => {
      it('should have path with {chain_id} placeholder', () => {
        expect(goplusProvider.actions['token-security'].path).toContain(
          '{chain_id}',
        )
      })

      it('should have chain_id param that is required with inPath true', () => {
        const param = goplusProvider.actions['token-security'].params.find(
          (p) => p.name === 'chain_id',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
        expect(param!.inPath).toBe(true)
      })

      it('should have contract_addresses param that is required', () => {
        const param = goplusProvider.actions['token-security'].params.find(
          (p) => p.name === 'contract_addresses',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
      })
    })

    // -- solana-token-security action --

    describe('solana-token-security action', () => {
      it('should have path containing /solana/', () => {
        expect(goplusProvider.actions['solana-token-security'].path).toContain(
          '/solana/',
        )
      })

      it('should have contract_addresses param that is required', () => {
        const param = goplusProvider.actions[
          'solana-token-security'
        ].params.find((p) => p.name === 'contract_addresses')
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
      })

      it('should have no path params', () => {
        const pathParams = goplusProvider.actions[
          'solana-token-security'
        ].params.filter((p) => p.inPath)
        expect(pathParams).toHaveLength(0)
      })
    })

    // -- sui-token-security action --

    describe('sui-token-security action', () => {
      it('should have path containing /sui/', () => {
        expect(goplusProvider.actions['sui-token-security'].path).toContain(
          '/sui/',
        )
      })

      it('should have contract_addresses param that is required', () => {
        const param = goplusProvider.actions['sui-token-security'].params.find(
          (p) => p.name === 'contract_addresses',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
      })
    })

    // -- address-security action --

    describe('address-security action', () => {
      it('should have path with {address} placeholder', () => {
        expect(goplusProvider.actions['address-security'].path).toContain(
          '{address}',
        )
      })

      it('should have address param that is required with inPath true', () => {
        const param = goplusProvider.actions['address-security'].params.find(
          (p) => p.name === 'address',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
        expect(param!.inPath).toBe(true)
      })

      it('should have chain_id param that is optional', () => {
        const param = goplusProvider.actions['address-security'].params.find(
          (p) => p.name === 'chain_id',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(false)
      })
    })

    // -- nft-security action --

    describe('nft-security action', () => {
      it('should have path with {chain_id} placeholder', () => {
        expect(goplusProvider.actions['nft-security'].path).toContain(
          '{chain_id}',
        )
      })

      it('should have chain_id and contract_address params both required', () => {
        const chainParam = goplusProvider.actions['nft-security'].params.find(
          (p) => p.name === 'chain_id',
        )
        const contractParam = goplusProvider.actions[
          'nft-security'
        ].params.find((p) => p.name === 'contract_address')
        expect(chainParam).toBeDefined()
        expect(chainParam!.required).toBe(true)
        expect(contractParam).toBeDefined()
        expect(contractParam!.required).toBe(true)
      })
    })

    // -- approval-security action --

    describe('approval-security action', () => {
      it('should have path with {chain_id} placeholder', () => {
        expect(goplusProvider.actions['approval-security'].path).toContain(
          '{chain_id}',
        )
      })

      it('should have chain_id and contract_addresses params both required', () => {
        const chainParam = goplusProvider.actions[
          'approval-security'
        ].params.find((p) => p.name === 'chain_id')
        const contractParam = goplusProvider.actions[
          'approval-security'
        ].params.find((p) => p.name === 'contract_addresses')
        expect(chainParam).toBeDefined()
        expect(chainParam!.required).toBe(true)
        expect(contractParam).toBeDefined()
        expect(contractParam!.required).toBe(true)
      })
    })

    // -- phishing-site action --

    describe('phishing-site action', () => {
      it('should have path containing phishing_site', () => {
        expect(goplusProvider.actions['phishing-site'].path).toContain(
          'phishing_site',
        )
      })

      it('should have url param that is required', () => {
        const param = goplusProvider.actions['phishing-site'].params.find(
          (p) => p.name === 'url',
        )
        expect(param).toBeDefined()
        expect(param!.required).toBe(true)
      })

      it('should have no path params', () => {
        const pathParams = goplusProvider.actions[
          'phishing-site'
        ].params.filter((p) => p.inPath)
        expect(pathParams).toHaveLength(0)
      })
    })

    // -- supported-chains action --

    describe('supported-chains action', () => {
      it('should have path containing supported_chains', () => {
        expect(goplusProvider.actions['supported-chains'].path).toContain(
          'supported_chains',
        )
      })

      it('should have empty params array', () => {
        expect(goplusProvider.actions['supported-chains'].params).toEqual([])
      })
    })
  })

  // -- normalize function --

  describe('normalize', () => {
    // -- Success envelope --

    it('should extract result from a success envelope with code 1', () => {
      const body = { code: 1, result: { is_honeypot: '0', buy_tax: '0.05' } }
      const result = goplusProvider.normalize(body, 'supported-chains')
      expect(result).toEqual({ is_honeypot: '0', buy_tax: '0.05' })
    })

    it('should return result array from success envelope', () => {
      const body = { code: 1, result: [{ id: '1', name: 'Ethereum' }] }
      const result = goplusProvider.normalize(body, 'supported-chains')
      expect(result).toEqual([{ id: '1', name: 'Ethereum' }])
    })

    // -- Error envelope --

    it('should throw CliError when code is not 1', () => {
      const body = { code: 2, message: 'Invalid contract address' }
      expect(() => goplusProvider.normalize(body, 'token-security')).toThrow(
        CliError,
      )
    })

    it('should include the action name in the error message', () => {
      const body = { code: 2, message: 'Invalid contract address' }
      expect(() =>
        goplusProvider.normalize(body, 'token-security'),
      ).toThrowError(/goplus:token-security/)
    })

    it('should include the API error message in the thrown error', () => {
      const body = { code: 2, message: 'Invalid contract address' }
      expect(() =>
        goplusProvider.normalize(body, 'token-security'),
      ).toThrowError(/Invalid contract address/)
    })

    it('should have PROVIDER_API_ERROR error code on thrown CliError', () => {
      const body = { code: 2, message: 'Bad request' }
      try {
        goplusProvider.normalize(body, 'token-security')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CliError)
        expect((err as CliError).code).toBe('PROVIDER_API_ERROR')
      }
    })

    it('should use default error message when envelope message is not a string', () => {
      const body = { code: 0, message: null }
      expect(() =>
        goplusProvider.normalize(body, 'token-security'),
      ).toThrowError(/GoPlus API error/)
    })

    it('should throw on code 0', () => {
      const body = { code: 0, message: 'Some error' }
      expect(() => goplusProvider.normalize(body, 'token-security')).toThrow(
        CliError,
      )
    })

    // -- Address-keyed result flattening --

    it('should flatten single-address result for token-security action', () => {
      const body = {
        code: 1,
        result: {
          '0xabc123': {
            is_honeypot: '0',
            buy_tax: '0.05',
          },
        },
      }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual({ is_honeypot: '0', buy_tax: '0.05' })
    })

    it('should flatten single-address result for solana-token-security action', () => {
      const body = {
        code: 1,
        result: {
          SoLaNaAddr123: {
            mintable: true,
            freezable: false,
          },
        },
      }
      const result = goplusProvider.normalize(body, 'solana-token-security')
      expect(result).toEqual({ mintable: true, freezable: false })
    })

    it('should flatten single-address result for sui-token-security action', () => {
      const body = {
        code: 1,
        result: {
          '0xsui456': { upgradeable: false },
        },
      }
      const result = goplusProvider.normalize(body, 'sui-token-security')
      expect(result).toEqual({ upgradeable: false })
    })

    it('should flatten single-address result for address-security action', () => {
      const body = {
        code: 1,
        result: {
          '0xwallet789': { is_malicious: '0' },
        },
      }
      const result = goplusProvider.normalize(body, 'address-security')
      expect(result).toEqual({ is_malicious: '0' })
    })

    it('should flatten single-address result for nft-security action', () => {
      const body = {
        code: 1,
        result: {
          '0xnft000': { restricted_transfer: '0' },
        },
      }
      const result = goplusProvider.normalize(body, 'nft-security')
      expect(result).toEqual({ restricted_transfer: '0' })
    })

    it('should flatten single-address result for approval-security action', () => {
      const body = {
        code: 1,
        result: {
          '0xapproval': { is_contract: '1' },
        },
      }
      const result = goplusProvider.normalize(body, 'approval-security')
      expect(result).toEqual({ is_contract: '1' })
    })

    it('should return array with address field when multiple addresses in result', () => {
      const body = {
        code: 1,
        result: {
          '0xabc': { is_honeypot: '0' },
          '0xdef': { is_honeypot: '1' },
        },
      }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual([
        { address: '0xabc', is_honeypot: '0' },
        { address: '0xdef', is_honeypot: '1' },
      ])
    })

    it('should return null for empty result object on address-keyed action', () => {
      const body = { code: 1, result: {} }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toBeNull()
    })

    it('should not flatten result for non-address-keyed actions', () => {
      const body = {
        code: 1,
        result: {
          '0xabc': { is_honeypot: '0' },
        },
      }
      const result = goplusProvider.normalize(body, 'phishing-site')
      expect(result).toEqual({ '0xabc': { is_honeypot: '0' } })
    })

    it('should not flatten result for supported-chains action', () => {
      const body = {
        code: 1,
        result: {
          someKey: { chainId: '1' },
        },
      }
      const result = goplusProvider.normalize(body, 'supported-chains')
      expect(result).toEqual({ someKey: { chainId: '1' } })
    })

    // -- Edge cases for non-object/primitive inputs --

    it('should return body as-is when body is null', () => {
      const result = goplusProvider.normalize(null, 'token-security')
      expect(result).toBeNull()
    })

    it('should return body as-is when body is undefined', () => {
      const result = goplusProvider.normalize(undefined, 'token-security')
      expect(result).toBeUndefined()
    })

    it('should return body as-is when body is a primitive string', () => {
      const result = goplusProvider.normalize('raw string', 'token-security')
      expect(result).toBe('raw string')
    })

    it('should return body as-is when body is a number', () => {
      const result = goplusProvider.normalize(42, 'token-security')
      expect(result).toBe(42)
    })

    // -- Edge cases for result field --

    it('should return body as-is when there is no result field and no code field', () => {
      const body = { status: 'ok', data: [1, 2, 3] }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual({ status: 'ok', data: [1, 2, 3] })
    })

    it('should return body when result is undefined in envelope with code 1', () => {
      const body = { code: 1 }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual({ code: 1 })
    })

    it('should handle result being an array for address-keyed action (pass through)', () => {
      const body = { code: 1, result: [1, 2, 3] }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual([1, 2, 3])
    })

    it('should handle result being null for address-keyed action', () => {
      const body = { code: 1, result: null }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toBeNull()
    })

    it('should handle multi-address result where a value is not an object', () => {
      const body = {
        code: 1,
        result: {
          '0xabc': 'not-an-object',
          '0xdef': 42,
        },
      }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toEqual([
        { address: '0xabc', data: 'not-an-object' },
        { address: '0xdef', data: 42 },
      ])
    })

    it('should handle single-address result where value is a primitive', () => {
      const body = {
        code: 1,
        result: {
          '0xonly': 'primitive-value',
        },
      }
      const result = goplusProvider.normalize(body, 'token-security')
      expect(result).toBe('primitive-value')
    })
  })

  // -- mapParams (chain ID mapping) --

  describe('mapParams', () => {
    it('should map CoinGecko chain name to numeric chain ID', () => {
      const result = goplusProvider.mapParams!(
        { chain_id: 'ethereum', contract_addresses: '0xabc' },
        'token-security',
      )
      expect(result.chain_id).toBe('1')
    })

    it('should map binance-smart-chain to 56', () => {
      const result = goplusProvider.mapParams!(
        { chain_id: 'binance-smart-chain', contract_addresses: '0xabc' },
        'token-security',
      )
      expect(result.chain_id).toBe('56')
    })

    it('should pass through already-numeric chain IDs', () => {
      const result = goplusProvider.mapParams!(
        { chain_id: '1', contract_addresses: '0xabc' },
        'token-security',
      )
      expect(result.chain_id).toBe('1')
    })
  })
})
