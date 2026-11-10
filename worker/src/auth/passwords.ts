import { validationFailed } from '../errors'

export const PASSWORD_ITERATIONS = 600_000
const enc = new TextEncoder()
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes), b => b.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16))
async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  // Never reduce this work factor to accommodate a runtime or CPU quota.
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, key, 256))
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${await derive(password, salt)}`
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = /^pbkdf2-sha256\$600000\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(hash)
  // Imported Bun Argon2 hashes require a password reset; burn equal work on unsupported hashes.
  const actual = await derive(password, match ? unhex(match[1]) : new Uint8Array(16))
  const expected = match?.[2] ?? '0'.repeat(64)
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return !!match && difference === 0
}
export async function verifyAgainstDummy(password: string): Promise<void> { await verifyPassword(password, '') }
const COMMON = new Set(['password123', '1234567890', 'qwertyuiop', 'passwordpassword', 'letmein1234', 'iloveyou123'])
export function assertPasswordPolicy(password: string, email?: string | null): void {
  const fields: Record<string, string> = {}
  if (password.length < 10) fields.password = 'Use at least 10 characters.'
  else if (password.length > 128) fields.password = 'Use at most 128 characters.'
  else if (COMMON.has(password.toLowerCase()) || (email && password.toLowerCase() === email.toLowerCase())) fields.password = 'Choose a less guessable password.'
  if (Object.keys(fields).length) throw validationFailed(fields)
}
