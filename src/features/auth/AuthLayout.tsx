import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LockKeyhole, Repeat, ShieldCheck } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'

const points = [
  { icon: Repeat, title: 'Built for recurring billing', body: 'Review subscription, customer portal, and plan-management experiences.' },
  { icon: ShieldCheck, title: 'Verified records only', body: 'Activity appears only when backed by real account and verified payment records.' },
  { icon: LockKeyhole, title: 'Preview by design', body: 'Payment and settlement features are currently unavailable.' },
]

export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="grid min-h-dvh bg-midnight lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-panel lg:block">
        <div className="grid-bg absolute inset-0" />
        <div className="absolute -bottom-40 -left-24 size-[480px] rounded-full bg-electric/15 blur-[120px]" />
        <div className="relative flex h-full flex-col justify-between p-8 xl:p-12">
          <Logo />
          <div className="my-12">
            <p className="eyebrow">Subscription billing preview</p>
            <h2 className="display mt-4 max-w-md text-4xl leading-[1.1] font-semibold text-fg xl:text-5xl">
              Recurring revenue, made clearer.
            </h2>
            <ul className="mt-10 space-y-6">
              {points.map((point) => (
                <li key={point.title} className="flex gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-cyan">
                    <point.icon className="size-5" />
                  </span>
                  <div>
                    <p className="font-medium text-fg">{point.title}</p>
                    <p className="text-sm leading-relaxed text-dim">{point.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-faint">RETEMPO preview · No payment or settlement is processed here.</p>
        </div>
      </aside>
      <main className="flex min-w-0 flex-col px-4 py-5 sm:px-10 sm:py-8">
        <div className="mb-6 lg:hidden">
          <Logo />
        </div>
        <div className={`m-auto w-full ${wide ? 'max-w-xl' : 'max-w-md'} animate-rise`}>{children}</div>
        <p className="mt-8 text-center text-xs text-faint">
          <Link to="/" className="hover:text-dim">Back to retempo.xyz</Link>
        </p>
      </main>
    </div>
  )
}
