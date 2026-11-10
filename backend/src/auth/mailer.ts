import type { Config } from '../config'
import { unavailable } from '../http/errors'

export interface OutgoingEmail {
  to: string
  kind: 'verify_email' | 'reset_password'
  subject: string
  /** One-time link containing the raw token. */
  link: string
}

export interface Mailer {
  /** False when no delivery channel exists. Callers must fail safely instead of pretending. */
  readonly configured: boolean
  send(email: OutgoingEmail): Promise<void>
}

/**
 * Development only: prints the one-time link to the server console.
 * Never logs passwords or session secrets. createMailer never returns this in production.
 */
export class DevLogMailer implements Mailer {
  readonly configured = true
  send(email: OutgoingEmail): Promise<void> {
    console.info(`[dev-email] ${email.kind} for ${email.to}: ${email.link}`)
    return Promise.resolve()
  }
}

/** No provider is wired up. Sending is refused so nothing silently disappears. */
export class UnconfiguredMailer implements Mailer {
  readonly configured = false
  send(): Promise<void> {
    return Promise.reject(unavailable('Email delivery is not configured on this server', 'email_not_configured'))
  }
}

export function createMailer(config: Config): Mailer {
  if (!config.isProduction && config.emailMode === 'log') return new DevLogMailer()
  // A production email provider adapter plugs in here once credentials exist.
  return new UnconfiguredMailer()
}
