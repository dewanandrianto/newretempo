/** Internal, request-local authentication evidence. Never serialize or log it.
 * The salted hash is the credential revision observed during authentication,
 * not a fresh lookup at session issuance. Null is valid only for wallet-only users.
 */
export type PasswordSessionProof = Readonly<{ method: 'password'; userId: string; passwordHash: string }>
export type SiweSessionProof = Readonly<{ method: 'siwe'; userId: string; passwordHash: string | null; address: `0x${string}` }>
export type PrivySessionProof = Readonly<{ method: 'privy'; userId: string; privyUserId: string }>
export type SessionProof = PasswordSessionProof | SiweSessionProof | PrivySessionProof
