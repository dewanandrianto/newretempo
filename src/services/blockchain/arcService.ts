import { createPublicClient, custom, erc20Abi, http, type Address, type WalletClient } from 'viem'
import { arcTestnet } from 'viem/chains'
import type { ChainConfiguration, ChainCheckout, ChainSnapshot, ChainSyncResult, ChainPlanPreparation } from '../../../shared/chain'
import { get, post } from '../api/client'
import { assertDeployment } from './guards'
import { RetempoClient, type ChainIO } from './client'
import { displayUsdc } from './amounts'
import type { BlockchainService } from './types'
import { collectChainPages } from '../../../shared/chainPages'
const completeSnapshot = (path:string) => collectChainPages(token => get<ChainSnapshot>(path + (token ? `${path.includes('?')?'&':'?'}pageToken=${encodeURIComponent(token)}` : '')))
export const chainApi = {
	configuration: () => get<ChainConfiguration>('/chain/config'),
	 checkout: (token:string,invoice=false) => get<ChainCheckout>(`/public/${invoice?'invoices':'checkouts'}/${encodeURIComponent(token)}`),
	 merchantWalletStatus: (orgId:string,wallet:Address) => get<{verified:boolean;available:boolean;reason:'wallet_in_use'|null}>(`/orgs/${encodeURIComponent(orgId)}/merchant-wallet/status?address=${encodeURIComponent(wallet)}`),
	 customerWalletStatus: (token:string,wallet:Address) => get<{linked:boolean;available:boolean;reason:'merchant_wallet'|'email_verification_required'|'customer_record_in_use'|'wallet_in_use'|null}>(`/public/checkouts/${encodeURIComponent(token)}/customer-wallet?wallet=${encodeURIComponent(wallet)}`),
	customerWalletChallenge: (token:string,wallet:Address) => post<{message:string;expiresAt:string}|{linked:true;address:Address}>(`/public/checkouts/${encodeURIComponent(token)}/customer-wallet/nonce`,{address:wallet}),
	verifyCustomerWallet: (token:string,input:{message:string;signature:`0x${string}`}) => post<{linked:true;address:Address}>(`/public/checkouts/${encodeURIComponent(token)}/customer-wallet/verify`,input),
	prepareCheckout: (token:string,wallet:Address) => post<ChainCheckout>(`/public/checkouts/${encodeURIComponent(token)}/prepare`,{wallet}),
	customerSnapshot: () => completeSnapshot('/customer/chain/snapshot/pages'),
 walletSnapshot: (wallet:Address) => completeSnapshot(`/wallet/chain/snapshot?wallet=${encodeURIComponent(wallet)}`),
 organizationSnapshot: (orgId:string) => completeSnapshot(`/orgs/${encodeURIComponent(orgId)}/chain/snapshot`),
 sync: () => post<ChainSyncResult>('/chain/sync',{}),
 preparePlan: (orgId:string,planId:string,input:{wallet:Address;payout:Address;arbitrator:Address;customerMayRefundUnvested:boolean;graceSeconds?:number}) => post<ChainPlanPreparation>(`/orgs/${encodeURIComponent(orgId)}/chain/plans/${encodeURIComponent(planId)}/prepare`,input),
 createCheckout: (orgId:string,input:{subscriptionId:string;invoiceId?:string;expiresInSeconds?:number}) => post<{token:string;url:string;checkout:ChainCheckout}>(`/orgs/${encodeURIComponent(orgId)}/chain/checkouts`,input),
}
export function configuredReader(configuration:ChainConfiguration) {
 assertDeployment(configuration)
 return createPublicClient({chain:{...arcTestnet,rpcUrls:{default:{http:[configuration.rpcUrl]}}},transport:http(configuration.rpcUrl,{retryCount:0})})
}
export function createRetempoClient(configuration:ChainConfiguration,wallet:WalletClient):RetempoClient {
 const reader=configuredReader(configuration)
 if(!wallet.account)throw new Error('Sign in to continue with your wallet.')
 const account=wallet.account.address
 const provider=createPublicClient({transport:custom(wallet.transport,{retryCount:0})})
 const io:ChainIO={
  account,
  reader:request=>reader.transport.request(request),
  wallet:request=>provider.transport.request(request),
  read:call=>reader.readContract(call),
  simulate:async call=>{await reader.simulateContract({...call,account})},
  send:async call=>{
   // Recheck the live account and all world proofs immediately before the wallet prompt.
   await sdk.assertWallet()
   const accounts=await wallet.getAddresses()
   if(!accounts[0]||accounts[0].toLowerCase()!==account.toLowerCase())throw new Error('Wallet account changed. Reconnect and review the action.')
   return wallet.writeContract({...call,account,chain:reader.chain})
  },
  receipt:async hash=>(await reader.waitForTransactionReceipt({hash,confirmations:1,timeout:90000})).status,
 }
 const sdk=new RetempoClient(configuration,io)
 return sdk
}
export const arcBlockchainService:BlockchainService={
 network:{chainId:arcTestnet.id,name:'Configured network',explorerBase:arcTestnet.blockExplorers.default.url,usdcAddress:'0x3600000000000000000000000000000000000000',usdcDecimals:6},
  async getUsdcBalance(owner){const c=await chainApi.configuration();const reader=configuredReader(c);return displayUsdc(await reader.readContract({address:c.usdc,abi:erc20Abi,functionName:'balanceOf',args:[owner]}))},
 async getEscrowContractState(){const c=await chainApi.configuration();return c.configured&&c.escrow?{state:'deployed',address:c.escrow}:{state:'not_deployed'}},
}
export const explorerAddressUrl=(address:string)=>`${arcTestnet.blockExplorers.default.url}/address/${address}`
