export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new HttpError(400, 'bad_request', message, fields)
export const validationFailed = (fields: Record<string, string>) =>
  new HttpError(422, 'validation_failed', 'Some fields are invalid', fields)
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message)
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`)
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message)
export const unavailable = (message: string, code = 'unavailable') => new HttpError(503, code, message)
export const tooManyRequests = (retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.', undefined, {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  })
