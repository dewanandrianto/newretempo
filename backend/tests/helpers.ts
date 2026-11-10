import { loadConfig, type Config } from '../src/config'
import { createDb, type Db } from '../src/db/client'
import { migrate, resetTestDatabase } from '../src/db/migrate'
import { buildApp } from '../src/app'
import type { App } from '../src/http/app'
import type { Mailer, OutgoingEmail } from '../src/auth/mailer'
import { RateLimiter } from '../src/http/rateLimit'

export const ORIGIN = 'https://app.test'
export const TEST_PASSWORD = 'correct horse battery staple'

export class CaptureMailer implements Mailer {
  configured = true
  sent: OutgoingEmail[] = []
  send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email)
    return Promise.resolve()
  }
  /** The raw one-time token from the most recent email of a kind sent to `to`. */
  tokenFor(to: string, kind: OutgoingEmail['kind']): string {
    const mail = [...this.sent].reverse().find((m) => m.to === to && m.kind === kind)
    if (!mail) throw new Error(`no ${kind} email for ${to}`)
    return mail.link.split('#')[1]
  }
}

export interface TestEnv {
  db: Db
  app: App
  config: Config
  mailer: CaptureMailer
  now: { value: Date }
  client(ip?: string): TestClient
  close(): Promise<void>
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Start Postgres (bun run db:up) and check .env')
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123456',
    APP_ORIGINS: ORIGIN,
    SIWE_DOMAIN: 'app.test',
    SIWE_URI: ORIGIN,
    SIWE_CHAIN_ID: '5042002',
    EMAIL_MODE: 'log',
    REQUIRE_VERIFIED_EMAIL: 'false',
    COOKIE_SECURE: 'false',
    ...overrides,
  })
}

export async function createTestEnv(overrides: Record<string, string> = {}, reset = true): Promise<TestEnv> {
  const config = testConfig(overrides)
  const db = createDb(config.databaseUrl)
  if (reset) await resetTestDatabase(db, config.databaseUrl)
  await migrate(db)
  const mailer = new CaptureMailer()
  const now = { value: new Date() }
  const app = buildApp({ config, db, mailer, limiter: new RateLimiter(), now: () => new Date(now.value) })
  let ipCounter = 1
  return {
    db,
    app,
    config,
    mailer,
    now,
    client: (ip) => new TestClient(app, ip ?? `10.1.0.${ipCounter++}`),
    close: () => db.close(),
  }
}

export interface Result<T> {
  status: number
  body: T
  headers: Headers
}

type Json = Record<string, unknown>

/** Minimal browser stand-in: keeps a cookie jar and sends the headers the SPA sends. */
export class TestClient {
  cookies = new Map<string, string>()
  constructor(
    private readonly app: App,
    readonly ip: string,
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async call<T = Json>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      'X-Requested-With': 'retempo',
      ...extraHeaders,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const cookie = this.cookieHeader()
    if (cookie) headers.Cookie = cookie
    const res = await this.app.fetch(
      new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      this.ip,
    )
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';')
      const idx = pair.indexOf('=')
      const name = pair.slice(0, idx)
      const value = pair.slice(idx + 1)
      if (/Max-Age=0/i.test(set) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers }
  }

  get = <T = Json>(path: string) => this.call<T>('GET', path)
  post = <T = Json>(path: string, body?: unknown, headers?: Record<string, string>) => this.call<T>('POST', path, body ?? {}, headers)
  patch = <T = Json>(path: string, body: unknown) => this.call<T>('PATCH', path, body)
  del = <T = Json>(path: string) => this.call<T>('DELETE', path)
}

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}${counter}-${Date.now().toString(36)}@example.test`
}

/** Registers a user and returns a logged-in client. */
export async function registerClient(env: TestEnv, name = 'Test User'): Promise<{ client: TestClient; email: string; userId: string }> {
  const client = env.client()
  const email = uniqueEmail()
  const res = await client.post<{ user: { id: string } }>('/api/auth/register', { email, password: TEST_PASSWORD, name })
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { client, email, userId: res.body.user.id }
}
