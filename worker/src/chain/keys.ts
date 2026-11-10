import { encodeAbiParameters, keccak256, toHex } from 'viem'
import type { ChainAddress, ChainHash } from '../../../shared/chain'
export function serverReference(orgId: string, kind: string, id: string): ChainHash {
  return keccak256(toHex(JSON.stringify(['retempo:v1', orgId, kind, id])))
}
export function actorKey(actor: ChainAddress, reference: ChainHash): ChainHash {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [actor, reference]))
}
export function chargeKeys(subscriptionKey: ChainHash, chargeNumber: string, merchant: ChainAddress) {
  const invoiceRef = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [subscriptionKey, BigInt(chargeNumber)]))
  return { invoiceRef, escrowKey: actorKey(merchant, invoiceRef) }
}
