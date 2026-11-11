import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { ArrowLeft, Check, MailWarning } from 'lucide-react'
import type { OrganizationInput } from '@shared/types'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { SelectField, TextField } from '@/components/ui/Field'
import { Notice, Skeleton } from '@/components/ui/States'
import { auth } from '@/services/auth'
import { errorMessage, post } from '@/services/api/client'
import { WalletButton } from '@/components/wallet/WalletButton'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'

const steps = ['Organization', 'Payout wallet', 'Review']

const industries = ['Software / SaaS', 'Developer tools', 'AI / ML', 'Media & content', 'Fintech', 'Other'].map((v) => ({ value: v, label: v }))
const countries = [
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['CA', 'Canada'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['OTHER', 'Other'],
].map(([value, label]) => ({ value, label }))

function VerifyGate({ email, onChecked }: { email: string; onChecked: () => void }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string>()
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
    <AuthLayout wide>
      <p className="eyebrow">Merchant onboarding</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Verify your email first</h1>
      <Card className="mt-6">
        <CardBody className="space-y-4">
          <MailWarning className="size-6 text-caution" />
          <p className="text-sm text-dim">
            We sent a verification link to <span className="text-fg">{email}</span>. Open it, then come back here to create your organization.
          </p>
          {error && (
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button onClick={onChecked}>I have verified</Button>
            <Button variant="secondary" loading={state === 'sending'} onClick={resend}>
              {state === 'sent' ? 'Sent. Resend again' : 'Resend email'}
            </Button>
          </div>
        </CardBody>
      </Card>
    </AuthLayout>
  )
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export default function OnboardingPage() {
  const { session, status, createOrganization, refresh } = useAuth()
  const { address } = useAccount()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [form, setForm] = useState({
    name: '',
    slug: '',
    website: '',
    industry: industries[0].value,
    country: 'US',
    payoutAddress: '',
  })

  if (status === 'loading') {
    return (
      <AuthLayout wide>
        <Skeleton className="h-64" />
      </AuthLayout>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  if (session.organization) return <Navigate to="/app" replace />
  if (session.requireVerifiedEmail && session.user.email && !session.user.emailVerified) {
    return <VerifyGate email={session.user.email} onChecked={() => void refresh()} />
  }

  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const next = () => {
    const e: Record<string, string> = {}
    if (step === 0) {
      if (form.name.trim().length < 2) e.name = 'Enter your organization name.'
      if (!/^[a-z0-9-]{2,40}$/.test(form.slug)) e.slug = 'Use 2-40 lowercase letters, numbers or hyphens.'
      if (form.website && !/^https?:\/\/\S+\.\S+/.test(form.website)) e.website = 'Start with https://'
    }
    if (step === 1 && form.payoutAddress && !isAddress(form.payoutAddress)) {
      e.payoutAddress = 'Enter a valid 0x wallet address.'
    }
    setErrors(e)
    if (Object.keys(e).length === 0) setStep((s) => s + 1)
  }

  const create = () => {
    setBusy(true)
    setError(undefined)
    const input: OrganizationInput = {
      name: form.name.trim(),
      slug: form.slug,
      website: form.website || undefined,
      industry: form.industry,
      country: form.country,
    }
    createOrganization(input)
      .then(async (s) => {
        // The payout address is a separate, optional association on the new organization.
        if (form.payoutAddress && s.organization) {
          await post(`/orgs/${s.organization.id}/wallets`, { purpose: 'payout', address: form.payoutAddress, label: 'Primary payout' }).catch(() => undefined)
        }
        void navigate('/app')
      })
      .catch((err: unknown) => setError(errorMessage(err, 'Could not create the organization. Try again.')))
      .finally(() => setBusy(false))
  }

  return (
    <AuthLayout wide>
      <p className="eyebrow">Merchant onboarding</p>
      <h1 className="display mt-2 text-3xl font-semibold text-fg">Set up your organization</h1>

      <ol className="mt-6 flex items-center gap-2" aria-label="Progress">
        {steps.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                i < step && 'border-cyan bg-cyan text-midnight',
                i === step && 'border-cyan text-cyan',
                i > step && 'border-line-strong text-faint',
              )}
              aria-current={i === step ? 'step' : undefined}
            >
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('hidden text-sm sm:block', i === step ? 'text-fg' : 'text-faint')}>{label}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-line" />}
          </li>
        ))}
      </ol>

      <Card className="mt-6">
        <CardBody className="space-y-4">
          {step === 0 && (
            <>
              <TextField
                label="Organization name"
                value={form.name}
                error={errors.name}
                onChange={(e) => update({ name: e.target.value, slug: slugify(e.target.value) })}
              />
              <TextField label="Organization slug" value={form.slug} error={errors.slug} hint="Used in your checkout and portal links." onChange={(e) => update({ slug: slugify(e.target.value) })} />
              <TextField label="Website (optional)" type="url" placeholder="https://" value={form.website} error={errors.website} onChange={(e) => update({ website: e.target.value })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="Industry" value={form.industry} options={industries} onChange={(e) => update({ industry: e.target.value })} />
                <SelectField label="Country" value={form.country} options={countries} onChange={(e) => update({ country: e.target.value })} />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm text-dim">
                Where should USDC payouts settle? Provide a public address only. RETEMPO never asks for private keys or seed phrases. You can skip this and add it later.
              </p>
              <TextField
                label="Payout address (optional)"
                placeholder="0x..."
                className="mono"
                value={form.payoutAddress}
                error={errors.payoutAddress}
                onChange={(e) => update({ payoutAddress: e.target.value.trim() })}
              />
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-midnight/50 p-3">
                <WalletButton compact />
                {address && (
                  <Button variant="ghost" size="sm" onClick={() => update({ payoutAddress: address })}>
                    Use connected wallet
                  </Button>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <dl className="divide-y divide-line/70 text-sm">
                {[
                  ['Organization', form.name],
                  ['Slug', form.slug],
                  ['Industry', form.industry],
                  ['Country', form.country],
                  ['Website', form.website || 'Not set'],
                  ['Payout address', form.payoutAddress || 'Not set'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 py-2.5">
                    <dt className="text-faint">{k}</dt>
                    <dd className="mono max-w-[60%] truncate text-right text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
              <Notice title="Preview workspace">Payment and settlement features are currently unavailable in this preview.</Notice>
              {error && (
                <p role="alert" className="text-sm text-negative">
                  {error}
                </p>
              )}
            </>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0} icon={<ArrowLeft className="size-4" />}>
              Back
            </Button>
            {step < 2 ? (
              <Button onClick={next}>Continue</Button>
            ) : (
              <Button onClick={create} loading={busy}>
                Create organization
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
    </AuthLayout>
  )
}
