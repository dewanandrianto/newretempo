import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { UserMinus } from 'lucide-react'
import type { ApiMember, MemberRole } from '@shared/types'
import { merchant } from '@/services/merchant/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { initials } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { Card, CardHeader } from '@/components/ui/Card'
import { SelectField, TextField } from '@/components/ui/Field'
import { ErrorState, TableSkeleton } from '@/components/ui/States'
import { ConfirmAction, CreateDialog, useMerchantMutation } from './actions'
import { FormFooter } from './forms/shared'

const RANK: Record<MemberRole, number> = { member: 1, admin: 2, owner: 3 }

function AddMemberForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const m = useMerchantMutation(merchant.members.add, 'Member added', onDone, true)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    m.mutate({ email, role })
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <TextField label="Email of an existing RETEMPO account" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={m.fields.email} autoFocus />
      <SelectField
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
        options={[
          { value: 'member', label: 'Member: read everything, manage customers and invoices' },
          { value: 'admin', label: 'Admin: manage billing, escrow records, wallets and keys' },
        ]}
      />
      <FormFooter label="Add member" busy={m.isPending} error={m.formError} onCancel={onDone} note="They must already have signed up. Email invitations arrive with an email provider." />
    </form>
  )
}

function RemoveMember({ member, label }: { member: ApiMember; label: string }) {
  const remove = useMerchantMutation(() => merchant.members.remove(member.userId), label === 'Leave' ? 'You left the organization' : 'Member removed')
  return (
    <ConfirmAction
      label={label}
      icon={<UserMinus className="size-4" />}
      title={label === 'Leave' ? 'Leave this organization?' : 'Remove this member?'}
      description={label === 'Leave' ? 'You will lose access immediately.' : 'They lose access to this organization immediately.'}
      confirmLabel={label === 'Leave' ? 'Leave organization' : 'Remove member'}
      onConfirm={() => remove.mutateAsync(undefined)}
    />
  )
}

export function MembersCard() {
  const { session } = useAuth()
  const me = session?.user.id
  const myRole = session?.role ?? 'member'
  const query = useQuery({ queryKey: ['billing', session?.organization?.id, 'members'], queryFn: () => merchant.members.list() })
  const canManage = myRole === 'owner' || myRole === 'admin'

  return (
    <Card>
      <CardHeader
        title="Team"
        description="Owners and admins manage the workspace. Members have limited write access."
        action={
          canManage && (
            <CreateDialog label="Add member" title="Add a team member">
              {(close) => <AddMemberForm onDone={close} />}
            </CreateDialog>
          )
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : (
        <ul className="mt-4 divide-y divide-line/60">
          {query.data.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-electric/15 text-xs font-semibold text-electric-soft">{initials(m.displayName || m.email || '?')}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">
                  {m.displayName || 'Unnamed'} {m.userId === me && <span className="text-faint">(you)</span>}
                </p>
                <p className="truncate text-xs text-faint">{m.email ?? 'Wallet account'}</p>
              </div>
              <Badge tone={m.role === 'owner' ? 'cyan' : 'neutral'}>{m.role}</Badge>
              {m.userId === me ? (
                <RemoveMember member={m} label="Leave" />
              ) : (
                canManage && RANK[myRole] > RANK[m.role] && <RemoveMember member={m} label="Remove" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
