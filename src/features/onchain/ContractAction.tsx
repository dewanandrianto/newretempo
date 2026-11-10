import type { ReactNode } from 'react'
import type { ChainConfiguration, ChainSnapshot } from '../../../shared/chain'
import type { RetempoClient, WriteTransaction } from '@/services/blockchain'
import { Button } from '@/components/ui/Button'
import { useRetempoTransactions } from './useRetempoTransactions'
import { TransactionStatus, canSubmit } from './TransactionStatus'
import type { ProjectionTarget } from './proof'
export interface ContractActionProps {
 configuration:ChainConfiguration
 operationKey:string
 label:string
 action:(client:RetempoClient,write:WriteTransaction)=>Promise<void>
 target:ProjectionTarget
 snapshot?:()=>Promise<ChainSnapshot>
 disabled?:boolean
 children?:ReactNode
 variant?:'primary'|'secondary'|'danger'
}
/** Reusable merchant/customer action. A receipt is not presented as business success. */
export function ContractAction({configuration,operationKey,label,action,target,snapshot,disabled=false,children,variant='secondary'}:ContractActionProps) {
 const tx=useRetempoTransactions(configuration,operationKey,snapshot)
 const submit=async()=>{await tx.execute((sdk,write,remember)=>{remember(target);return action(sdk,write)});await tx.sync(target)}
 return <div className="min-w-0 space-y-3">
  {children}
  <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2" variant={variant} loading={tx.busy} disabled={disabled||!configuration.configured||!canSubmit(tx.state.phase)} onClick={()=>void submit()}>{label}</Button>
  {(tx.state.phase!=='idle'||tx.error)&&<TransactionStatus state={tx.state} error={tx.error} busy={tx.busy} onSync={()=>void tx.sync(target)} onResume={()=>void tx.resume()} />}
 </div>
}
