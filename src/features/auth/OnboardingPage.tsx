import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { isAddress } from 'viem'
import { ArrowLeft, Check, MailWarning } from 'lucide-react'
import type { OrganizationInput } from '@shared/types'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { SelectField, TextField } from '@/components/ui/Field'
import { Notice, Skeleton } from '@/components/ui/States'
import { auth } from '@/services/auth'
import { errorMessage, post } from '@/services/api/client'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './AuthProvider'
import { EmbeddedWalletAddressLazy } from './PrivyWalletFeatureLazy'

const steps = ['Organization', 'Payout address', 'Review']
type AutomaticPayoutSuggestion = { address: string; pairKey: string; generation: number }

const industries = [
  { value: '', label: 'Choose an industry' },
  ...['Software / SaaS', 'Developer tools', 'AI / ML', 'Media & content', 'Fintech', 'Other'].map((v) => ({ value: v, label: v })),
]
const countries = [
  ['', 'Choose a country'],
  ['ID', 'Indonesia'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['CA', 'Canada'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['OTHER', 'Other'],
].map(([value, label]) => ({ value, label }))

function VerifyGate({ email, onChecked }: { email: string; onChecked: () => Promise<unknown> }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const check = async () => {
    setChecking(true)
    setError(undefined)
    try {
      await onChecked()
    } catch (err) {
      setError(errorMessage(err, 'Could not check verification status. Try again.'))
    } finally {
      setChecking(false)
    }
  }
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
            <Button loading={checking} onClick={() => void check()}>I have verified</Button>
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
  const { session, status, sessionRevision, createOrganization, refresh, privyEnabled } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [form, setForm] = useState({
    name: '',
    slug: '',
    website: '',
    industry: '',
    country: '',
    payoutAddress: '',
  })
  const currentUserIdRef = useRef(session?.user.id ?? null)
  const sessionRevisionRef = useRef(sessionRevision)
  useLayoutEffect(() => {
    currentUserIdRef.current = session?.user.id ?? null
    sessionRevisionRef.current = sessionRevision
  }, [session?.user.id, sessionRevision])
  const [payoutOrigin, setPayoutOrigin] = useState<'automatic' | 'manual' | null>(null)
  const payoutOriginRef = useRef<'automatic' | 'manual' | null>(null)
  const payoutAddressValueRef = useRef('')
  const [automaticPayoutSuggestion, setAutomaticPayoutSuggestion] = useState<AutomaticPayoutSuggestion | null>(null)
  const automaticPayoutSuggestionRef = useRef<AutomaticPayoutSuggestion | null>(null)
  const walletVerifierRef = useRef<(() => Promise<boolean>) | null>(null)
  const setWalletVerifier = useCallback((verify: (() => Promise<boolean>) | null) => {
    walletVerifierRef.current = verify
  }, [])
  const setPayoutAddress = useCallback((payoutAddress: string, pairKey: string, generation: number) => {
    if (!payoutAddress) {
      if (payoutOriginRef.current !== 'automatic') return
      const previousSuggestion = payoutAddressValueRef.current
      payoutOriginRef.current = null
      setPayoutOrigin(null)
      payoutAddressValueRef.current = ''
      automaticPayoutSuggestionRef.current = null
      setAutomaticPayoutSuggestion(null)
      setForm((f) => f.payoutAddress === previousSuggestion ? { ...f, payoutAddress: '' } : f)
      return
    }
    if (generation !== sessionRevision || payoutOriginRef.current === 'manual') return
    if (payoutAddressValueRef.current && payoutOriginRef.current !== 'automatic') return
    const suggestion = { address: payoutAddress, pairKey, generation }
    payoutOriginRef.current = 'automatic'
    setPayoutOrigin('automatic')
    payoutAddressValueRef.current = payoutAddress
    automaticPayoutSuggestionRef.current = suggestion
    setAutomaticPayoutSuggestion(suggestion)
    setForm((f) => f.payoutAddress === payoutAddress ? f : { ...f, payoutAddress })
  }, [sessionRevision])

  const effectivePayoutAddress = payoutOrigin === 'automatic'
    ? status === 'ready' && automaticPayoutSuggestion?.generation === sessionRevision &&
      Boolean(session?.user.id && automaticPayoutSuggestion.pairKey.startsWith(`${session.user.id}\u0000`))
      ? automaticPayoutSuggestion.address
      : ''
    : form.payoutAddress

  const walletProbe = privyEnabled ? (
    <div className={status === 'ready' && step === 1 ? '' : 'hidden'} aria-hidden={status !== 'ready' || step !== 1}>
      <EmbeddedWalletAddressLazy
        value={effectivePayoutAddress}
        generation={sessionRevision}
        onAddress={setPayoutAddress}
        onVerifyAvailable={setWalletVerifier}
      />
    </div>
  ) : null

  if (status === 'loading') {
    return (
      <AuthLayout wide>
        {walletProbe}
        <Skeleton className="h-64" />
      </AuthLayout>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  if (session.organization) return <Navigate to="/app" replace />
  if (session.requireVerifiedEmail && session.user.email && !session.user.emailVerified) {
    return <VerifyGate email={session.user.email} onChecked={async () => { await refresh() }} />
  }

  const update = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setErrors((current) => {
      const next = { ...current }
      Object.keys(patch).forEach((key) => delete next[key])
      return next
    })
  }
  const next = () => {
    const e: Record<string, string> = {}
    if (step === 0) {
      if (form.name.trim().length < 2) e.name = 'Enter your organization name.'
      if (!/^[a-z0-9-]{2,40}$/.test(form.slug)) e.slug = 'Use 2-40 lowercase letters, numbers or hyphens.'
      if (form.website && !/^https?:\/\/\S+\.\S+/.test(form.website)) e.website = 'Start with https://'
      if (!form.industry) e.industry = 'Choose an industry.'
      if (!form.country) e.country = 'Choose a country.'
    }
    if (step === 1 && effectivePayoutAddress && !isAddress(effectivePayoutAddress)) {
      e.payoutAddress = 'Enter a valid 0x wallet address.'
    }
    setErrors(e)
    if (Object.keys(e).length === 0) setStep((s) => s + 1)
  }

  const payoutSelectionIsCurrent = (expectedUserId: string, address: string) => {
    if (!address || currentUserIdRef.current !== expectedUserId) return !address
    if (payoutOriginRef.current === 'manual') return payoutAddressValueRef.current === address
    const currentSuggestion = automaticPayoutSuggestionRef.current
    return payoutOriginRef.current === 'automatic' &&
      currentSuggestion?.address === address &&
      currentSuggestion.generation === sessionRevisionRef.current &&
      currentSuggestion.pairKey.startsWith(`${expectedUserId}\u0000`)
  }

  const create = () => {
    if (!session) return
    const expectedUserId = session.user.id
    const payoutAddressToSave = effectivePayoutAddress
    setBusy(true)
    setError(undefined)
    const input: OrganizationInput = {
      name: form.name.trim(),
      slug: form.slug,
      website: form.website || undefined,
      industry: form.industry,
      country: form.country,
    }
    void (async () => {
      try {
        const currentSession = await refresh()
        if (currentSession?.user.id !== expectedUserId) {
          setError('Your sign-in changed. Review this step again before continuing.')
          return
        }
        if (payoutAddressToSave && !payoutSelectionIsCurrent(expectedUserId, payoutAddressToSave)) {
          setError('Your payout address changed. Review it again before continuing.')
          return
        }
        if (payoutAddressToSave && payoutOrigin === 'automatic') {
          const verifyWallet = walletVerifierRef.current
          if (!verifyWallet || !(await verifyWallet()) || !payoutSelectionIsCurrent(expectedUserId, payoutAddressToSave)) {
            setError('Wallet access changed. Check your payout address again, or clear it and continue without one.')
            return
          }
        }

        const createdSession = await createOrganization(input)
        if (createdSession.user.id !== expectedUserId) {
          setError('Your sign-in changed during setup. No payout address was saved; review the current account before continuing.')
          return
        }
        if (payoutAddressToSave && createdSession.organization) {
          if (!payoutSelectionIsCurrent(expectedUserId, payoutAddressToSave)) {
            setError('The payout address changed during setup. No payout address was saved.')
            return
          }
          await post(`/orgs/${createdSession.organization.id}/wallets`, {
            purpose: 'payout',
            address: payoutAddressToSave,
            label: 'Primary payout',
          }).catch(() => undefined)
        }
        await navigate('/app')
      } catch (err) {
        setError(errorMessage(err, 'Could not create the organization. Try again.'))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <AuthLayout wide>
      {walletProbe}
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
            <span className={cn('text-xs sm:text-sm', i === step ? 'text-fg' : 'hidden text-faint sm:block')}>{label}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-line" />}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-dim sm:hidden">Step {step + 1} of {steps.length}</p>

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
                <SelectField label="Industry" value={form.industry} options={industries} error={errors.industry} onChange={(e) => update({ industry: e.target.value })} />
                <SelectField label="Country" value={form.country} options={countries} error={errors.country} onChange={(e) => update({ country: e.target.value })} />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm leading-relaxed text-dim">
                Add a public payout address if you have one. When available, your RETEMPO wallet address is filled in automatically. You can edit or skip this and add it later. Never enter a private key or recovery phrase.
              </p>
              <TextField
                label="Payout address (optional)"
                placeholder="0x..."
                className="mono"
                value={effectivePayoutAddress}
                error={errors.payoutAddress}
                onChange={(e) => {
                  const value = e.target.value.trim()
                  setPayoutOrigin('manual')
                  payoutOriginRef.current = 'manual'
                  payoutAddressValueRef.current = value
                  automaticPayoutSuggestionRef.current = null
                  setAutomaticPayoutSuggestion(null)
                  update({ payoutAddress: value })
                }}
              />
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
                  ['Payout address', effectivePayoutAddress || 'Not set'],
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
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || busy} icon={<ArrowLeft className="size-4" />}>
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
