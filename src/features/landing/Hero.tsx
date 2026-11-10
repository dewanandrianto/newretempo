import { ArrowRight } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { LinkButton } from '@/components/ui/Button'
import { DemoBadge } from '@/components/ui/Badge'
import { AreaChart } from '@/components/charts/AreaChart'
import { Sparkline } from '@/components/charts/Sparkline'
import { StatusBadge } from '@/components/ui/Badge'

// Illustrative preview values for the hero visual only. Not real activity.
const previewSeries = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'].map((label, i) => ({
  label,
  value: [15100, 16800, 17600, 19400, 21300, 22750][i],
}))

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
          <DemoBadge />
        </div>
        <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <div className="rounded-2xl border border-line bg-midnight/60 p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-dim">Monthly recurring revenue</p>
                <p className="display num mt-1 text-3xl font-semibold text-fg">
                  22,750 <span className="text-sm font-medium text-faint">USDC</span>
                </p>
              </div>
              <span className="num rounded-full border border-positive/25 bg-positive/10 px-2.5 py-0.5 text-xs font-medium text-positive">+6.8%</span>
            </div>
            <AreaChart data={previewSeries} height={190} className="mt-5" formatValue={(v) => `${(v / 1000).toFixed(0)}k`} />
          </div>
          <div className="grid gap-3">
            <div className="rounded-2xl border border-line bg-midnight/60 p-5">
              <div className="flex items-center justify-between text-sm text-dim">
                Escrow balance <TokenUSDC variant="branded" size={20} />
              </div>
              <p className="display num mt-2 text-2xl font-semibold text-fg">3,294.00</p>
              <div className="mt-3 flex items-center justify-between">
                <StatusBadge status="held" />
                <Sparkline values={[3, 4, 3.6, 5, 4.4, 6, 5.5, 7]} width={80} height={28} color="#3B82F6" />
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-midnight/60 p-5">
              <p className="text-sm text-dim">Next renewal</p>
              <div className="mt-2 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-fg">Lumen Robotics</p>
                  <p className="text-xs text-faint">Scale plan</p>
                </div>
                <p className="num text-sm font-medium text-fg">349.00</p>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
                <div className="h-full w-3/4 rounded-full bg-gradient-to-r from-electric to-cyan" />
              </div>
              <p className="mt-2 text-xs text-faint">Renews in 12 days</p>
            </div>
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
          Phase 1 preview · Arc Testnet · USDC
        </div>
        <h1
          className="display animate-rise mt-7 text-[2.6rem] leading-[1.04] font-semibold text-fg sm:text-6xl lg:text-7xl"
          style={{ animationDelay: '0.05s' }}
        >
          Subscription billing that settles in <span className="bg-gradient-to-r from-electric-soft to-cyan bg-clip-text text-transparent">USDC</span>.
        </h1>
        <p className="animate-rise mx-auto mt-6 max-w-2xl text-lg text-dim" style={{ animationDelay: '0.1s' }}>
          RETEMPO is onchain subscription and payment infrastructure for SaaS businesses. Recurring revenue, escrow protection and
          developer APIs, powered by USDC on Arc.
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
