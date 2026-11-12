import { Hono, type Context } from 'hono'
import { ZodError, type z } from 'zod'
import { HttpError, badRequest, forbidden } from './errors'
import { validateBindings } from './config'
import type { AuthContext, AuthRequest, WorkerApp, WorkerBindings, WorkerContext } from './types'

const MAX_BODY_BYTES = 256 * 1024
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function originAllowed(origin: string, env: WorkerBindings): boolean {
  if ((env.APP_ORIGINS || '').split(',').map((value) => value.trim()).includes(origin)) return true
  if (env.APP_ENV === 'production') return false
  try {
    const url = new URL(origin)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch { return false }
}

export async function readBody<S extends z.ZodType>(c: Context<WorkerContext>, schema: S): Promise<z.infer<S>> {
  const declared = Number(c.req.header('Content-Length') || 0)
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large')
  const reader = c.req.raw.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (reader) {
    for (;;) {
      const result: ReadableStreamReadResult<unknown> = await reader.read()
      if (result.done) break
      const value = result.value
      if (!(value instanceof Uint8Array)) throw badRequest('Request body must contain bytes')
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new HttpError(413, 'payload_too_large', 'Request body is too large')
      }
      chunks.push(value)
    }
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
  const text = new TextDecoder().decode(buffer)
  let value: unknown = {}
  if (text.trim()) {
    if ((c.req.header('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json')
    }
    try { value = JSON.parse(text) } catch { throw badRequest('Request body is not valid JSON') }
  }
  return schema.parse(value)
}

function errorResponse(error: unknown, requestId: string): Response {
  let failure: HttpError
  if (error instanceof HttpError) failure = error
  else if (error instanceof ZodError) {
    const fields: Record<string, string> = {}
    for (const issue of error.issues) fields[issue.path.join('.') || 'body'] ??= issue.message
    failure = new HttpError(422, 'validation_failed', 'Some fields are invalid', fields)
  } else {
    const message = error instanceof Error ? error.message : ''
    if (/chain_controlled|authoritative|append.only|immutable.audit/i.test(message)) {
      failure = new HttpError(403, 'chain_controlled', 'Financial state requires verified blockchain events')
    } else if (/UNIQUE constraint failed|last_owner/i.test(message)) {
      failure = new HttpError(409, 'conflict', 'This change conflicts with an existing record')
    } else if (/FOREIGN KEY constraint failed/i.test(message)) {
      failure = new HttpError(409, 'referential_conflict', 'A referenced record is missing or belongs to another organization')
    } else if (/CHECK constraint failed|NOT NULL constraint failed/i.test(message)) {
      failure = new HttpError(422, 'constraint_violation', 'The request violates a data rule')
    } else {
      // Never log SQL, bound parameters, bearer tokens, or underlying provider errors.
      console.error(JSON.stringify({ requestId, kind: 'internal_error' }))
      failure = new HttpError(500, 'internal_error', 'Something went wrong')
    }
  }
  return new Response(JSON.stringify({ error: {
    code: failure.code, message: failure.message, ...(failure.fields ? { fields: failure.fields } : {}), requestId,
  } }), { status: failure.status, headers: {
    ...SECURITY_HEADERS, ...failure.headers, 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': requestId,
  } })
}

export function createHttpApp(options: { resolveAuth: (c: AuthRequest) => Promise<AuthContext | null> | AuthContext | null }): WorkerApp {
  const app = new Hono<WorkerContext>({ strict: false })
  app.use('/api/*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    // Cloudflare overwrites this header on its edge; local clients share a bounded local bucket.
    c.set('ip', c.req.header('CF-Connecting-IP')?.slice(0, 64) || 'local')
    validateBindings(c.env)
    if (UNSAFE.has(c.req.method) && (!originAllowed(c.req.header('Origin') || '', c.env) || c.req.header('X-Requested-With') !== 'retempo')) {
      if (c.req.method === 'POST' && c.req.path === '/api/auth/privy/login') {
        throw new HttpError(403, 'privy_request_gate', 'Request origin or CSRF header is not allowed')
      }
      throw forbidden('Request origin or CSRF header is not allowed')
    }
    c.set('auth', await options.resolveAuth({ env: c.env, req: { header: (name) => c.req.header(name) } }))
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
    if (c.env.APP_ENV === 'production') c.header('Strict-Transport-Security', 'max-age=31536000')
    c.header('X-Request-Id', requestId)
  })
  app.onError((error, c) => {
    const response = errorResponse(error, c.get('requestId') || crypto.randomUUID())
    if (c.env.APP_ENV === 'production') response.headers.set('Strict-Transport-Security', 'max-age=31536000')
    return response
  })
  app.notFound((c) => {
    const pathExists = app.routes.some((route) => {
      if (route.method === 'ALL') return false
      const pattern = route.path.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
      return new RegExp(`^${pattern}/?$`).test(c.req.path)
    })
    const error = pathExists
      ? new HttpError(405, 'method_not_allowed', 'Method not allowed')
      : new HttpError(404, 'not_found', 'Route not found')
    return errorResponse(error, c.get('requestId') || crypto.randomUUID())
  })
  return app
}
