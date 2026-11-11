import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { auth } from '@/services/auth'
import { useAuth } from './AuthProvider'
import { PrivyAuthButtonLazy } from './PrivyAuthButtonLazy'

const queryKey = ['auth', 'privy-link-status']

export function PrivyLinkPanel() {
  const { privyEnabled } = useAuth()
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  const status = useQuery({ queryKey, queryFn: () => auth.privyLinkStatus(), enabled: privyEnabled })

  if (!privyEnabled) return null

  return (
    <Card>
      <CardHeader title="Privy sign-in" description="Add email OTP, Google, X, and external-wallet sign-in to this existing account." />
      <CardBody className="space-y-3">
        <p className="text-sm text-dim">Linking requires this signed-in RETEMPO session and a valid Privy session. RETEMPO does not merge accounts based on matching email addresses.</p>
        {status.isPending ? (
          <p className="text-sm text-faint" role="status">Checking linked sign-in…</p>
        ) : status.isError ? (
          <p className="text-sm text-negative" role="alert">Could not check the linked sign-in status. Refresh the page and try again.</p>
        ) : status.data?.linked ? (
          <p className="text-sm font-medium text-positive">A Privy sign-in is linked to this account.</p>
        ) : starting ? (
          <PrivyAuthButtonLazy mode="link" onLinked={() => {
            setStarting(false)
            void queryClient.invalidateQueries({ queryKey })
          }} />
        ) : (
          <Button type="button" variant="secondary" className="w-full" onClick={() => setStarting(true)}>
            Link a Privy sign-in
          </Button>
        )}
      </CardBody>
    </Card>
  )
}
