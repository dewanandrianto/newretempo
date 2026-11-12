import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useSignMessage } from 'wagmi'
import { ShieldCheck } from 'lucide-react'
import type { ChainCheckout } from '../../../shared/chain'
import { chainApi, displayUsdc, parseUsdc } from '@/services/blockchain'
import { useRetempoTransactions } from '@/features/onchain/useRetempoTransactions'
import { TransactionStatus, canSubmit } from '@/features/onchain/TransactionStatus'
import type { ProjectionTarget } from '@/features/onchain/proof'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState, PageSkeleton } from '@/components/ui/States'
import { WalletButton, useUsdcBalance } from '@/components/wallet/WalletButton'
import { checkoutAvailability, checkoutActionsPaused, checkoutPauseMessage, checkoutWindows, assertCheckoutPreparation, checkoutDue, checkoutSubscription, checkoutConsentIdentity } from './model'
import { PrivyAuthButtonLazy } from '@/features/auth/PrivyAuthButtonLazy'
import { PrivyCustomerWalletPickerLazy } from '@/features/auth/PrivyCustomerWalletPickerLazy'
import { VerifyEmailBanner } from '@/features/auth/VerifyEmailBanner'
import { useRuntimeAuthConfig } from '@/features/auth/privyRuntimeContext'
import { useAuth } from '@/features/auth/AuthProvider'
import { errorMessage } from '@/services/api/client'

