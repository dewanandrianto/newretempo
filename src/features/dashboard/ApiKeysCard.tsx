import { useState, type FormEvent } from 'react'
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react'
import type { ApiKeyCreated, DeveloperOverview } from '@shared/types'
import { merchant } from '@/services/merchant/api'
import { fmtDate } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { TextField } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/States'
import { ConfirmAction, CreateDialog, useMerchantMutation } from './actions'
import { FormFooter } from './forms/shared'

function SecretReveal({ created, onClose }: { created: ApiKeyCreated | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Modal open={created !== null} onClose={onClose} title="Copy your API key now" description="This is the only time the full key is shown. RETEMPO stores only a hash.">
      {created && (
        <div className="space-y-4">
          <div className="mono break-all rounded-xl border border-line-strong bg-midnight p-4 text-xs text-fg">{created.secret}</div>
          <div className="flex items-start gap-2 text-xs text-caution">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p>Treat it like a password. Anyone with this key could act as your organization once key authentication is enabled.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              icon={copied ? <Check className="size-4 text-positive" /> : <Copy className="size-4" />}
              onClick={() => {
                void navigator.clipboard.writeText(created.secret).then(() => setCopied(true))
              }}
            >
              {copied ? 'Copied' : 'Copy key'}
            </Button>
            <Button onClick={onClose}>I have saved it</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function KeyForm({ onDone, onCreated }: { onDone: () => void; onCreated: (k: ApiKeyCreated) => void }) {
  const [name, setName] = useState('')
  const [write, setWrite] = useState(false)
  const m = useMerchantMutation(merchant.apiKeys.create, 'API key created', (k) => {
    onDone()
    onCreated(k)
  }, true)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate({ name, scopes: write ? ['read', 'write'] : ['read'] })
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <TextField label="Key name" placeholder="Production server" value={name} onChange={(e) => setName(e.target.value)} error={m.fields.name} autoFocus />
      <label className="flex items-center gap-3 text-sm text-dim">
        <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="size-4 accent-cyan" />
        Allow write access (read access is always included)
      </label>
      <FormFooter label="Create key" busy={m.isPending} error={m.formError} onCancel={onDone} />
    </form>
  )
}

function RevokeKey({ id }: { id: string }) {
  const revoke = useMerchantMutation(() => merchant.apiKeys.revoke(id), 'API key revoked')
  return (
    <ConfirmAction
      label="Revoke"
      title="Revoke this API key?"
      description="Anything using this key will lose access. This cannot be undone."
      confirmLabel="Revoke key"
      onConfirm={() => revoke.mutateAsync(undefined)}
    />
  )
}

export function ApiKeysCard({ keys }: { keys: DeveloperOverview['apiKeys'] }) {
  const [created, setCreated] = useState<ApiKeyCreated | null>(null)
  return (
    <Card>
      <CardHeader
        title="API keys"
        description="Keys are issued and stored hashed. Request authentication with keys is not enabled yet."
        action={
          <CreateDialog label="Create key" title="Create API key">
            {(close) => <KeyForm onDone={close} onCreated={setCreated} />}
          </CreateDialog>
        }
      />
      {keys.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-5" />} title="No API keys" description="Create a key to prepare server-to-server access." />
      ) : (
        <ul className="mt-4 divide-y divide-line/60">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-5 py-3.5 sm:px-6">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg">{k.label}</p>
                <p className="mono truncate text-xs text-faint">
                  {k.prefix}... · created {fmtDate(k.createdAt)}
                </p>
              </div>
              {k.revokedAt ? <Badge>Revoked</Badge> : <RevokeKey id={k.id} />}
            </li>
          ))}
        </ul>
      )}
      <SecretReveal created={created} onClose={() => setCreated(null)} />
    </Card>
  )
}
