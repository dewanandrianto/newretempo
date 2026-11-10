import { getAddress, isAddress, recoverMessageAddress } from 'viem'
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import type { Db } from '../db/client'
import type { Config } from '../config'
import { badRequest, unauthorized } from '../http/errors'
import { randomNonce, sha256Hex } from '../security/crypto'

/**
 * Sign-In with Ethereum (EIP-4361) with server-issued challenges.
 *
 * Verification is EOA only: the signature is recovered with ECDSA (ecrecover) and must
 * match the address in the message. EIP-1271 contract-wallet verification is NOT supported
 * in Phase 2; such signatures (not 65 bytes) are rejected with a clear error.
 */

export const NONCE_TTL_MS = 5 * 60_000
const MAX_CLOCK_SKEW_MS = 60_000
const MAX_MESSAGE_AGE_MS = 10 * 60_000
const MAX_VALIDITY_MS = 15 * 60_000
const STATEMENT = 'Sign in to RETEMPO. This request does not trigger a blockchain transaction or cost any gas.'

export type SiwePurpose = 'login' | 'link'

export interface Challenge {
  message: string
  nonce: string
  expiresAt: string
}

export function normalizeAddress(address: string): `0x${string}` {
  if (!isAddress(address, { strict: false })) throw badRequest('Invalid wallet address')
  return address.toLowerCase() as `0x${string}`
}

export async function issueChallenge(
  db: Db,
  config: Config,
  now: Date,
  input: { address: string; purpose: SiwePurpose; userId?: string },
): Promise<Challenge> {
  if (!config.siwe.domain || !config.siwe.uri) throw badRequest('Wallet sign-in is not configured on this server')
  const address = normalizeAddress(input.address)
  const nonce = randomNonce(24)
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS)
  const message = createSiweMessage({
    address: getAddress(address),
    chainId: config.siwe.chainId,
    domain: config.siwe.domain,
    uri: config.siwe.uri,
    version: '1',
    statement: STATEMENT,
    nonce,
    issuedAt: now,
    expirationTime: expiresAt,
  })
  await db`
    INSERT INTO siwe_nonces (nonce, purpose, address, user_id, message_hash, expires_at)
    VALUES (${nonce}, ${input.purpose}, ${address}, ${input.userId ?? null}, ${sha256Hex(message)}, ${expiresAt.toISOString()})`
  return { message, nonce, expiresAt: expiresAt.toISOString() }
}

export interface VerifiedWallet {
  address: `0x${string}`
  userId: string | null
}

/** Pure message checks: everything that can be decided without the database. */
export function checkSiweMessage(
  message: string,
  config: Config,
  now: Date,
): { address: `0x${string}`; nonce: string } {
  const parsed = parseSiweMessage(message)
  const { address, nonce, domain, uri, chainId, version, issuedAt, expirationTime } = parsed
  if (!address || !nonce || !domain || !uri || !chainId || !issuedAt || !expirationTime || version !== '1') {
    throw unauthorized('Malformed sign-in message')
  }
  if (domain !== config.siwe.domain) throw unauthorized('Sign-in message has the wrong domain')
  if (uri !== config.siwe.uri) throw unauthorized('Sign-in message has the wrong URI')
  if (chainId !== config.siwe.chainId) throw unauthorized('Sign-in message has the wrong chain ID')

  const t = now.getTime()
  if (issuedAt.getTime() > t + MAX_CLOCK_SKEW_MS) throw unauthorized('Sign-in message is issued in the future')
  if (t - issuedAt.getTime() > MAX_MESSAGE_AGE_MS) throw unauthorized('Sign-in message is too old')
  if (expirationTime.getTime() - issuedAt.getTime() > MAX_VALIDITY_MS) throw unauthorized('Sign-in message validity is too long')
  if (!validateSiweMessage({ message: parsed as Parameters<typeof validateSiweMessage>[0]['message'], domain: config.siwe.domain, nonce, time: now })) {
    throw unauthorized('Sign-in message is expired or invalid')
  }
  return { address: normalizeAddress(address), nonce }
}

export async function verifyChallenge(
  db: Db,
  config: Config,
  now: Date,
  input: { message: string; signature: string; purpose: SiwePurpose },
): Promise<VerifiedWallet> {
  if (input.message.length > 2000) throw unauthorized('Sign-in message is too long')
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
    throw unauthorized('Only standard wallet (EOA) signatures are supported. Contract-wallet (EIP-1271) sign-in is not available yet.')
  }
  const { address, nonce } = checkSiweMessage(input.message, config, now)

  let recovered: string
  try {
    recovered = await recoverMessageAddress({ message: input.message, signature: input.signature as `0x${string}` })
  } catch {
    throw unauthorized('Invalid signature')
  }
  if (recovered.toLowerCase() !== address) throw unauthorized('Signature does not match the wallet address')

  // Single use: the nonce is consumed atomically, only for the exact message and address
  // the server issued. A replayed (message, signature) pair finds no unused row.
  const rows = (await db`
    UPDATE siwe_nonces SET used_at = now()
    WHERE nonce = ${nonce} AND used_at IS NULL AND expires_at > now()
      AND purpose = ${input.purpose} AND address = ${address} AND message_hash = ${sha256Hex(input.message)}
    RETURNING user_id`) as { user_id: string | null }[]
  const row = rows[0]
  if (!row) throw unauthorized('Sign-in challenge is invalid, expired, or already used')
  return { address, userId: row.user_id }
}
