import { ArrowRight, Code2, FileText, Gavel, Landmark, Repeat, ShieldCheck, ShoppingCart, Webhook } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'
import { Reveal, SectionHeading } from './Reveal'

const features = [
  { icon: Repeat, title: 'Subscription management', body: 'Subscription screens use real account records and show an empty state when no records exist.' },
  { icon: Landmark, title: 'Escrow actions paused', body: 'Escrow release and settlement actions are not enabled in this preview.' },
  { icon: ShoppingCart, title: 'Checkout and customer portal', body: 'Review the customer-facing interface without submitting a payment.' },
  { icon: FileText, title: 'Invoices and records', body: 'Invoice details appear only when backed by real account records.' },
  { icon: Gavel, title: 'Disputes unavailable', body: 'Dispute workflows are unavailable while contract actions remain paused.' },
  { icon: Webhook, title: 'Developer integrations', body: 'SDK examples and webhook delivery are not available in this beta.' },
]

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading
            eyebrow="Product preview"
            title="A billing interface for verified payment data"
            body="Explore the product UI without fabricated business records or active payment and settlement flows."
          />
        </Reveal>
        <div className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.04} className="bg-panel p-7 transition-colors hover:bg-raised/80">
              <span className="flex size-11 items-center justify-center rounded-xl border border-line-strong bg-midnight text-cyan">
                <f.icon className="size-5" />
              </span>
              <h3 className="display mt-5 text-lg font-semibold text-fg">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-dim">{f.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

const betaStatus = [
  { title: 'Limited preview', body: 'Wallet connections are restricted to the configured network.' },
  { title: 'Payments paused', body: 'Payment, escrow release, and settlement actions are disabled.' },
  { title: 'Verified records only', body: 'Transaction status appears only when supported by verified chain data.' },
  { title: 'Empty by default', body: 'When no real account or verified chain records exist, the app displays an empty state.' },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-y border-line bg-panel/50 px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading
            eyebrow="Current preview status"
            title="The interface reports only what is verified"
            body="No sample customers, plans, revenue figures, payment records, or fabricated transaction statuses are shown."
          />
        </Reveal>
        <ol className="relative mt-14 grid gap-8 md:grid-cols-4">
          <div className="absolute top-5 right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-transparent via-line-strong to-transparent md:block" />
          {betaStatus.map((item, i) => (
            <Reveal key={item.title} delay={i * 0.06}>
              <li className="relative">
                <span className="display relative z-10 flex size-10 items-center justify-center rounded-full border border-cyan/40 bg-midnight text-sm font-semibold text-cyan">
                  {i + 1}
                </span>
                <h3 className="display mt-5 text-lg font-semibold text-fg">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-dim">{item.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  )
}

const securityPoints = [
  ['Verified status', 'A payment is not marked successful unless its transaction is verified on the configured chain.'],
  ['Paused financial actions', 'Payment, escrow release, and settlement remain disabled in this beta.'],
  ['Preview only', 'Payment and settlement features are currently unavailable.'],
]

export function Security() {
  return (
    <section id="security" className="scroll-mt-20 px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Security and status"
            title="Payment and settlement remain paused"
            body="The interface reports verified payment activity only. If no verified state exists, it shows an empty state instead of sample activity."
          />
          <ul className="mt-8 space-y-5">
            {securityPoints.map(([title, body]) => (
              <li key={title} className="flex gap-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cyan" />
                <div>
                  <p className="font-medium text-fg">{title}</p>
                  <p className="text-sm text-dim">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="surface rounded-3xl p-6 sm:p-8">
            <p className="eyebrow">Current preview</p>
            <h3 className="display mt-3 text-xl font-semibold text-fg">No active payment or escrow activity</h3>
            <p className="mt-3 text-sm leading-relaxed text-dim">
              No payment, settlement, or escrow status is reported unless it comes from a verified payment record. The financial actions remain paused.
            </p>
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-caution/25 bg-caution/5 px-4 py-3 text-sm text-caution">
              <ShieldCheck className="size-4 shrink-0" />
              <span>Preview environment</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

const devPoints = [
  { icon: Code2, title: 'SDK examples', body: 'No SDK examples are published in this beta.' },
  { icon: Webhook, title: 'Webhooks', body: 'No webhook delivery endpoints are available yet.' },
  { icon: ShieldCheck, title: 'Verified state', body: 'Transaction views use verified chain data or an empty state.' },
  { icon: Repeat, title: 'Network settings', body: 'Wallet connections use a restricted configuration.' },
]

export function Developers() {
  return (
    <section id="developers" className="scroll-mt-20 border-t border-line bg-panel/50 px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="For developers"
            title="Developer integrations are not active in this beta"
            body="The public page does not display placeholder API calls or invented customer and plan values."
          />
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {devPoints.map((item) => (
              <li key={item.title} className="rounded-xl border border-line bg-midnight/40 p-4">
                <item.icon className="size-5 text-cyan" />
                <p className="mt-3 text-sm font-medium text-fg">{item.title}</p>
                <p className="mt-1 text-xs text-dim">{item.body}</p>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="surface rounded-3xl p-6 sm:p-8">
            <p className="eyebrow">Integration resources</p>
            <h3 className="display mt-3 text-xl font-semibold text-fg">No published SDK examples</h3>
            <p className="mt-3 text-sm leading-relaxed text-dim">
              API examples and webhook delivery are unavailable in this preview. This panel contains no placeholder business or transaction records.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <Reveal>
        <div className="surface relative mx-auto max-w-4xl overflow-hidden rounded-3xl px-6 py-16 text-center sm:px-12">
          <div className="absolute inset-x-0 -top-24 mx-auto h-48 w-2/3 rounded-full bg-electric/25 blur-[90px]" />
          <h2 className="display relative text-3xl font-semibold text-fg sm:text-4xl">Explore the preview</h2>
          <p className="relative mx-auto mt-4 max-w-lg text-dim">
            Create a workspace to review the interface. Payment and settlement actions remain disabled, and no sample business data is seeded.
          </p>
          <div className="relative mt-8 flex justify-center">
            <LinkButton to="/signup" size="lg">
              Get Started <ArrowRight className="size-4" />
            </LinkButton>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
