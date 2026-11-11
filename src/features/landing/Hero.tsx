import { ArrowRight, CircleDollarSign } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'

function HeroPreview() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl animate-rise" style={{ animationDelay: '0.15s' }}>
      <div className="absolute -inset-x-10 -top-10 -bottom-10 -z-10 bg-[radial-gradient(ellipse_50%_50%_at_50%_40%,rgba(59,130,246,0.18),transparent)]" />
      <div className="surface rounded-3xl p-3 shadow-glow sm:p-4">
        <div className="flex items-center justify-between px-3 pt-1 pb-3">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-white/10" />
            <span className="size-2.5 rounded-full bg-white/10" />
            <span className="size-2.5 rounded-full bg-white/10" />
          </div>
          <span className="rounded-full border border-line-strong bg-raised px-2.5 py-1 text-xs text-dim">
            Preview environment
          </span>
        </div>
        <div className="rounded-2xl border border-line bg-midnight/60 p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-cyan">
              <CircleDollarSign className="size-5" />
            </span>
            <div>
              <p className="eyebrow">Billing activity</p>
              <h2 className="display mt-2 text-xl font-semibold text-fg">No public activity data</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
                This preview starts empty. Business data appears only when it comes from real account records and verified payment activity.
              </p>
            </div>
          </div>
          <div className="mt-6 rounded-xl border border-caution/25 bg-caution/5 p-4">
            <p className="text-sm font-medium text-fg">Payments and settlement are disabled</p>
            <p className="mt-1 text-sm text-dim">Payments and settlements are not processed in this preview.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Hero() {
  return (
    <section className="relative overflow-hidden px-5 pt-20 pb-24 sm:px-8 sm:pt-28">
      <div className="grid-bg absolute inset-0 -z-10" />
      <div className="mx-auto max-w-4xl text-center">
        <div className="animate-rise inline-flex items-center gap-2 rounded-full border border-line-strong bg-raised/60 px-3.5 py-1.5 text-xs text-dim">
          <span className="size-1.5 rounded-full bg-cyan" />
          Billing preview · USDC
        </div>
        <h1
          className="display animate-rise mt-7 text-[2.6rem] leading-[1.04] font-semibold text-fg sm:text-6xl lg:text-7xl"
          style={{ animationDelay: '0.05s' }}
        >
          Explore subscription billing, built for SaaS.
        </h1>
        <p className="animate-rise mx-auto mt-6 max-w-2xl text-lg text-dim" style={{ animationDelay: '0.1s' }}>
          RETEMPO helps SaaS teams manage recurring billing. Payment and settlement actions are currently unavailable; activity appears only when backed by real account records and verified payment data.
        </p>
        <div className="animate-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: '0.15s' }}>
          <LinkButton to="/signup" size="lg" icon={undefined} className="w-full sm:w-auto">
            Get Started <ArrowRight className="size-4" />
          </LinkButton>
          <a
            href="#features"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-line-strong bg-raised px-6 text-base font-medium text-fg transition-all hover:border-electric/50 hover:bg-overlay sm:w-auto"
          >
            Explore Features
          </a>
        </div>
      </div>
      <HeroPreview />
    </section>
  )
}
