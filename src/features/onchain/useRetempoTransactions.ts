import { useCallback, useMemo, useRef, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import type { ChainConfiguration, ChainSnapshot } from '../../../shared/chain'
import { useAuth } from '@/features/auth/AuthProvider'
import { chainApi, createRetempoClient, RetempoClient, TransactionRunner, type TransactionState, type WriteTransaction } from '@/services/blockchain'
import { projectionProves, transactionId, type ProjectionTarget } from './proof'
import type { RememberVerification } from '@/services/blockchain/transactions'
type ContractPauseState = { managerPaused?: boolean | null; escrowPaused?: boolean | null }
/** The UI distinguishes confirmed pause from an unavailable deployment or unknown pause state. */
export function chainActionPauseMessage(configuration: ChainConfiguration | undefined): string | null {
 if (!configuration?.configured) return 'On-chain actions are disabled until a verified Arc Testnet deployment is available.'
 const pause = configuration as ChainConfiguration & ContractPauseState
 if (pause.managerPaused === true || pause.escrowPaused === true) return 'Verified Arc Testnet contracts are paused; payments and on-chain actions are unavailable.'
 if (pause.managerPaused !== false || pause.escrowPaused !== false) return 'On-chain actions are disabled because the live contract pause state could not be verified.'
 return null
}
/** Missing or unknown pause state is unsafe; both contracts must explicitly be unpaused. */
export function chainActionsPaused(configuration: ChainConfiguration | undefined): boolean {
 return chainActionPauseMessage(configuration) !== null
}
export function useRetempoTransactions(configuration:ChainConfiguration|undefined,operationKey:string,loadSnapshot:()=>Promise<ChainSnapshot>=chainApi.customerSnapshot) {
 const {address}=useAccount(),{data:wallet}=useWalletClient()
 const auth=useAuth(),queryClient=useQueryClient()
 const [state,setState]=useState<TransactionState>({id:'',phase:'idle'})
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const running=useRef(false)
 const id=useMemo(()=>configuration&&address?transactionId(configuration,address,'operation',operationKey):'', [configuration,address,operationKey])
 const runner=useMemo(()=>new TransactionRunner({getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v)},setState),[])
 const recovered=useMemo(()=>{try{return {state:id?(runner.load(id)??{id,phase:'idle' as const}):{id:'',phase:'idle' as const},error:undefined}}catch(e){return {state:{id,phase:'idle' as const},error:e instanceof Error?e.message:'Transaction recovery failed.'}}},[id,runner])
 const visibleState=state.id===id?state:recovered.state
 const client=useCallback(()=>{if(!configuration||!wallet||!address)throw new Error('Connect your wallet to continue.');return createRetempoClient(configuration,wallet)},[configuration,wallet,address])
 const guarded=useCallback(async(task:()=>Promise<void>)=>{
  if(running.current)return
  running.current=true;setBusy(true);setError(undefined)
  try{await task()}catch(e){setError(e instanceof Error?e.message:'The request failed.')}finally{running.current=false;setBusy(false)}
 },[])
 const ensureWalletSession=useCallback(async(sdk:RetempoClient)=>{
  await sdk.assertWallet()
  if(auth.session?.user.wallets.some(w=>w.toLowerCase()===address?.toLowerCase()))return
  const {message}=await auth.requestWalletChallenge(sdk.io.account)
  // The configured deployment must also match before SIWE, not only before payments.
  await sdk.assertWallet()
  const signature=await wallet!.signMessage({account:sdk.io.account,message})
  await auth.verifyWalletSignature({message,signature})
 },[auth,address,wallet])
 const signIn=useCallback(()=>guarded(async()=>{await ensureWalletSession(client());await queryClient.invalidateQueries({queryKey:['customer-chain']})}),[guarded,ensureWalletSession,client,queryClient])
 const sync=useCallback((target:ProjectionTarget)=>guarded(async()=>{
  if(!id)throw new Error('Connect the original wallet to recover this transaction.')
  await runner.verify(id,async hash=>{await chainApi.sync();const snapshot=await loadSnapshot();return projectionProves(snapshot,hash,runner.load(id)?.verification??target,configuration)})
  await queryClient.invalidateQueries({queryKey:['customer-chain']});await queryClient.invalidateQueries({queryKey:['public-checkout']});await queryClient.invalidateQueries({queryKey:['merchant-chain']});await queryClient.invalidateQueries({queryKey:['billing']})
 }),[guarded,id,runner,loadSnapshot,queryClient,configuration])
 const execute=useCallback((task:(sdk:RetempoClient,write:WriteTransaction,remember:RememberVerification)=>Promise<void>)=>guarded(async()=>{
  const pauseMessage=chainActionPauseMessage(configuration)
  if(pauseMessage)throw new Error(pauseMessage)
  const sdk=client();if(!id)throw new Error('Wallet operation identity is missing.')
  await ensureWalletSession(sdk)
  await runner.run(id,(write,remember)=>task(sdk,write,remember))
 }),[guarded,configuration,client,id,ensureWalletSession,runner])
 const resume=useCallback(()=>guarded(async()=>{const sdk=client();await sdk.assertWallet();await runner.resume(id,hash=>sdk.io.receipt(hash))}),[guarded,client,id,runner])
 const verifiedWallet=Boolean(address&&auth.session?.user.wallets.some(w=>w.toLowerCase()===address.toLowerCase()))
 return {state:visibleState,busy,error:error??recovered.error,execute,sync,resume,signIn,verifiedWallet,client}
}
