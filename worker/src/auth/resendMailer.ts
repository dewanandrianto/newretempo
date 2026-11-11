export interface ResendEmail {
  to: string
  kind: 'verify_email' | 'reset_password'
  subject: string
  link: string
}

const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails'
const FROM = 'RETEMPO <no-reply@auth.retempo.xyz>'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

export async function sendResendEmail(apiKey: string, message: ResendEmail, fetcher: typeof fetch = fetch): Promise<Response> {
  const title = message.kind === 'verify_email' ? 'Verify your RETEMPO email' : 'Reset your RETEMPO password'
  const action = message.kind === 'verify_email' ? 'Verify email' : 'Reset password'
  const text = `${title}\n\nOpen this one-time link to continue:\n${message.link}\n\nIf you did not request this, you can ignore this email.`
  const html = `<!doctype html><html><body><h1>${title}</h1><p>Use this one-time link to continue:</p><p><a href="${escapeHtml(message.link)}">${action}</a></p><p>If you did not request this, you can ignore this email.</p></body></html>`

  return fetcher(RESEND_EMAILS_ENDPOINT, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [message.to], subject: message.subject, html, text }),
  })
}
