import { ArrowRight, Code2, FileText, Gavel, Landmark, Repeat, ShieldCheck, ShoppingCart, Webhook } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { Reveal, SectionHeading } from './Reveal'

const features = [
  { icon: Repeat, title: 'Recurring USDC billing', body: 'Define plans, trials and intervals. Customers pay in a stable asset, so pricing never drifts.' },
  { icon: Landmark, title: 'Escrow-protected payments', body: 'Hold each payment for a release window you control, then settle to your wallet.' },
  { icon: ShoppingCart, title: 'Hosted checkout and portal', body: 'A clean pay page and a self-serve portal so customers manage their own plans.' },
  { icon: FileText, title: 'Invoices and reconciliation', body: 'Every billing period produces an invoice that maps cleanly to a payment.' },
  { icon: Gavel, title: 'Dispute handling', body: 'Track customer disputes against escrowed funds, with deadlines and clear status.' },
  { icon: Webhook, title: 'API and webhooks', body: 'Drive billing from your own product and react to payment events in real time.' },
]

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading
            eyebrow="Features"
            title="Everything a SaaS needs to bill onchain"
            body="One platform for plans, payments, escrow and reporting, designed around USDC on Arc."
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

const steps = [
  { title: 'Create products and plans', body: 'Set a price in USDC, a billing interval, an optional trial and an escrow window.' },
  { title: 'Share a checkout link', body: 'Send customers to a hosted page, or embed checkout through the API.' },
  { title: 'Customer pays in USDC', body: 'They approve a single wallet payment on Arc. No cards, no chargebacks from banks.' },
  { title: 'Funds settle to you', body: 'After the escrow window closes, payment releases to your payout wallet.' },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-y border-line bg-panel/50 px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading eyebrow="How it works" title="From pricing page to settled revenue" />
        </Reveal>
        <ol className="relative mt-14 grid gap-8 md:grid-cols-4">
          <div className="absolute top-5 right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-transparent via-line-strong to-transparent md:block" />
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.06}>
              <li className="relative">
                <span className="display relative z-10 flex size-10 items-center justify-center rounded-full border border-cyan/40 bg-midnight text-sm font-semibold text-cyan">
                  {i + 1}
                </span>
                <h3 className="display mt-5 text-lg font-semibold text-fg">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-dim">{s.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  )
}

const escrowStages = [
  { label: 'Payment received', note: 'Customer pays USDC', tone: 'bg-electric' },
  { label: 'Held in escrow', note: 'Release window runs', tone: 'bg-cyan' },
  { label: 'Dispute window', note: 'Customer can raise an issue', tone: 'bg-caution' },
  { label: 'Released', note: 'Settles to merchant', tone: 'bg-positive' },
]

export function Security() {
  return (
    <section id="security" className="scroll-mt-20 px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Security and escrow"
            title="Trust is built into the payment flow"
            body="Escrow gives customers confidence to subscribe and gives you predictable settlement. The design keeps custody out of our hands."
          />
          <ul className="mt-8 space-y-5">
            {[
              ['Non-custodial by design', 'Funds move wallet to contract to wallet. RETEMPO never holds your keys.'],
              ['Configurable release windows', 'Pick a hold period per plan, from instant to 30 days.'],
              ['Transparent disputes', 'Every disputed payment is flagged, time-boxed and traceable.'],
            ].map(([t, b]) => (
              <li key={t} className="flex gap-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cyan" />
                <div>
                  <p className="font-medium text-fg">{t}</p>
                  <p className="text-sm text-dim">{b}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-8 rounded-xl border border-line bg-raised/50 px-4 py-3 text-sm text-dim">
            <span className="font-medium text-fg">Where this stands:</span> escrow contracts are in design. None are deployed, and
            any production use would follow an independent audit.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="surface rounded-3xl p-6 sm:p-8">
            <p className="eyebrow">Escrow lifecycle</p>
            <ol className="mt-6 space-y-0">
              {escrowStages.map((s, i) => (
                <li key={s.label} className="relative flex gap-4 pb-8 last:pb-0">
                  {i < escrowStages.length - 1 && <span className="absolute top-6 bottom-0 left-[7px] w-px bg-line-strong" />}
                  <span className={`relative z-10 mt-1.5 size-4 shrink-0 rounded-full ${s.tone} ring-4 ring-panel`} />
                  <div className="flex-1 rounded-xl border border-line bg-midnight/50 px-4 py-3">
                    <p className="text-sm font-medium text-fg">{s.label}</p>
                    <p className="text-xs text-dim">{s.note}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

const sample = `// Planned API shape (illustrative, not yet available)
const session = await retempo.checkout.create({
  plan: 'plan_growth',
  customerEmail: 'billing@example.com',
})

retempo.webhooks.on('payment.released', (event) => {
  grantAccess(event.customerId)
})`

const devPoints = [
  { icon: Code2, title: 'REST API', body: 'Typed resources for plans, customers and invoices.' },
  { icon: Webhook, title: 'Webhooks', body: 'Signed events for payments, escrow and disputes.' },
  { icon: ShieldCheck, title: 'Test mode', body: 'Build against Arc Testnet with no real funds.' },
  { icon: Repeat, title: 'Idempotent writes', body: 'Safe retries across every mutation.' },
]

export function Developers() {
  return (
    <section id="developers" className="scroll-mt-20 border-t border-line bg-panel/50 px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="For developers"
            title="Billing you can drive from code"
            body="An API-first architecture so subscriptions, invoices and escrow events plug straight into your product."
          />
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {devPoints.map((d) => (
              <li key={d.title} className="rounded-xl border border-line bg-midnight/40 p-4">
                <d.icon className="size-5 text-cyan" />
                <p className="mt-3 text-sm font-medium text-fg">{d.title}</p>
                <p className="mt-1 text-xs text-dim">{d.body}</p>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <CodeBlock code={sample} language="typescript" copyable={false} />
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
          <h2 className="display relative text-3xl font-semibold text-fg sm:text-4xl">Start billing in USDC</h2>
          <p className="relative mx-auto mt-4 max-w-lg text-dim">
            Create a merchant workspace on Arc Testnet and explore the dashboard, checkout and customer portal.
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
