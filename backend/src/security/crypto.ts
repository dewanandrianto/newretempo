import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** URL-safe random token with `bytes` of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** SIWE nonces must be alphanumeric and at least 8 characters (EIP-4361). */
export function randomNonce(length = 24): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Keyed hash for bearer secrets (session tokens, API keys, email tokens). */
export function hmacHex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
