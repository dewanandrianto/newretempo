import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Coins, LockKeyhole, Repeat } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'

const points = [
  { icon: Coins, title: 'Settle in USDC', body: 'One stable asset for clear pricing and subscription billing.' },
  { icon: LockKeyhole, title: 'Escrow by design', body: 'Hold funds until the release window closes.' },
  { icon: Repeat, title: 'Recurring, programmable', body: 'Subscriptions you can drive from your own product.' },
]

export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="grid min-h-dvh bg-midnight lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-panel lg:block">
        <div className="grid-bg absolute inset-0" />
        <div className="absolute -bottom-40 -left-24 size-[480px] rounded-full bg-electric/15 blur-[120px]" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Logo />
          <div>
            <p className="eyebrow">Subscription billing infrastructure</p>
            <h2 className="display mt-4 max-w-md text-4xl leading-[1.1] font-semibold text-fg">
              Recurring revenue, made simple.
            </h2>
            <ul className="mt-10 space-y-6">
              {points.map((p) => (
                <li key={p.title} className="flex gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-cyan">
                    <p.icon className="size-5" />
                  </span>
                  <div>
                    <p className="font-medium text-fg">{p.title}</p>
                    <p className="text-sm text-dim">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-faint">Preview mode. Payment and settlement features are currently unavailable.</p>
        </div>
      </aside>
      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="mb-8 lg:hidden">
          <Logo />
        </div>
        <div className={`m-auto w-full ${wide ? 'max-w-xl' : 'max-w-md'} animate-rise`}>{children}</div>
        <p className="mt-10 text-center text-xs text-faint">
          <Link to="/" className="hover:text-dim">
            Back to retempo.xyz
          </Link>
        </p>
      </main>
    </div>
  )
}
