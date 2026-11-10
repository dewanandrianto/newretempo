import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { LogOut, ShieldCheck, Trash2 } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthProvider'
import { roleCan, ROLE_REASON } from '@/features/auth/permissions'
import { blockchain } from '@/services/blockchain'
import { merchant } from '@/services/merchant/api'
import { shortAddress } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { TextField } from '@/components/ui/Field'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/States'
import { WalletButton, useUsdcBalance } from '@/components/wallet/WalletButton'
import { ConfirmAction, CreateDialog, useMerchantMutation } from '../actions'
import { FormFooter } from '../forms/shared'
import { MembersCard } from '../MembersCard'

function ProfileCard() {
  const { session, refresh } = useAuth()
  const org = session?.organization
  const canEdit = roleCan(session?.role, 'org')
  const [form, setForm] = useState({ name: org?.name ?? '', website: org?.website ?? '', industry: org?.industry ?? '', country: org?.country ?? '' })
  const save = useMerchantMutation(() => merchant.org.update({ name: form.name, website: form.website, industry: form.industry, country: form.country }), 'Profile saved', () => void refresh(), true)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate(undefined)
  }
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Organization" description="Shown on invoices and checkout pages" />
      <CardBody>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <TextField label="Name" value={form.name} onChange={set('name')} readOnly={!canEdit} error={save.fields.name} />
          <TextField label="URL slug" value={org?.slug ?? ''} readOnly hint="Fixed after creation." />
          <TextField label="Industry" value={form.industry} onChange={set('industry')} readOnly={!canEdit} error={save.fields.industry} />
          <TextField label="Country" value={form.country} onChange={set('country')} readOnly={!canEdit} error={save.fields.country} />
          <div className="sm:col-span-2">
            <TextField label="Website" placeholder="https://" value={form.website} onChange={set('website')} readOnly={!canEdit} error={save.fields.website} />
          </div>
          <div className="sm:col-span-2">
            {canEdit ? (
              <FormFooter label="Save changes" busy={save.isPending} error={save.formError} onCancel={() => setForm({ name: org?.name ?? '', website: org?.website ?? '', industry: org?.industry ?? '', country: org?.country ?? '' })} />
            ) : (
              <p className="text-xs text-faint">{ROLE_REASON}. Ask an owner or admin to change the profile.</p>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

function PayoutForm({ onDone, defaultAddress }: { onDone: () => void; defaultAddress?: string }) {
  const [address, setAddress] = useState(defaultAddress ?? '')
  const [label, setLabel] = useState('')
  const m = useMerchantMutation(merchant.wallets.create, 'Payout wallet saved', onDone, true)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate({ purpose: 'payout', address, label })
      }}
      className="space-y-4"
      noValidate
    >
      <TextField label="Wallet address" className="mono" placeholder="0x..." value={address} onChange={(e) => setAddress(e.target.value.trim())} error={m.fields.address} autoFocus />
      <TextField label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} error={m.fields.label} />
      <FormFooter label="Save wallet" busy={m.isPending} error={m.formError} onCancel={onDone} note="Public addresses only. RETEMPO never asks for private keys. Saved addresses are marked unverified because no signature proves control." />
    </form>
  )
}

function RemoveWallet({ id }: { id: string }) {
  const remove = useMerchantMutation(() => merchant.wallets.remove(id), 'Wallet removed')
  return (
    <ConfirmAction
      label="Remove"
      icon={<Trash2 className="size-4" />}
      title="Remove this payout wallet?"
      description="Future settlements can no longer target this address."
      confirmLabel="Remove wallet"
      onConfirm={() => remove.mutateAsync(undefined)}
    />
  )
}

function PayoutCard() {
  const { session } = useAuth()
  const { address } = useAccount()
  const { formatted, isLoading } = useUsdcBalance()
  const canEdit = roleCan(session?.role, 'wallets')
  const wallets = useQuery({ queryKey: ['billing', session?.organization?.id, 'wallets'], queryFn: () => merchant.wallets.list() })
  const payouts = (wallets.data ?? []).filter((w) => w.purpose === 'payout')

  return (
    <Card>
      <CardHeader
        title="Payout wallets"
        description={`${blockchain.network.name} USDC`}
        action={
          canEdit && (
            <CreateDialog label="Add wallet" title="Add a payout wallet">
              {(close) => <PayoutForm onDone={close} defaultAddress={address} />}
            </CreateDialog>
          )
        }
      />
      <CardBody className="space-y-4">
        {wallets.isPending ? (
          <Skeleton className="h-14" />
        ) : payouts.length === 0 ? (
          <p className="text-sm text-dim">No payout wallet saved yet.</p>
        ) : (
          <ul className="space-y-2">
            {payouts.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-midnight/50 p-3">
                <div className="min-w-0">
                  <p className="mono truncate text-xs text-fg">{shortAddress(w.address)}</p>
                  <p className="text-xs text-faint">{w.label || 'Payout'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={w.verified ? 'positive' : 'caution'}>{w.verified ? 'Verified' : 'Unverified'}</Badge>
                  {canEdit && <RemoveWallet id={w.id} />}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-midnight/50 p-3">
          <div>
            <p className="text-xs text-faint">Connected wallet</p>
            <p className="num text-sm font-medium text-fg">{address ? (isLoading ? 'Reading balance...' : `${formatted ?? '0.00'} USDC`) : 'Not connected'}</p>
          </div>
          <WalletButton compact />
        </div>
      </CardBody>
    </Card>
  )
}

export default function SettingsPage() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader title="Settings" description="Organization profile, team, payout wallets and security." />
      <div className="grid gap-4 xl:grid-cols-3">
        <ProfileCard key={session?.organization?.id} />
        <PayoutCard />
        <div className="xl:col-span-2">
          <MembersCard />
        </div>
        <Card>
          <CardHeader title="Security" />
          <CardBody className="space-y-4">
            <div className="flex gap-3 text-sm text-dim">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan" />
              <p>RETEMPO never asks for or stores private keys or seed phrases. Your wallet signs everything. Your role here is <span className="text-fg">{session?.role}</span>.</p>
            </div>
            <p className="text-xs text-faint">
              Signed in {session?.user.email ? `as ${session.user.email}` : 'with a wallet'}. Sessions are server-side and expire automatically.
            </p>
            <Button
              variant="secondary"
              className="w-full"
              icon={<LogOut className="size-4" />}
              onClick={() => {
                void signOut().then(() => navigate('/'))
              }}
            >
              Sign out
            </Button>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
