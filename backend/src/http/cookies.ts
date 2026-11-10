import type { Config } from '../config'

/** `__Host-` prefix (Secure, Path=/, no Domain) is used whenever cookies are Secure. */
export function sessionCookieName(config: Config): string {
  return config.cookieSecure ? '__Host-retempo_session' : 'retempo_session'
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name && !(name in out)) out[name] = decodeURIComponent(value)
  }
  return out
}

/** HttpOnly keeps the token out of JavaScript; SameSite=Lax blocks cross-site POSTs. */
export function sessionCookie(config: Config, token: string, maxAgeSeconds: number): string {
  const attrs = [`${sessionCookieName(config)}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
  if (config.cookieSecure) attrs.push('Secure')
  return attrs.join('; ')
}

export function clearSessionCookie(config: Config): string {
  const attrs = [`${sessionCookieName(config)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']
  if (config.cookieSecure) attrs.push('Secure')
  return attrs.join('; ')
}
