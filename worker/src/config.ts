import { unavailable } from './errors'
import type { WorkerBindings } from './types'

function unsafe(): never { throw unavailable('Server configuration is incomplete or unsafe', 'configuration_error') }
function productionUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { return unsafe() }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) unsafe()
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.invalid') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) unsafe()
  return url
}
function boundedHours(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!/^(?:[1-9]\d*)(?:\.\d+)?$/.test(value)) return unsafe()
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours > max) return unsafe()
  return hours
}

/** Public API runtime guard. Local test/development settings are not production credentials. */
export function validateBindings(env: WorkerBindings): void {
  if (!['development', 'test', 'production'].includes(env.APP_ENV)) unsafe()
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) unsafe()
  if (!env.SIWE_DOMAIN || !env.SIWE_URI || !/^\d+$/.test(env.SIWE_CHAIN_ID) || !Number.isSafeInteger(Number(env.SIWE_CHAIN_ID)) || Number(env.SIWE_CHAIN_ID) <= 0) unsafe()
  if (env.APP_ENV !== 'production') return
  // Generate 32 random bytes encoded as lowercase hex; shape checks do not certify entropy.
  if (!/^[0-9a-f]{64}$/.test(env.SESSION_SECRET) || new Set(env.SESSION_SECRET).size < 8 || /^(.{1,32})\1+$/.test(env.SESSION_SECRET)) unsafe()
  const origins = (env.APP_ORIGINS || '').split(',').map(value => value.trim())
  if (!origins.length || origins.some(value => !value || productionUrl(value).origin !== value)) unsafe()
  const siwe = productionUrl(env.SIWE_URI)
  if (siwe.host !== env.SIWE_DOMAIN || !origins.includes(siwe.origin) || env.SIWE_CHAIN_ID !== '5042002') unsafe()
  if (env.COOKIE_SECURE !== undefined && env.COOKIE_SECURE !== 'true') unsafe()
  if (env.REQUIRE_VERIFIED_EMAIL !== undefined && env.REQUIRE_VERIFIED_EMAIL !== 'true') unsafe()
  if (env.EMAIL_MODE !== 'disabled' && env.EMAIL_MODE !== 'delivery') unsafe()
  if (env.EMAIL_MODE === 'delivery' && !env.MAILER) unsafe()
  const ttl = boundedHours(env.SESSION_TTL_HOURS, 168, 168)
  if (boundedHours(env.SESSION_IDLE_HOURS, 24, 24) > ttl) unsafe()
}
