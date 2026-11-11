import { describe, expect, it } from 'vitest'
import { sendResendEmail } from '../src/auth/resendMailer'

describe('Resend email adapter', () => {
  it('posts a verification email to the fixed endpoint with a Bearer secret', async () => {
    const apiKey = 're_test_fixture_not_a_real_credential'
    let outbound: Request | undefined
    const fetcher: typeof fetch = (input, init) => {
      outbound = new Request(input, init)
      return Promise.resolve(new Response('{"id":"test-email-id"}', { status: 201 }))
    }

    const response = await sendResendEmail(apiKey, {
      to: 'person@example.test',
      kind: 'verify_email',
      subject: 'Verify your RETEMPO email',
      link: 'https://app.test/verify-email#one-time-token',
    }, fetcher)

    expect(response.status).toBe(201)
    expect(outbound?.url).toBe('https://api.resend.com/emails')
    expect(outbound?.method).toBe('POST')
    expect(outbound?.redirect).toBe('manual')
    expect(outbound?.headers.get('authorization')).toBe(`Bearer ${apiKey}`)
    const payload = await outbound!.json() as { from: string; to: string[]; subject: string; text: string; html: string }
    expect(payload.from).toBe('RETEMPO <no-reply@auth.retempo.xyz>')
    expect(payload.to).toEqual(['person@example.test'])
    expect(payload.subject).toBe('Verify your RETEMPO email')
    expect(payload.text).toContain('https://app.test/verify-email#one-time-token')
    expect(payload.html).toContain('href="https://app.test/verify-email#one-time-token"')
  })

  it('escapes HTML link content and leaves provider error bodies unread', async () => {
    const apiKey = 're_test_fixture_not_a_real_credential'
    let outbound: Request | undefined
    const fetcher: typeof fetch = (input, init) => {
      outbound = new Request(input, init)
      return Promise.resolve(new Response('provider response must not be logged or inspected', { status: 429 }))
    }

    const response = await sendResendEmail(apiKey, {
      to: 'person@example.test',
      kind: 'reset_password',
      subject: 'Reset your RETEMPO password',
      link: 'https://app.test/reset-password#token&<unsafe>',
    }, fetcher)

    expect(response.ok).toBe(false)
    expect(response.status).toBe(429)
    expect(response.bodyUsed).toBe(false)
    const payload = await outbound!.json() as { html: string; text: string }
    expect(payload.html).toContain('href="https://app.test/reset-password#token&amp;&lt;unsafe&gt;"')
    expect(payload.text).toContain('https://app.test/reset-password#token&<unsafe>')
  })
})
