import { useState } from 'react'
import { MailWarning } from 'lucide-react'
import { auth } from '@/services/auth'
import { errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { useAuth } from './AuthProvider'

/** Shown to password accounts whose email address is not verified yet. */
export function VerifyEmailBanner() {
  const { session } = useAuth()
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string>()
  const user = session?.user
  if (!user?.email || user.emailVerified) return null

  const resend = () => {
    setState('sending')
    setError(undefined)
    auth
      .resendVerification()
      .then(() => setState('sent'))
      .catch((err: unknown) => {
        setError(errorMessage(err))
        setState('idle')
      })
  }

  return (
    <div role="status" className="mb-6 flex flex-col gap-3 rounded-xl border border-caution/30 bg-caution/[0.07] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3 text-sm">
        <MailWarning className="mt-0.5 size-4 shrink-0 text-caution" />
        <p className="text-dim">
          <span className="font-medium text-caution">Verify your email.</span> {state === 'sent' ? 'A new link was sent.' : `We sent a link to ${user.email}.`}
          {error && <span className="text-negative"> {error}</span>}
        </p>
      </div>
      <Button size="sm" variant="secondary" loading={state === 'sending'} onClick={resend}>
        Resend email
      </Button>
    </div>
  )
}
