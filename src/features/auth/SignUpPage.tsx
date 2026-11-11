import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError, errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'
import { OrDivider } from './WalletEntry'
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
      <h1 className="display mt-2 text-3xl font-semibold text-fg sm:text-4xl">Create your RETEMPO account</h1>
      <p className="mt-3 text-sm leading-relaxed text-dim">Set up a workspace for your subscription billing preview.</p>

      {privyEnabled && (
        <div className="mt-7 space-y-3 sm:mt-8">
          <PrivyAuthButtonLazy mode="login" />
          <p className="text-center text-xs leading-relaxed text-dim">Choose the sign-in method that works for you in the next step.</p>
          {!showLegacy && (
            <Button type="button" variant="ghost" className="mt-2 w-full" aria-expanded={false} onClick={() => setShowLegacy(true)}>
              Use an existing password account instead
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
            <TextField label="Full name" autoComplete="name" value={form.name} onChange={set('name')} error={errors.name} />
            <TextField label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
            <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint="At least 10 characters. A passphrase works well." />
            {errors.form && <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">{errors.form}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Create account with password</Button>
          </form>
        </div>
      )}

      <p className="mt-7 text-center text-sm text-dim sm:mt-8">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-cyan hover:text-cyan-soft">Sign in</Link>
      </p>
    </AuthLayout>
  )
}