function formatDuration(seconds: number) {
  let remaining = seconds
  const parts: string[] = []
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]] as const) {
    const count = Math.floor(remaining / size)
    if (count > 0) {
      parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`)
      remaining -= count * size
    }
  }
  return parts.join(' ') || '0 seconds'
}

function Checkout({ checkout, token, invoice }: { checkout: ChainCheckout; token: string; invoice: boolean }) {
  const { enabled: privyEnabled } = useRuntimeAuthConfig()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const { signMessageAsync } = useSignMessage()
  const { address, chainId } = useAccount()
  const balance = useUsdcBalance()
  const tx = useRetempoTransactions(checkout.configuration, `invoice-payment:${checkout.subscriptionId}:${checkout.invoiceId}`)
  const [consentedTerms, setConsentedTerms] = useState<string>()
  const [prepared, setPrepared] = useState<ChainCheckout>()
  const [now, setNow] = useState(() => Date.now())
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkFeedback, setLinkFeedback] = useState<{ address: string; kind: 'error' | 'notice'; text: string }>()
  const activeFeedback = address && linkFeedback?.address.toLowerCase() === address.toLowerCase() ? linkFeedback : undefined
  const linkError = activeFeedback?.kind === 'error' ? activeFeedback.text : undefined
  const linkNotice = activeFeedback?.kind === 'notice' ? activeFeedback.text : undefined
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const availability = checkoutAvailability(checkout, now)
  const actionsPaused = checkoutActionsPaused(checkout.configuration)
  const pauseMessage = checkoutPauseMessage(checkout.configuration)
  const canReadDetails = checkout.configuration.configured && (!availability || actionsPaused)
  const windows = useQuery({ queryKey: ['checkout-windows', checkout.planKey, checkout.configuration.genesisHash], queryFn: () => checkoutWindows(checkout), enabled: canReadDetails, retry: false, staleTime: 0 })
  const subscription = useQuery({ queryKey: ['checkout-subscription', checkout.id, checkout.subscriptionKey], queryFn: () => checkoutSubscription(checkout), enabled: canReadDetails, retry: false })
  const walletStatus = useQuery({
    queryKey: ['checkout-customer-wallet', checkout.id, auth.session?.user.id, address],
    queryFn: () => chainApi.customerWalletStatus(token, address!),
    enabled: Boolean(auth.session && address),
    retry: false,
    staleTime: 0,
  })
  const existing = Boolean(subscription.data && subscription.data.status !== 0)
  const wrongNetwork = Boolean(address && chainId !== 5042002)
  const due = checkoutDue(checkout, existing)
  const consentKey = auth.session && address && windows.data && subscription.isSuccess && !subscription.isFetching && !windows.isFetching && !availability && !actionsPaused
    ? checkoutConsentIdentity(checkout, auth.session.user.id, address, existing, windows.data)
    : undefined
  const consent = Boolean(consentKey && consentedTerms === consentKey)
  const balanceTooLow = balance.formatted !== undefined && parseUsdc(balance.formatted) < due
  const target = (context: ChainCheckout): ProjectionTarget => !existing && checkout.trialDays > 0
    ? { kind: 'subscription', recordId: checkout.subscriptionId, states: ['active'], eventNames: ['SubscriptionCreated'] }
    : { kind: 'payment', recordId: context.paymentId ?? 'not-yet-prepared', states: ['succeeded', 'paid'], eventNames: ['SubscriptionPaymentProcessed'] }

  const linkCustomerWallet = async () => {
    const connectedAddress = address
    if (!connectedAddress || !auth.session) return
    setLinkBusy(true)
    setLinkFeedback(undefined)
    try {
      const challenge = await chainApi.customerWalletChallenge(token, connectedAddress)
      if (!('message' in challenge)) {
        await auth.refresh()
        await walletStatus.refetch()
        setLinkFeedback({ address: connectedAddress, kind: 'notice', text: 'This wallet is already verified and linked to the customer record.' })
        return
      }
      if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('The wallet challenge expired. Request a new one and try again.')
      const signature = await signMessageAsync({ message: challenge.message })
      await chainApi.verifyCustomerWallet(token, { message: challenge.message, signature })
      await auth.refresh().catch(() => null)
      await queryClient.invalidateQueries({ queryKey: ['checkout-customer-wallet', checkout.id] })
      await walletStatus.refetch()
      setLinkFeedback({ address: connectedAddress, kind: 'notice', text: 'Wallet ownership is verified and linked to this checkout. No payment was made.' })
    } catch (error) {
      const rejected = error instanceof Error && /user rejected|denied|cancel/i.test(error.message)
      setLinkFeedback({ address: connectedAddress, kind: 'error', text: rejected ? 'Signature cancelled. No wallet was linked.' : errorMessage(error, 'The wallet could not be linked. Please try again.') })
    } finally {
      setLinkBusy(false)
    }
  }

  const pay = () => tx.execute(async (sdk, write, remember) => {
    if (actionsPaused) throw new Error(pauseMessage ?? 'Payments are temporarily unavailable.')
    if (!consent || !windows.data) throw new Error('Review and accept the payment terms first.')
    if (!walletStatus.data?.linked || !tx.verifiedWallet) throw new Error('Verify and link this customer wallet before continuing.')
    const result = await chainApi.prepareCheckout(token, sdk.io.account)
    assertCheckoutPreparation(checkout, result)
    setPrepared(result)
    remember(target(result))
    if (existing && result.subscriptionKey) await sdk.renew(result.subscriptionKey, result, windows.data, write)
    else await sdk.subscribe(result, windows.data, write)
  })

  const walletUnavailable = walletStatus.data?.reason === 'merchant_wallet'
    ? 'The customer wallet must be different from the merchant and payout wallets.'
    : walletStatus.data?.reason === 'email_verification_required'
      ? 'Verify your account email before linking a customer wallet.'
      : walletStatus.data?.reason === 'customer_record_in_use'
        ? 'This wallet is already linked to another customer record for this merchant.'
        : 'This wallet is already in use and cannot be linked to this customer record.'

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card className="min-w-0 p-6 sm:p-8">
        <p className="eyebrow">{invoice ? 'Invoice · ' : ''}{checkout.merchantName}</p>
        <h1 className="display mt-3 text-3xl font-semibold text-fg">{checkout.productName}<span className="block text-dim">{checkout.planName}</span></h1>
        <p className="mt-4 text-sm leading-relaxed text-dim">{checkout.description}</p>
        <p className="num mt-8 break-words text-4xl font-semibold text-fg">{displayUsdc(checkout.amount)} <span className="text-lg font-normal text-dim">USDC / {checkout.interval}</span></p>
        <dl className="mt-8 space-y-4 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-dim">Billing interval</dt><dd className="text-fg">{checkout.interval}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-dim">Trial</dt><dd className="text-fg">{checkout.trialDays ? `${checkout.trialDays} days` : 'No trial'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-dim">Hold period</dt><dd className="text-fg">{checkout.escrowDays ? `${checkout.escrowDays} days` : 'None'}</dd></div>
        </dl>
        {subscription.isSuccess && checkout.trialDays > 0 && !existing && <p className="mt-6 text-sm text-dim">The trial does not charge you. Any later payment requires separate approval.</p>}
        {checkout.escrowDays > 0 && (
          <div className="mt-6 space-y-3 border-t border-line pt-5 text-sm text-dim">
            <p className="flex gap-2 font-medium text-fg"><ShieldCheck className="size-4 text-cyan" /> Payment and refund terms</p>
            <p>Eligible funds are released over time during the hold period; this is not a full hold or a guaranteed full refund. {checkout.customerMayRefundUnvested ? 'The unused eligible portion may be refundable.' : 'Refunds for the unused portion are not included.'}</p>
            {windows.data && <p>Response period: <strong className="text-fg">{formatDuration(windows.data.responseWindow)}</strong>. Decision deadline: <strong className="text-fg">{formatDuration(windows.data.resolutionTimeout)}</strong>.</p>}
          </div>
        )}
        <details className="mt-6 text-xs text-faint">
          <summary className="cursor-pointer py-2">Review merchant and payment details</summary>
          <dl className="mt-3 space-y-2 break-all">
            <dt>Merchant wallet</dt><dd className="mono text-fg">{checkout.merchant}</dd>
            <dt>Payout wallet</dt><dd className="mono text-fg">{checkout.payout}</dd>
            {checkout.escrowDays > 0 && <><dt>Dispute resolver</dt><dd className="mono text-fg">{checkout.arbitrator}</dd></>}
          </dl>
        </details>
      </Card>

      <Card className="h-fit min-w-0 space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-fg">Review payment</h2><WalletButton compact /></div>
        <p className="rounded-lg border border-line p-3 text-xs text-dim">Test environment only. No real funds are used.</p>
        {pauseMessage && <p role="status" className="rounded-lg border border-line p-3 text-sm text-caution">{pauseMessage}</p>}
        <dl className="flex justify-between gap-3 text-sm"><dt className="text-dim">Amount due today</dt><dd className="num break-all text-fg">{subscription.isSuccess ? `${displayUsdc(due)} USDC, plus wallet fees` : 'Not yet confirmed'}</dd></dl>
        {availability && availability !== pauseMessage && <p role="status" className="rounded-lg border border-line p-3 text-sm text-caution">{availability}</p>}
        {wrongNetwork && <p role="alert" className="text-sm text-caution">The selected wallet is not connected to the required payment environment.</p>}
        {balanceTooLow && <p role="alert" className="text-sm text-caution">Your wallet balance may not cover this payment and the fees required by your wallet.</p>}
        {canReadDetails && windows.isPending && <p role="status" className="text-sm text-dim">Loading payment terms…</p>}
        {canReadDetails && subscription.isPending && <p role="status" className="text-sm text-dim">Confirming subscription and amount due…</p>}
        {subscription.isError && <p role="alert" className="text-sm text-caution">The subscription status could not be confirmed. Please try again.</p>}
        {windows.isError && <div role="alert" className="text-sm text-caution">Payment terms could not be confirmed. Please try again.</div>}

        {!auth.session && privyEnabled && (
          <div className="space-y-3 rounded-xl border border-line bg-midnight/50 p-4">
            <p className="text-sm leading-relaxed text-dim">Sign in to your RETEMPO account before linking a customer wallet. Signing in does not authorize a payment.</p>
            <PrivyAuthButtonLazy mode="login" redirectTo={window.location.pathname} />
          </div>
        )}
        {!auth.session && !privyEnabled && (
          <div className="space-y-3 rounded-xl border border-line bg-midnight/50 p-4">
            <p className="text-sm leading-relaxed text-dim">Sign in to an existing RETEMPO account before linking a customer wallet.</p>
            {address ? <Button variant="secondary" className="w-full" loading={tx.busy} disabled={wrongNetwork} onClick={() => void tx.signIn()}>Sign in with this wallet</Button> : <Link to="/login" className="inline-block text-sm text-cyan underline underline-offset-4">Sign in</Link>}
          </div>
        )}
        {auth.session && <VerifyEmailBanner />}
        {auth.session && privyEnabled && <PrivyCustomerWalletPickerLazy />}
        {address && auth.session && walletStatus.isPending && <p role="status" className="text-sm text-dim">Checking this wallet's customer association…</p>}
        {address && auth.session && walletStatus.isError && <p role="alert" className="text-sm text-caution">The customer wallet status could not be verified. Refresh the page and try again.</p>}
        {address && auth.session && walletStatus.data && !walletStatus.data.available && !walletStatus.data.linked && <p role="alert" className="text-sm text-caution">{walletUnavailable}</p>}
        {address && auth.session && walletStatus.data?.linked && (
          <div role="status" className="space-y-3 rounded-lg border border-line p-3 text-sm text-dim">
            <p>This wallet is verified and linked to this customer record.</p>
            <p className="mono break-all text-xs text-fg">{address}</p>
            {!tx.verifiedWallet && <Button variant="secondary" className="w-full" onClick={() => void auth.refresh()}>Refresh wallet access</Button>}
          </div>
        )}
        {address && auth.session && walletStatus.data?.available && !walletStatus.data.linked && (
          <div className="space-y-3 rounded-lg border border-line p-3">
            <p className="text-sm leading-relaxed text-dim">Verify ownership to link this wallet to the customer record for this checkout. You will sign a one-time message; it costs no gas and does not approve a payment.</p>
            <p className="mono break-all text-xs text-fg">{address}</p>
            <Button variant="secondary" className="w-full" loading={linkBusy} disabled={wrongNetwork || linkBusy} onClick={() => void linkCustomerWallet()}>
              {linkBusy ? 'Check your wallet to sign' : 'Verify and link this wallet'}
            </Button>
          </div>
        )}
        {linkNotice && <p role="status" className="text-sm text-positive">{linkNotice}</p>}
        {linkError && <p role="alert" className="text-sm text-negative">{linkError}</p>}
        {walletStatus.data?.linked && !tx.verifiedWallet && <p role="alert" className="text-sm text-caution">Wallet access needs refreshing before payment can continue.</p>}

        {!availability && !actionsPaused && (
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-dim">
            <input type="checkbox" className="mt-1 size-4 accent-cyan" checked={consent} disabled={!consentKey || !walletStatus.data?.linked || !tx.verifiedWallet} onChange={(event) => setConsentedTerms(event.target.checked ? consentKey : undefined)} />
            <span>I have reviewed the payment and refund terms. I approve only {displayUsdc(due)} USDC today. This does not authorize future payments.</span>
          </label>
        )}
        <Button
          size="lg"
          className="w-full"
          loading={tx.busy}
          disabled={Boolean(availability) || actionsPaused || wrongNetwork || balanceTooLow || !address || !auth.session || !tx.verifiedWallet || !walletStatus.data?.linked || !consent || !windows.data || subscription.isPending || subscription.isError || !canSubmit(tx.state.phase)}
          onClick={() => void pay()}
        >
          {existing ? 'Approve renewal' : checkout.trialDays > 0 ? 'Start trial' : 'Approve and subscribe'}
        </Button>
        <TransactionStatus state={tx.state} error={tx.error} busy={tx.busy} onSync={() => void tx.sync(target(prepared ?? checkout))} onResume={() => void tx.resume()} />
        {tx.state.phase === 'confirmed-indexing-pending' && !prepared?.paymentId && !checkout.paymentId && checkout.trialDays === 0 && <p className="text-xs text-dim">Your request is confirmed, but the account status is still updating. Do not submit again.</p>}
        <Link to="/portal" className="inline-block text-sm text-cyan underline underline-offset-4">View your account</Link>
      </Card>
    </div>
  )
}

export function CapabilityCheckout({ token, invoice = false }: { token: string; invoice?: boolean }) {
  const query = useQuery({ queryKey: ['public-checkout', invoice, token], queryFn: () => chainApi.checkout(token, invoice), enabled: Boolean(token), retry: false, refetchOnWindowFocus: false })
  if (!token) return <EmptyState title="Missing payment link" description="Use the complete link provided by the merchant." />
  if (query.isPending) return <PageSkeleton />
  if (query.isError) return (
    <Card className="space-y-4 p-6">
      <h1 className="text-xl text-fg">Payment link unavailable</h1>
      <p role="alert" className="text-sm text-dim">This link may have expired or been revoked. No payment was submitted. Ask the merchant for a new link.</p>
      <Button variant="secondary" onClick={() => void query.refetch()}>Try again</Button>
    </Card>
  )
  return <Checkout key={query.data.id} checkout={query.data} token={token} invoice={invoice} />
}

export default function CheckoutPage() {
  const { sessionId = '' } = useParams()
  return <CapabilityCheckout token={sessionId} />
}
