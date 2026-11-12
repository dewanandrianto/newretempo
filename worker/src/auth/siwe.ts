import type { Context } from 'hono'
import type { WorkerContext } from '../types'
import { getAddress, isAddress, recoverMessageAddress } from 'viem'
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import { badRequest, unauthorized } from '../errors'
import { randomToken, sha256 } from './crypto'
export type SiwePurpose = 'login' | 'link'
export const NONCE_TTL_MS = 5 * 60000
export const SIWE_DEFAULT_STATEMENT = 'Sign in to RETEMPO. This request does not trigger a blockchain transaction or cost any gas.'
export interface VerifiedWallet { address: `0x${string}`; userId: string | null }
export function normalizeAddress(address: string): `0x${string}` {
  if (!isAddress(address, {strict:false})) throw badRequest('Invalid wallet address')
  return address.toLowerCase() as `0x${string}`
}
export async function issueChallenge(c:Context<WorkerContext>, input:{address:string;purpose:SiwePurpose;userId?:string;statement?:string}) {
  if (!c.env.SIWE_DOMAIN || !c.env.SIWE_URI || !Number.isSafeInteger(Number(c.env.SIWE_CHAIN_ID)) || Number(c.env.SIWE_CHAIN_ID)<1) throw badRequest('Wallet sign-in is not configured on this server')
  const address=normalizeAddress(input.address), nonce=randomToken(24), now=new Date(), expiresAt=new Date(now.getTime()+NONCE_TTL_MS).toISOString()
  const statement=input.statement??SIWE_DEFAULT_STATEMENT
  if (statement.length>500 || /[\r\n]/.test(statement)) throw badRequest('Wallet sign-in statement is invalid')
  const message=createSiweMessage({address:getAddress(address),chainId:Number(c.env.SIWE_CHAIN_ID),domain:c.env.SIWE_DOMAIN,uri:c.env.SIWE_URI,version:'1',statement,nonce,issuedAt:now,expirationTime:new Date(expiresAt)})
  await c.env.DB.prepare('INSERT INTO siwe_nonces (id,nonce,purpose,address,user_id,message_hash,expires_at) VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(),nonce,input.purpose,address,input.userId??null,await sha256(message),expiresAt).run()
  return {message,nonce,expiresAt}
}
export function checkSiweMessage(c:Context<WorkerContext>, message:string, now=new Date(), expectedStatement?:string) {
  const parsed=parseSiweMessage(message)
  const {address,nonce,domain,uri,chainId,version,issuedAt,expirationTime}=parsed
  if (!address||!nonce||!domain||!uri||!chainId||!issuedAt||!expirationTime||version!=='1') throw unauthorized('Malformed sign-in message')
  if (expectedStatement!==undefined && parsed.statement!==expectedStatement) throw unauthorized('Sign-in message has the wrong purpose')
  if (domain!==c.env.SIWE_DOMAIN) throw unauthorized('Sign-in message has the wrong domain')
  if (uri!==c.env.SIWE_URI) throw unauthorized('Sign-in message has the wrong URI')
  if (chainId!==Number(c.env.SIWE_CHAIN_ID)) throw unauthorized('Sign-in message has the wrong chain ID')
  if (issuedAt.getTime()>now.getTime()+60000) throw unauthorized('Sign-in message is issued in the future')
  if (now.getTime()-issuedAt.getTime()>10*60000) throw unauthorized('Sign-in message is too old')
  if (expirationTime.getTime()-issuedAt.getTime()>15*60000) throw unauthorized('Sign-in message validity is too long')
  if (!validateSiweMessage({message:parsed,domain:c.env.SIWE_DOMAIN,nonce,time:now})) throw unauthorized('Sign-in message is expired or invalid')
  return {address:normalizeAddress(address),nonce}
}
export async function verifyChallenge(c:Context<WorkerContext>, input:{message:string;signature:string;purpose:SiwePurpose;userId?:string;statement?:string}):Promise<VerifiedWallet> {
  if (input.message.length>2000) throw unauthorized('Sign-in message is too long')
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw unauthorized('Only standard wallet (EOA) signatures are supported. Contract-wallet (EIP-1271) sign-in is not available yet.')
  const {address,nonce}=checkSiweMessage(c,input.message,new Date(),input.statement??SIWE_DEFAULT_STATEMENT)
  let recovered:string
  try { recovered=await recoverMessageAddress({message:input.message,signature:input.signature as `0x${string}`}) } catch { throw unauthorized('Invalid signature') }
  if (recovered.toLowerCase()!==address) throw unauthorized('Signature does not match the wallet address')
  const now=new Date().toISOString()
  const row=await c.env.DB.prepare(`UPDATE siwe_nonces SET used_at=? WHERE nonce=? AND used_at IS NULL AND expires_at>? AND purpose=? AND address=? AND message_hash=? AND (purpose='login' OR user_id=?) RETURNING user_id`).bind(now,nonce,now,input.purpose,address,await sha256(input.message),input.userId??null).first<{user_id:string|null}>()
  if (!row) throw unauthorized('Sign-in challenge is invalid, expired, or already used')
  return {address,userId:row.user_id}
}
