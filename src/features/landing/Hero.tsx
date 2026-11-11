import { ArrowRight, CircleDollarSign } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'

function HeroPreview() {
  return (
    <div className="relative mx-auto mt-12 max-w-5xl sm:mt-16">
      <div className="absolute -inset-x-6 -top-8 -bottom-8 -z-10 bg-[radial-gradient(ellipse_50%_50%_at_50%_40%,rgba(59,130,246,0.18),transparent)] sm:-inset-x-10 sm:-top-10 sm:-bottom-10" />
      <div className="surface rounded-2xl p-2.5 shadow-glow sm:rounded-3xl sm:p-4">
        <div className="flex items-center justify-between px-2.5 pt-1 pb-3 sm:px-3">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="size-2 rounded-full bg-white/10 sm:size-2.5" />
            <span className="size-2 rounded-full bg-white/10 sm:size-2.5" />
            <span className="size-2 rounded-full bg-white/10 sm:size-2.5" />
          </div>
          <span className="rounded-full border border-line-strong bg-raised px-2.5 py-1 text-[11px] text-dim sm:text-xs">Preview environment</span>
        </div>
        <div className="rounded-xl border border-line bg-midnight/60 p-4 sm:rounded-2xl sm:p-8">
          <div className="flex items-start gap-3 sm:gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-cyan sm:size-11">
              <CircleDollarSign className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="eyebrow">Billing activity</p>
              <h2 className="display mt-2 text-lg font-semibold text-fg sm:text-xl">No public activity data</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
                This preview starts empty. Business data appears only when it comes from real account records and verified payment activity.
              </p>
            </div>
          </div>
          <div className="mt-5 rounded-xl border border-caution/25 bg-caution/5 p-3 sm:mt-6 sm:p-4">
            <p className="text-sm font-medium text-fg">Payments and settlement are disabled</p>
            <p className="mt-1 text-sm text-dim">No payments or settlements are processed in this preview.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Hero() {
  return (
    <section className="relative overflow-hidden px-4 pt-14 pb-16 sm:px-8 sm:pt-24 sm:pb-24">
      <div className="grid-bg absolute inset-0 -z-10" />
      <div className="mx-auto max-w-4xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-raised/60 px-3.5 py-1.5 text-xs text-dim">
          <span className="size-1.5 rounded-full bg-cyan" />
          Subscription billing preview
        </div>
        <h1 className="display mx-auto mt-6 max-w-4xl text-[2.35rem] leading-[1.06] font-semibold text-fg sm:mt-7 sm:text-6xl lg:text-7xl">
          Subscription billing, made clearer.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-dim sm:mt-6 sm:text-lg">
          Explore a focused preview of recurring billing. Payments and settlement are disabled here; activity appears only when backed by real, verified records.
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:mt-9 sm:flex-row">
          <LinkButton to="/signup" size="lg" className="w-full sm:w-auto">
            Get started <ArrowRight className="size-4" />
          </LinkButton>
          <a
            href="#features"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-line-strong bg-raised px-6 text-base font-medium text-fg transition-all hover:border-electric/50 hover:bg-overlay sm:w-auto"
          >
            Explore features
          </a>
        </div>
      </div>
      <HeroPreview />
    </section>
  )
}
