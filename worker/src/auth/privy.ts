import { createRemoteJWKSet, errors as joseErrors, importSPKI, jwtVerify, type RemoteJWKSet } from 'jose'
import { unauthorized, unavailable } from '../errors'
import type { WorkerBindings } from '../types'

const PRIVY_JWKS_API = 'https://auth.privy.io/api'
const jwksByEnv = new WeakMap<WorkerBindings, RemoteJWKSet>()

export interface VerifiedPrivyIdentity {
  privyUserId: string
}

export function isPrivyAuthEnabled(env: WorkerBindings): boolean {
  return env.PRIVY_AUTH_ENABLED === 'true' && Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET)
}

function remoteJwks(env: WorkerBindings): RemoteJWKSet {
  const cached = jwksByEnv.get(env)
  if (cached) return cached
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw unavailable('Privy authentication is not configured', 'privy_not_configured')
  }
  const authorization = `Basic ${btoa(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`)}`
  const jwks = createRemoteJWKSet(new URL(`${PRIVY_JWKS_API}/v1/apps/${encodeURIComponent(env.PRIVY_APP_ID)}/jwks.json`), {
    headers: { authorization, 'privy-app-id': env.PRIVY_APP_ID, accept: 'application/json' },
    timeoutDuration: 5000,
    cacheMaxAge: 60 * 60 * 1000,
    cooldownDuration: 10 * 60 * 1000,
  })
  jwksByEnv.set(env, jwks)
  return jwks
}

function isInvalidToken(error: unknown): boolean {
  return error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey
}

export async function verifyPrivyAccessToken(env: WorkerBindings, accessToken: string): Promise<VerifiedPrivyIdentity> {
  if (!isPrivyAuthEnabled(env) || !env.PRIVY_APP_ID) {
    throw unavailable('Privy authentication is not configured', 'privy_not_configured')
  }
  if (accessToken.length < 32 || accessToken.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw unauthorized('Privy sign-in failed')
  }

  let verificationKey: CryptoKey | RemoteJWKSet
  if (env.APP_ENV === 'test') {
    if (!env.PRIVY_TEST_VERIFICATION_KEY) {
      throw unavailable('Privy test verification key is not configured', 'privy_not_configured')
    }
    try {
      verificationKey = await importSPKI(env.PRIVY_TEST_VERIFICATION_KEY, 'ES256')
    } catch {
      throw unavailable('Privy test verification key is invalid', 'privy_not_configured')
    }
  } else {
    verificationKey = remoteJwks(env)
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  let protectedHeader: Awaited<ReturnType<typeof jwtVerify>>['protectedHeader']
  try {
    ({ payload, protectedHeader } = await jwtVerify(accessToken, verificationKey, {
      algorithms: ['ES256'],
      issuer: 'privy.io',
      audience: env.PRIVY_APP_ID,
      typ: 'JWT',
      requiredClaims: ['exp', 'iat', 'sub', 'sid'],
      clockTolerance: 5,
    }))
  } catch (error) {
    if (isInvalidToken(error)) throw unauthorized('Privy sign-in failed')
    // Provider/network/key-fetch failures are not treated as valid identities and are not logged.
    throw unavailable('Privy authentication is temporarily unavailable', 'privy_unavailable')
  }

  const now = Math.floor(Date.now() / 1000)
  const audienceMatches = payload.aud === env.PRIVY_APP_ID ||
    (Array.isArray(payload.aud) && payload.aud.includes(env.PRIVY_APP_ID))
  if (protectedHeader.alg !== 'ES256' || protectedHeader.typ !== 'JWT' ||
      payload.iss !== 'privy.io' || !audienceMatches ||
      typeof payload.exp !== 'number' || typeof payload.iat !== 'number' ||
      payload.exp <= payload.iat || payload.iat > now + 5 ||
      typeof payload.sid !== 'string' || payload.sid.length < 1 || payload.sid.length > 255 ||
      typeof payload.sub !== 'string' || !/^did:privy:.{1,245}$/.test(payload.sub)) {
    throw unauthorized('Privy sign-in failed')
  }

  return { privyUserId: payload.sub }
}
