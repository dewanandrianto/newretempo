import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  /** Pepper for session / API key hashing. 32+ chars, random, never committed. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** Comma separated browser origins allowed to call the API with cookies. */
  APP_ORIGINS: z.string().default(''),
  /** SIWE: the exact domain / URI / chain the server will accept. */
  SIWE_DOMAIN: z.string().default(''),
  SIWE_URI: z.string().default(''),
  SIWE_CHAIN_ID: z.coerce.number().int().positive().default(5042002),
  /** 'log' prints dev-only verification/reset links. Forced to 'disabled' in production. */
  EMAIL_MODE: z.enum(['log', 'disabled']).default('disabled'),
  REQUIRE_VERIFIED_EMAIL: bool.optional(),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  SESSION_IDLE_HOURS: z.coerce.number().int().positive().default(24),
})

export interface Config {
  env: 'development' | 'test' | 'production'
  isProduction: boolean
  databaseUrl: string
  sessionSecret: string
  port: number
  appOrigins: string[]
  siwe: { domain: string; uri: string; chainId: number }
  emailMode: 'log' | 'disabled'
  requireVerifiedEmail: boolean
  cookieSecure: boolean
  trustProxy: boolean
  sessionTtlMs: number
  sessionIdleMs: number
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigError(`Invalid server configuration (${issues})`)
  }
  const e = parsed.data
  const isProduction = e.NODE_ENV === 'production'
  const appOrigins = e.APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)

  if (isProduction) {
    if (!e.SIWE_DOMAIN || !e.SIWE_URI) throw new ConfigError('SIWE_DOMAIN and SIWE_URI are required in production')
    if (appOrigins.length === 0) throw new ConfigError('APP_ORIGINS is required in production')
    if (appOrigins.some((o) => !o.startsWith('https://'))) throw new ConfigError('APP_ORIGINS must be https in production')
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    port: e.API_PORT,
    appOrigins,
    siwe: { domain: e.SIWE_DOMAIN, uri: e.SIWE_URI, chainId: e.SIWE_CHAIN_ID },
    // Development email logging must never run in production.
    emailMode: isProduction ? 'disabled' : e.EMAIL_MODE,
    requireVerifiedEmail: e.REQUIRE_VERIFIED_EMAIL ?? isProduction,
    cookieSecure: e.COOKIE_SECURE ?? isProduction,
    trustProxy: e.TRUST_PROXY,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3_600_000,
  }
}
