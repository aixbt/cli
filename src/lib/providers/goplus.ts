import type { Provider, ActionDefinition, Params } from './types.js'
import { CliError } from '../errors.js'
import { hasValue } from './utils.js'
import { toChainId } from './chains.js'

const ADDRESS_KEYED_ACTIONS = new Set([
  'token-security',
  'solana-token-security',
  'sui-token-security',
  'address-security',
  'nft-security',
  'approval-security',
])

const actions: Record<string, ActionDefinition> = {
  'token-security': {
    method: 'GET',
    path: '/api/v1/token_security/{chain_id}',
    description: 'Analyze EVM token security (honeypot, tax, mint authority)',
    hint: 'You need to check if an EVM token is a honeypot, has hidden taxes, or has dangerous mint/owner functions',
    params: [
      { name: 'chain_id', required: true, description: 'Chain ID (1=Ethereum, 56=BSC, 137=Polygon, 42161=Arbitrum, 8453=Base)', inPath: true },
      { name: 'contract_addresses', required: true, description: 'Comma-separated token contract addresses' },
    ],
    minTier: 'free',
  },
  'solana-token-security': {
    method: 'GET',
    path: '/api/v1/solana/token_security',
    description: 'Analyze Solana token security (mint/freeze authority, metadata risks)',
    hint: 'You need to check Solana token safety: mint authority, freeze authority, and metadata risks',
    params: [
      { name: 'contract_addresses', required: true, description: 'Comma-separated Solana token addresses' },
    ],
    minTier: 'free',
  },
  'sui-token-security': {
    method: 'GET',
    path: '/api/v1/sui/token_security',
    description: 'Analyze Sui token security (upgradeability, permissions)',
    hint: 'You need to check Sui token safety: upgradeability and permission risks',
    params: [
      { name: 'contract_addresses', required: true, description: 'Comma-separated Sui token addresses' },
    ],
    minTier: 'free',
  },
  'address-security': {
    method: 'GET',
    path: '/api/v1/address_security/{address}',
    description: 'Check if an address is associated with malicious activity',
    hint: 'You need to verify whether a wallet address has been flagged as malicious, a mixer, or involved in phishing',
    params: [
      { name: 'address', required: true, description: 'Wallet address to check', inPath: true },
      { name: 'chain_id', required: false, description: 'Chain ID for chain-specific checks' },
    ],
    minTier: 'free',
  },
  'nft-security': {
    method: 'GET',
    path: '/api/v1/nft_security/{chain_id}',
    description: 'Analyze NFT contract security risks',
    hint: 'You need to check NFT contract safety: privileged functions, transfer restrictions, and metadata',
    params: [
      { name: 'chain_id', required: true, description: 'Chain ID (1=Ethereum, 56=BSC, 137=Polygon)', inPath: true },
      { name: 'contract_address', required: true, description: 'NFT contract address' },
    ],
    minTier: 'free',
  },
  'approval-security': {
    method: 'GET',
    path: '/api/v1/approval_security/{chain_id}',
    description: 'Check token approval security vulnerabilities',
    hint: 'You need to audit token approvals for a contract: check for unlimited approvals, proxy risks, or known exploits',
    params: [
      { name: 'chain_id', required: true, description: 'Chain ID', inPath: true },
      { name: 'contract_addresses', required: true, description: 'Comma-separated contract addresses' },
    ],
    minTier: 'free',
  },
  'phishing-site': {
    method: 'GET',
    path: '/api/v1/phishing_site',
    description: 'Check if a URL is a known phishing site',
    hint: 'You need to verify whether a URL is safe or has been flagged as a phishing/scam site',
    params: [
      { name: 'url', required: true, description: 'URL to check' },
    ],
    minTier: 'free',
  },
  'supported-chains': {
    method: 'GET',
    path: '/api/v1/supported_chains',
    description: 'List all chains supported by GoPlus security analysis',
    hint: 'You need the list of chain IDs that GoPlus supports for token and address security checks',
    params: [],
    minTier: 'free',
  },
  'security-check': {
    method: 'GET',
    description: 'Token security check — routes to EVM, Solana, or Sui security endpoint based on chain',
    hint: 'You have a token address and chain and need security analysis including holder concentration, honeypot checks, and contract risks',
    params: [
      { name: 'chain', required: true, description: 'Chain name (e.g., "ethereum", "solana", "sui") — CoinGecko chain names accepted' },
      { name: 'address', required: true, description: 'Token contract address' },
    ],
    minTier: 'free',
    resolve: (params) => {
      if (!hasValue(params.chain) || !hasValue(params.address)) return null

      const chain = String(params.chain).toLowerCase()

      if (chain === 'solana') {
        return {
          action: 'solana-token-security',
          params: { contract_addresses: params.address },
        }
      }

      if (chain === 'sui') {
        return {
          action: 'sui-token-security',
          params: { contract_addresses: params.address },
        }
      }

      // EVM — only proceed if we can map to a numeric chain ID (or it's tron which GoPlus accepts raw)
      if (chain !== 'tron' && !toChainId(chain)) return null

      return {
        action: 'token-security',
        params: { chain_id: params.chain, contract_addresses: params.address },
      }
    },
  },
}

export const goplusProvider: Provider = {
  name: 'goplus',
  displayName: 'GoPlus',
  actions,
  baseUrl: {
    byTier: {
      free: 'https://api.gopluslabs.io',
    },
    default: 'https://api.gopluslabs.io',
  },
  rateLimits: {
    perMinute: {
      free: 30,
      pro: 120,
    },
  },
  authHeader: 'Authorization',
  buildAuthValue: (apiKey: string) => `Bearer ${apiKey}`,
  mapParams: (params: Params) => {
    const chainId = params.chain_id
    if (typeof chainId !== 'string') return params
    const mapped = toChainId(chainId)
    if (!mapped) return params
    return { ...params, chain_id: mapped }
  },
  normalize: (body: unknown, actionName: string): unknown => {
    if (typeof body !== 'object' || body === null) return body
    const envelope = body as Record<string, unknown>

    // GoPlus error: code !== 1 is a hard failure
    if (envelope.code !== undefined && envelope.code !== 1) {
      const message = typeof envelope.message === 'string' ? envelope.message : 'GoPlus API error'
      throw new CliError(`goplus:${actionName} - ${message}`, 'PROVIDER_API_ERROR')
    }

    const result = envelope.result
    if (result === undefined) return body

    // Address-keyed actions: flatten { "0xabc...": { ...data } }
    if (ADDRESS_KEYED_ACTIONS.has(actionName)) {
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        const entries = Object.entries(result as Record<string, unknown>)
        if (entries.length === 0) return null
        if (entries.length === 1) return entries[0][1]
        return entries.map(([address, data]) => ({
          address,
          ...(typeof data === 'object' && data !== null ? data as Record<string, unknown> : { data }),
        }))
      }
    }

    return result
  },
}
