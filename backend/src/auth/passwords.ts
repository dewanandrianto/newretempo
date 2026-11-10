import { validationFailed } from '../http/errors'

// OWASP-recommended Argon2id minimum: 19 MiB memory, 2 iterations, 1 lane.
const ARGON = { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 } as const

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON)
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

let dummyHash: Promise<string> | undefined

/** Burns the same CPU as a real check so unknown emails are not distinguishable by timing. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('retempo-timing-equalizer')
  await verifyPassword(password, await dummyHash)
}

const COMMON = new Set(['password123', '1234567890', 'qwertyuiop', 'passwordpassword', 'letmein1234', 'iloveyou123'])

export function assertPasswordPolicy(password: string, email?: string | null): void {
  const fields: Record<string, string> = {}
  if (password.length < 10) fields.password = 'Use at least 10 characters.'
  else if (password.length > 128) fields.password = 'Use at most 128 characters.'
  else if (COMMON.has(password.toLowerCase()) || (email && password.toLowerCase() === email.toLowerCase())) {
    fields.password = 'Choose a less guessable password.'
  }
  if (Object.keys(fields).length) throw validationFailed(fields)
}
