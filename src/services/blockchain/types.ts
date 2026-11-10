export type EscrowContractState = { state: 'not_deployed' } | { state: 'deployed'; address: `0x${string}` }
export interface NetworkInfo { chainId: number; name: string; explorerBase: string; usdcAddress: `0x${string}`; usdcDecimals: number }
/** Read-only application facade. Wallet writes use RetempoClient and TransactionRunner. */
export interface BlockchainService {
 readonly network: NetworkInfo
 getUsdcBalance(owner: `0x${string}`): Promise<string>
 getEscrowContractState(): Promise<EscrowContractState>
}
