import type { z } from 'zod'
import type { Config } from '../config'
import type { Db } from '../db/client'
import type { Mailer } from '../auth/mailer'
import type { RateLimiter } from './rateLimit'

export interface Deps {
  config: Config
  db: Db
  mailer: Mailer
  limiter: RateLimiter
  now: () => Date
}

export type OrgRole = 'owner' | 'admin' | 'member'

export interface AuthContext {
  sessionId: string
  userId: string
  method: 'password' | 'siwe'
  user: { id: string; email: string | null; emailVerified: boolean; displayName: string }
}

export interface Ctx {
  req: Request
  url: URL
  params: Record<string, string>
  deps: Deps
  ip: string
  requestId: string
  /** Set-Cookie header values to attach to the response. */
  setCookies: string[]
  /** Resolved session, or null when the request is anonymous. */
  auth: AuthContext | null
  /** Parses and validates the JSON body. Throws a 422 HttpError on invalid input. */
  body<S extends z.ZodType>(schema: S): Promise<z.infer<S>>
  query<S extends z.ZodType>(schema: S): z.infer<S>
}

export type Handler = (ctx: Ctx) => Promise<unknown>

export class Reply {
  constructor(
    readonly status: number,
    readonly data?: unknown,
  ) {}
}
export const created = (data: unknown) => new Reply(201, data)
export const noContent = () => new Reply(204)
