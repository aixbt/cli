/**
 * Canonical chain mapping registry.
 *
 * Keys are CoinGecko platform IDs (the canonical chain identifier in our system,
 * sourced from project tokens[].chain). Each provider has its own naming convention;
 * this registry centralises the translations so adding a chain is a one-line change.
 */

interface ChainMapping {
  /** GeckoTerminal network ID (e.g. "eth", "bsc") */
  geckoTerminal?: string
  /** EIP-155 numeric chain ID as a string (e.g. "1", "56") */
  chainId?: string
  /** DeFiLlama chain name (e.g. "Ethereum", "BSC") */
  llama?: string
}

const CHAINS: Record<string, ChainMapping> = {
  'ethereum':             { geckoTerminal: 'eth',             chainId: '1',      llama: 'Ethereum' },
  'binance-smart-chain':  { geckoTerminal: 'bsc',             chainId: '56',     llama: 'BSC' },
  'polygon-pos':          { geckoTerminal: 'polygon_pos',     chainId: '137',    llama: 'Polygon' },
  'solana':               { geckoTerminal: 'solana',                             llama: 'Solana' },
  'base':                 { geckoTerminal: 'base',            chainId: '8453',   llama: 'Base' },
  'arbitrum-one':         { geckoTerminal: 'arbitrum',         chainId: '42161',  llama: 'Arbitrum' },
  'arbitrum-nova':        { geckoTerminal: 'arbitrum_nova' },
  'avalanche':            { geckoTerminal: 'avax',            chainId: '43114',  llama: 'Avalanche' },
  'optimistic-ethereum':  { geckoTerminal: 'optimism',        chainId: '10',     llama: 'Optimism' },
  'fantom':               { geckoTerminal: 'ftm',             chainId: '250',    llama: 'Fantom' },
  'cronos':               { geckoTerminal: 'cro',             chainId: '25',     llama: 'Cronos' },
  'moonbeam':             { geckoTerminal: 'glmr',                               llama: 'Moonbeam' },
  'moonriver':            { geckoTerminal: 'movr',                               llama: 'Moonriver' },
  'gnosis':               { geckoTerminal: 'xdai',            chainId: '100',    llama: 'Gnosis' },
  'the-open-network':     { geckoTerminal: 'ton',                                llama: 'TON' },
  'unichain':             { geckoTerminal: 'unichain',        chainId: '130',    llama: 'Unichain' },
  'near-protocol':        { geckoTerminal: 'near',                               llama: 'Near' },
  'sei-v2':               { geckoTerminal: 'sei-evm',                            llama: 'Sei' },
  'chiliz':               { geckoTerminal: 'chiliz-chain' },
  'immutable':            { geckoTerminal: 'immutable-zkevm',                    llama: 'Immutable zkEVM' },
  'klay-token':           { geckoTerminal: 'kaia',                               llama: 'Kaia' },
  'metis-andromeda':      { geckoTerminal: 'metis' },
  'flare-network':        { geckoTerminal: 'flare',                              llama: 'Flare' },
  'xrp':                  { geckoTerminal: 'xrpl',                               llama: 'XRPL' },
  'internet-computer':    { geckoTerminal: 'icp',                                llama: 'ICP' },
  'tron':                 {                                                      llama: 'Tron' },
  'sui':                  {                                                      llama: 'Sui' },
  'sonic':                {                                   chainId: '146',    llama: 'Sonic' },
  'abstract':             {                                   chainId: '2741',   llama: 'Abstract' },
  'hyperevm':             {                                                      llama: 'Hyperliquid L1' },
  'berachain':            {                                   chainId: '80094',  llama: 'Berachain' },
  'aptos':                {                                                      llama: 'Aptos' },
  'starknet':             {                                                      llama: 'Starknet' },
  'scroll':               {                                   chainId: '534352', llama: 'Scroll' },
  'linea':                {                                   chainId: '59144',  llama: 'Linea' },
  'blast':                {                                   chainId: '81457',  llama: 'Blast' },
  'mantle':               {                                   chainId: '5000',   llama: 'Mantle' },
  'zksync':               {                                   chainId: '324',    llama: 'ZKsync Era' },
  'cardano':              {                                                      llama: 'Cardano' },
  'stacks':               {                                                      llama: 'Stacks' },
  'kava':                 {                                                      llama: 'Kava' },
  'hedera-hashgraph':     {                                                      llama: 'Hedera' },
  'celo':                 {                                                      llama: 'Celo' },
  'world-chain':          {                                   chainId: '480',    llama: 'World Chain' },
  'injective':            {                                                      llama: 'Injective' },
  'osmosis':              {                                                      llama: 'Osmosis' },
  'soneium':              {                                   chainId: '1868',   llama: 'Soneium' },
  'ronin':                {                                                      llama: 'Ronin' },
  'manta-pacific':        {                                   chainId: '169' },
  'opbnb':                {                                   chainId: '204' },
  'merlin-chain':         {                                   chainId: '4200' },
  'zircuit':              {                                   chainId: '48900' },
  'bitlayer':             {                                   chainId: '200901' },
}

export function toGeckoTerminalNetwork(chain: string): string | undefined {
  return CHAINS[chain]?.geckoTerminal
}

export function toChainId(chain: string): string | undefined {
  return CHAINS[chain]?.chainId
}

export function toLlamaChain(chain: string): string | undefined {
  return CHAINS[chain]?.llama
}
