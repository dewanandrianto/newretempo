import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react'
import { auth } from '@/services/auth'
import { errorMessage } from '@/services/api/client'
import { Button, LinkButton } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { Skeleton } from '@/components/ui/States'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'

/** One-time tokens arrive in the URL fragment, so they never reach server logs or Referer headers. */
function useFragmentToken(): string {
  const [token] = useState(() => window.location.hash.replace(/^#/, ''))
  return token
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState<string>()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email address.')
    setError(undefined)
    setState('busy')
    auth
      .requestPasswordReset(email)
      .then(() => setState('sent'))
      .catch((err: unknown) => {
        setError(errorMessage(err))
        setState('idle')
      })
  }

  return (
    <AuthLayout>
      <p className="eyebrow">Account recovery</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Reset your password</h1>
      {state === 'sent' ? (
        <div className="mt-8 rounded-2xl border border-line-strong bg-raised p-6">
          <MailCheck className="size-6 text-cyan" />
          <p className="mt-3 font-medium text-fg">Check your email</p>
          <p className="mt-1 text-sm text-dim">If an account exists for {email}, a reset link is on its way. The link expires in one hour.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
          <p className="text-sm text-dim">Enter your email and we will send a one-time reset link.</p>
          <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={error} />
          <Button type="submit" size="lg" className="w-full" loading={state === 'busy'}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-8 text-center text-sm text-dim">
        <Link to="/login" className="font-medium text-cyan hover:text-cyan-soft">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  )
}

export function ResetPasswordPage() {
  const token = useFragmentToken()
  const [password, setPassword] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string>()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 10) return setError('Use at least 10 characters.')
    setError(undefined)
    setState('busy')
    auth
      .resetPassword(token, password)
      .then(() => setState('done'))
      .catch((err: unknown) => {
        setError(errorMessage(err))
        setState('idle')
      })
  }

  return (
    <AuthLayout>
      <p className="eyebrow">Account recovery</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Choose a new password</h1>
      {!token ? (
        <p className="mt-8 text-sm text-dim">This reset link is incomplete. Request a new one from the log in page.</p>
      ) : state === 'done' ? (
        <div className="mt-8 rounded-2xl border border-positive/30 bg-positive/[0.07] p-6">
          <CheckCircle2 className="size-6 text-positive" />
          <p className="mt-3 font-medium text-fg">Password updated</p>
          <p className="mt-1 text-sm text-dim">All sessions were signed out and wallet sign-in was disabled. Log in with your new password. To restore wallet sign-in, link your wallet again with a fresh signature. Your funds and payout addresses are unchanged.</p>
          <LinkButton to="/login" className="mt-5">
            Log in
          </LinkButton>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
          <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} hint="At least 10 characters." />
          <Button type="submit" size="lg" className="w-full" loading={state === 'busy'}>
            Update password
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

export function VerifyEmailPage() {
  const token = useFragmentToken()
  const { refresh } = useAuth()
  const [state, setState] = useState<'working' | 'ok' | 'failed'>(token ? 'working' : 'failed')
  const [message, setMessage] = useState('This verification link is incomplete.')
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true // tokens are single use; never submit twice (React StrictMode)
    auth
      .verifyEmail(token)
      .then(() => refresh())
      .then(() => setState('ok'))
      .catch((err: unknown) => {
        setMessage(errorMessage(err))
        setState('failed')
      })
  }, [token, refresh])

  return (
    <AuthLayout>
      <p className="eyebrow">Email verification</p>
      {state === 'working' && (
        <div className="mt-6 space-y-3" role="status">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-full" />
        </div>
      )}
      {state === 'ok' && (
        <div className="mt-4">
          <CheckCircle2 className="size-8 text-positive" />
          <h1 className="display mt-3 text-3xl font-semibold text-fg">Email verified</h1>
          <p className="mt-2 text-sm text-dim">Thanks. Your address is confirmed.</p>
          <LinkButton to="/app" className="mt-6">
            Continue
          </LinkButton>
        </div>
      )}
      {state === 'failed' && (
        <div className="mt-4">
          <XCircle className="size-8 text-negative" />
          <h1 className="display mt-3 text-3xl font-semibold text-fg">Link not valid</h1>
          <p className="mt-2 text-sm text-dim">{message} Log in and request a new verification email.</p>
          <LinkButton to="/login" variant="secondary" className="mt-6">
            Go to log in
          </LinkButton>
        </div>
      )}
    </AuthLayout>
  )
}
