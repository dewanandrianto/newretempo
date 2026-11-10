import { ZodError, type z } from 'zod'
import { resolveSession } from '../auth/sessions'
import type { Config } from '../config'
import { PG, pgCode } from '../db/client'
import { safeJsonStringify } from '@shared/money'
import { HttpError, badRequest, conflict, forbidden, validationFailed } from './errors'
import { Router } from './router'
import { Reply, type Ctx, type Deps } from './types'

const MAX_BODY_BYTES = 256 * 1024
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function originAllowed(origin: string, config: Config): boolean {
  if (config.appOrigins.includes(origin)) return true
  if (config.isProduction) return false
  try {
    const u = new URL(origin)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    // Arc Studio preview hosts (development only).
    return u.protocol === 'https:' && u.hostname.endsWith('.preview.studio.arc.io')
  } catch {
    return false
  }
}

/**
 * CSRF defence for cookie-authenticated requests, in layers:
 *  1. SameSite=Lax session cookie (cross-site POSTs do not carry it)
 *  2. state-changing requests must carry Origin, and it must be an allowed origin
 *  3. a custom request header that a cross-site form cannot set
 */
export function assertCsrf(req: Request, config: Config): void {
  const origin = req.headers.get('origin')
  if (!origin || !originAllowed(origin, config)) throw forbidden('Request origin is not allowed')
  if (req.headers.get('x-requested-with') !== 'retempo') throw forbidden('Missing required request header')
}

function clientIp(req: Request, config: Config, socketIp: string | undefined): string {
  if (config.trustProxy) {
    const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd.slice(0, 64)
  }
  return socketIp ?? 'unknown'
}

function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = issue.path.join('.') || 'body'
    fields[key] ??= issue.message
  }
  return fields
}

function toErrorResponse(err: unknown, requestId: string): Response {
  let status = 500
  let code = 'internal_error'
  let message = 'Something went wrong'
  let fields: Record<string, string> | undefined
  let headers: Record<string, string> | undefined

  if (err instanceof HttpError) {
    ;({ status, code, message, fields, headers } = err)
  } else if (err instanceof ZodError) {
    const e = validationFailed(zodFields(err))
    ;({ status, code, message, fields } = e)
  } else {
    const pg = pgCode(err)
    if (pg === PG.uniqueViolation) {
      const e = conflict('A record with these details already exists', 'duplicate')
      ;({ status, code, message } = e)
    } else if (pg === PG.foreignKeyViolation) {
      const e = conflict('This record is referenced by other records or points to something that does not exist', 'referential_conflict')
      ;({ status, code, message } = e)
    } else if (pg === PG.checkViolation) {
      status = 422
      code = 'constraint_violation'
      message = 'The request violates a data rule'
    } else if (pg === PG.insufficientPrivilege) {
      status = 403
      code = 'chain_controlled'
      message = 'This state is controlled by verified blockchain events and cannot be changed directly'
    } else {
      // Never leak internals. The request id lets an operator find the log line.
      console.error(`[api] ${requestId}`, err instanceof Error ? err.stack ?? err.message : err)
    }
  }
  const body = { error: { code, message, ...(fields ? { fields } : {}), requestId } }
  return new Response(safeJsonStringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers, 'X-Request-Id': requestId },
  })
}

export interface App {
  fetch(req: Request, socketIp?: string): Promise<Response>
  router: Router
}

export function createApp(deps: Deps, register: (router: Router) => void): App {
  const router = new Router()
  register(router)

  async function fetch(req: Request, socketIp?: string): Promise<Response> {
    const requestId = crypto.randomUUID()
    try {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/api/')) {
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
      }
      if (UNSAFE.has(req.method)) assertCsrf(req, deps.config)

      const matched = router.match(req.method, url.pathname)
      if (matched === null) throw new HttpError(404, 'not_found', 'Route not found')
      if (matched === 'method-not-allowed') throw new HttpError(405, 'method_not_allowed', 'Method not allowed')

      const ctx: Ctx = {
        req,
        url,
        params: matched.params,
        deps,
        ip: clientIp(req, deps.config, socketIp),
        requestId,
        setCookies: [],
        auth: null,
        body: async <S extends z.ZodType>(schema: S): Promise<z.infer<S>> => {
          const declared = Number(req.headers.get('content-length') ?? 0)
          if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large')
          const text = await req.text()
          if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large')
          let raw: unknown = {}
          if (text.trim()) {
            if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
              throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json')
            }
            try {
              raw = JSON.parse(text)
            } catch {
              throw badRequest('Request body is not valid JSON')
            }
          }
          return schema.parse(raw)
        },
        query: <S extends z.ZodType>(schema: S): z.infer<S> => schema.parse(Object.fromEntries(url.searchParams)),
      }
      ctx.auth = await resolveSession(ctx)

      const result = await matched.handler(ctx)
      const reply = result instanceof Reply ? result : new Reply(200, result)
      const headers = new Headers({ ...SECURITY_HEADERS, 'X-Request-Id': requestId })
      for (const c of ctx.setCookies) headers.append('Set-Cookie', c)
      if (reply.status === 204 || reply.data === undefined) return new Response(null, { status: reply.status === 200 ? 204 : reply.status, headers })
      headers.set('Content-Type', 'application/json; charset=utf-8')
      return new Response(safeJsonStringify(reply.data), { status: reply.status, headers })
    } catch (err) {
      return toErrorResponse(err, requestId)
    }
  }

  return { fetch, router }
}
