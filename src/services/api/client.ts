import type { ApiErrorBody } from '@shared/types'

/** Error thrown for any non-2xx API response. `fields` maps input names to messages. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface RequestOptions {
  body?: unknown
  /** Required by the server for payment, escrow and invoice creation so retries are safe. */
  idempotencyKey?: string
  /** Short-lived Privy access token, used only for this same-origin auth handoff request. */
  authorization?: string
  signal?: AbortSignal
}

export const newIdempotencyKey = () => crypto.randomUUID()

/**
 * Same-origin JSON client. RETEMPO sessions stay in HttpOnly cookies. A Privy access token may
 * be passed in memory for one login/link handoff request; it is not persisted. `X-Requested-With`
 * is the CSRF header the server requires on every state-changing request.
 */
export async function api<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'retempo' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options.authorization) headers.Authorization = options.authorization

  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.')
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`, err?.fields)
  }
  return json as T
}

export const get = <T>(path: string) => api<T>('GET', path)
export const post = <T>(path: string, body?: unknown, idempotencyKey?: string) => api<T>('POST', path, { body: body ?? {}, idempotencyKey })
export const postWithBearer = <T>(path: string, accessToken: string) => api<T>('POST', path, { authorization: `Bearer ${accessToken}` })
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, { body })
export const del = (path: string) => api<void>('DELETE', path)

/** A friendly message for UI: field errors win, then the server message. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiError) {
    if (err.fields) {
      const first = Object.values(err.fields)[0]
      if (first) return first
    }
    return err.message
  }
  return err instanceof Error && err.message ? err.message : fallback
}
