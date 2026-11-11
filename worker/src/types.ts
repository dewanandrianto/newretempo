import type { Hono } from 'hono'

export interface AuthContext {
  sessionId: string
  userId: string
  method: 'password' | 'siwe' | 'privy'
  user: { id: string; email: string | null; emailVerified: boolean; displayName: string }
}

export interface WorkerBindings {
  DB: D1Database
  ASSETS?: Fetcher
  CHAIN?: Fetcher
  APP_ENV: 'development' | 'test' | 'production'
  SESSION_SECRET: string
  APP_ORIGINS: string
  SIWE_DOMAIN: string
  SIWE_URI: string
  SIWE_CHAIN_ID: string
  EMAIL_MODE?: 'disabled' | 'test' | 'delivery'
  REQUIRE_VERIFIED_EMAIL?: string
  COOKIE_SECURE?: string
  SESSION_TTL_HOURS?: string
  SESSION_IDLE_HOURS?: string
  /** Only a real delivery adapter may enable production email. Never expose test tokens. */
  MAILER?: Fetcher
  /** Resend credential supplied only through Worker secret storage, never plaintext vars. */
  RESEND_API_KEY?: string
  /** Public Privy Testnet app ID. The app secret is a Worker secret and never exposed to the client. */
  PRIVY_APP_ID?: string
  PRIVY_APP_SECRET?: string
  /** Must remain false until the reviewed Testnet rollout is approved. Missing means disabled. */
  PRIVY_AUTH_ENABLED?: string
  /** Synthetic-key-only verifier for isolated tests; production config rejects this binding. */
  PRIVY_TEST_VERIFICATION_KEY?: string
}

export interface AuthRequest {
  env: WorkerBindings
  req: { header(name: string): string | undefined }
}

export interface WorkerVariables {
  auth: AuthContext | null
  requestId: string
  ip: string
}

export type WorkerContext = { Bindings: WorkerBindings; Variables: WorkerVariables }
export type WorkerApp = Hono<WorkerContext>
