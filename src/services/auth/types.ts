import type { LoginInput, OrganizationInput, Session, SignUpInput } from '@shared/types'

/**
 * Authentication boundary. The server owns sessions (HttpOnly cookie); the web app only
 * ever sees the resulting Session description.
 */
export interface AuthService {
  loadSession(): Promise<Session | null>
  signUp(input: SignUpInput): Promise<{ session: Session; verificationEmailSent: boolean }>
  logIn(input: LoginInput): Promise<Session>
  signOut(): Promise<void>
  /** Step 1 of Sign-In with Ethereum: the server returns the exact message to sign. */
  requestWalletChallenge(address: `0x${string}`): Promise<{ message: string }>
  /** Step 2: the server verifies signature, nonce, domain, URI, chain ID and timestamps. */
  verifyWalletSignature(input: { message: string; signature: `0x${string}` }): Promise<Session>
  createOrganization(input: OrganizationInput): Promise<Session>
  verifyEmail(token: string): Promise<void>
  resendVerification(): Promise<boolean>
  requestPasswordReset(email: string): Promise<void>
  resetPassword(token: string, password: string): Promise<void>
}
