const enc = new TextEncoder()
export function randomToken(bytes = 32): string { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), x => x.toString(16).padStart(2, '0')).join('') }
function hex(buffer: ArrayBuffer): string { return Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, '0')).join('') }
export async function hmac(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(token)))
}
export async function sha256(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))) }
