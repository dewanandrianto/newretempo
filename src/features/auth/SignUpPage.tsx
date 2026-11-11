import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError, errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'
import { OrDivider, WalletEntry } from './WalletEntry'
import { PrivyAuthButtonLazy } from './PrivyAuthButtonLazy'

type FieldName = 'name' | 'email' | 'password'

export default function SignUpPage() {
  const { signUp, session, privyEnabled } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [errors, setErrors] = useState<Partial<Record<FieldName | 'form', string>>>({})
  const [busy, setBusy] = useState(false)
  const [showLegacy, setShowLegacy] = useState(false)

  if (session) return <Navigate to={session.organization ? '/app' : '/onboarding'} replace />

  const set = (k: FieldName) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!form.name.trim()) next.name = 'Enter your name.'
    if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = 'Enter a valid email address.'
    if (form.password.length < 10) next.password = 'Use at least 10 characters.'
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    signUp(form)
      .then(() => navigate('/onboarding'))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.fields) {
          setErrors({ name: err.fields.name, email: err.fields.email, password: err.fields.password })
        } else {
          setErrors({ form: errorMessage(err, 'Could not create the account. Try again.') })
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <AuthLayout>
      <p className="eyebrow">Get started</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Create your merchant account</h1>
      <p className="mt-2 text-sm text-dim">Set up billing for your SaaS in a few minutes.</p>

      {privyEnabled && (
        <div className="mt-8 space-y-3">
          <PrivyAuthButtonLazy mode="login" />
          <p className="text-center text-xs text-faint">Sign up or return with email OTP, Google, X, or an external wallet.</p>
          {!showLegacy && (
            <Button type="button" variant="ghost" className="w-full" onClick={() => setShowLegacy(true)}>
              Create an account with the legacy password flow
            </Button>
          )}
        </div>
      )}

      {(!privyEnabled || showLegacy) && (
        <>
          {privyEnabled && (
            <Button type="button" variant="ghost" className="mt-3 w-full" onClick={() => setShowLegacy(false)}>
              Back to Privy sign-in
            </Button>
          )}
          <OrDivider />
          <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
            <TextField label="Full name" autoComplete="name" value={form.name} onChange={set('name')} error={errors.name} />
            <TextField label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
            <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint="At least 10 characters. A passphrase works well." />
            {errors.form && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{errors.form}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Create account</Button>
          </form>
          <OrDivider />
          <WalletEntry />
        </>
      )}

      <p className="mt-8 text-center text-sm text-dim">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-cyan hover:text-cyan-soft">Log in</Link>
      </p>
    </AuthLayout>
  )
}
