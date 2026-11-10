import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'
import { OrDivider, WalletEntry } from './WalletEntry'

export default function LoginPage() {
  const { logIn, session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

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
      <p className="eyebrow">Welcome back</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Log in to RETEMPO</h1>
      <p className="mt-2 text-sm text-dim">Manage plans, subscribers and USDC revenue.</p>

      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <TextField label="Password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm text-dim hover:text-fg">
            Forgot password?
          </Link>
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Log in
        </Button>
      </form>

      <OrDivider />
      <WalletEntry />

      <p className="mt-8 text-center text-sm text-dim">
        New to RETEMPO?{' '}
        <Link to="/signup" className="font-medium text-cyan hover:text-cyan-soft">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  )
}
