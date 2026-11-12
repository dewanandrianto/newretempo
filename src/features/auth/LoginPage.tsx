import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'
import { OrDivider, WalletEntry } from './WalletEntry'
import { PrivyAuthButtonLazy } from './PrivyAuthButtonLazy'

export default function LoginPage() {
  const { logIn, session, privyEnabled } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [showLegacy, setShowLegacy] = useState(false)

  if (session) return <Navigate to={session.organization ? '/app' : '/onboarding'} replace />

  const from = (location.state as { from?: string } | null)?.from

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!/^\S+@\S+\.\S+$/.test(form.email) || !form.password) {
      setError('Enter your email and password.')
      return
    }
    setError(undefined)
    setBusy(true)
    logIn(form)
      .then((s) => navigate(s.organization ? (from ?? '/app') : '/onboarding'))
      .catch((err: unknown) => setError(errorMessage(err, 'Could not log in. Try again.')))
      .finally(() => setBusy(false))
  }

  return (
    <AuthLayout>
      <p className="eyebrow">Welcome</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg sm:text-4xl">Sign in to RETEMPO</h1>
      <p className="mt-3 text-sm leading-relaxed text-dim">Sign in to continue. Your RETEMPO account is set up automatically the first time you sign in.</p>

      {privyEnabled && (
        <div className="mt-7 space-y-3 sm:mt-8">
          <PrivyAuthButtonLazy mode="login" redirectTo={from} />
          <p className="text-center text-xs leading-relaxed text-dim">Choose the sign-in method that works for you in the next step.</p>
          {!showLegacy && (
            <Button type="button" variant="ghost" className="mt-2 w-full" aria-expanded={false} onClick={() => setShowLegacy(true)}>
              Existing account recovery options
            </Button>
          )}
        </div>
      )}

      {(!privyEnabled || showLegacy) && (
        <div className="mt-5 rounded-2xl border border-line bg-panel/50 p-4 sm:mt-6 sm:p-5">
          {privyEnabled && (
            <Button type="button" variant="ghost" className="mb-1 w-full" aria-expanded={true} onClick={() => setShowLegacy(false)}>
              Back to RETEMPO sign-in
            </Button>
          )}
          <OrDivider />
          <form onSubmit={submit} className="space-y-4" noValidate>
            <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <TextField label="Password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <div className="flex justify-end">
              <Link to="/forgot-password" className="text-sm text-dim hover:text-fg">Forgot password?</Link>
            </div>
            {error && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Log in with password</Button>
          </form>
          {!privyEnabled && (
            <>
              <OrDivider />
              <WalletEntry privyEnabled={false} />
            </>
          )}
        </div>
      )}

    </AuthLayout>
  )
}
